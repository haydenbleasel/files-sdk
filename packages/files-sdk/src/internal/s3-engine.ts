import type { S3Client } from "@aws-sdk/client-s3";

import type {
  Adapter,
  PartsResumableDriver,
  ResumableUploadSession,
} from "../index.js";
import type { S3Adapter, S3AdapterOptions, S3Sdk } from "../s3/core.js";
import { SIGV4_MAX_EXPIRES_IN } from "../s3/shared.js";
import { deleteManyWithFallback } from "./core.js";
import { FilesError } from "./errors.js";
import type { EventCapability } from "./events.js";
import { isFunction } from "./is.js";

// Shared plumbing for the S3-compatible adapters that offer both HTTP engines
// (`r2()`, `minio()`, `rustfs()`): which engine to pick when the caller
// didn't, and a lazily-loaded `@aws-sdk/client-s3` adapter for the `"aws-sdk"`
// engine that keeps the SDK out of Worker bundles running on the `"fetch"`
// engine.

export type S3Engine = "aws-sdk" | "fetch";

/**
 * Resolve the HTTP engine. An explicit choice always wins. Otherwise the
 * `"aws-sdk"` engine is the default — except on Cloudflare Workers, where it
 * is not workerd-compatible out of the box: the AWS SDK's client-s3
 * browser-targeted bundle resolves xml-builder's *browser* XML
 * parser, which needs `DOMParser` — undefined in workerd. Every S3 XML parse
 * (list, error bodies) then throws `DOMParser is not defined` at runtime, long
 * after adapter construction. Default to the fetch engine there instead.
 *
 * `navigator.userAgent === "Cloudflare-Workers"` is the documented workerd
 * check. `navigator` is absent on compatibility dates before 2022-03-21 or
 * under the `no_global_navigator` flag; only *then* fall back to the
 * workerd-only `WebSocketPair` global — Node-hosted Workers shims (Miniflare
 * v2, jest-environment-miniflare) also define it, and `navigator` is the
 * signal that tells them apart from the real thing.
 *
 * A `DOMParser` on the global is the one precondition the aws-sdk engine
 * needs, and the standard workaround for this bug is to polyfill exactly that
 * (linkedom, @xmldom/xmldom). Keep those deployments on the full engine —
 * swapping them to fetch would silently drop multipart/resumable uploads,
 * batched deletes, and `raw` as an `S3Client`.
 */
export const resolveS3Engine = (explicit?: S3Engine): S3Engine => {
  if (explicit) {
    return explicit;
  }
  // SAFETY: the host global's members depend on the runtime, which the
  // static `typeof globalThis` cannot know; this view declares the three
  // probed globals as optional so each read below is a checked existence
  // probe, never an assumption that they are present.
  const g = globalThis as {
    DOMParser?: unknown;
    WebSocketPair?: unknown;
    navigator?: { userAgent?: string };
  };
  const onWorkerd = g.navigator
    ? g.navigator.userAgent === "Cloudflare-Workers"
    : isFunction(g.WebSocketPair);
  const awsSdkCanParseXml = isFunction(g.DOMParser);
  return onWorkerd && !awsSdkCanParseXml ? "fetch" : "aws-sdk";
};

/**
 * Load the `@aws-sdk/*` modules behind the `"aws-sdk"` engine.
 *
 * Each `import()` is awaited directly inside the `try`, and that shape is
 * load-bearing. Consumer bundlers resolve literal `import()` specifiers at
 * build time, so an unhandled `import("@aws-sdk/client-s3")` fails a Worker
 * build (`Could not resolve "@aws-sdk/client-s3"` from Wrangler's esbuild)
 * when the optional peers aren't installed, even though the binding and fetch
 * engines never run it. An import awaited inside a `try` is one whose failure
 * the code handles at run time: esbuild, Bun, and rolldown leave it unresolved
 * without an error, and webpack downgrades it to a warning. When the peers
 * *are* installed, every bundler still resolves and bundles them as before.
 * Moving an import out of the `try`, into a `Promise.all`, or into a default
 * parameter brings the build error back (`test/build-output.test.ts`).
 *
 * A missing peer doesn't always reject, though: Next.js's webpack resolves an
 * uninstalled optional peer to an empty module, so the import succeeds and the
 * first `new S3Client()` would fail with a bare "is not a constructor". Check
 * the loaded exports so both cases end in the same install hint.
 *
 * `permanent`: a missing module fails every attempt the same way, so
 * `retries` must not re-run the call. The importer is injectable only so the
 * missing-peer paths are testable.
 */
export const loadS3Sdk = async (
  name: string,
  importSdk?: () => Promise<S3Sdk>
): Promise<S3Sdk> => {
  const missingPeers = (cause?: unknown) =>
    new FilesError(
      "Unsupported",
      `${name} adapter: client "aws-sdk" requires the optional peer dependencies @aws-sdk/client-s3, @aws-sdk/s3-presigned-post, and @aws-sdk/s3-request-presigner. Install them, or pass client: "fetch", which needs no @aws-sdk/* package.`,
      cause
    );
  let sdk: S3Sdk;
  try {
    sdk = importSdk
      ? await importSdk()
      : {
          clientS3: await import("@aws-sdk/client-s3"),
          presignedPost: await import("@aws-sdk/s3-presigned-post"),
          requestPresigner: await import("@aws-sdk/s3-request-presigner"),
        };
  } catch (error) {
    throw missingPeers(error);
  }
  const loaded =
    isFunction(sdk.clientS3.S3Client) &&
    isFunction(sdk.presignedPost.createPresignedPost) &&
    isFunction(sdk.requestPresigner.getSignedUrl);
  if (!loaded) {
    throw missingPeers();
  }
  return sdk;
};

// Lazy-load the s3 engine via dynamic imports so a fetch-engine Worker bundle
// doesn't pull in @aws-sdk/client-s3 (~500KB+ minified). This goes through
// the SDK-parameterized ../s3/core.js rather than ../s3/index.js: consumer
// bundlers resolve even dynamically-reached chunks at build time, so the
// entry's *static* `@aws-sdk/*` imports would hard-error against an
// optional-peer placeholder when the SDK isn't installed (#105). The SDK
// itself loads through `loadS3Sdk`, whose run-time-handled imports keep a
// build without the peers from failing. The returned function is single-shot:
// it builds the adapter once on first call and returns the same promise on
// subsequent calls.
const lazyS3 = (
  config: S3AdapterOptions,
  name: string
): (() => Promise<S3Adapter>) => {
  let promise: Promise<S3Adapter> | null = null;
  // oxlint-disable-next-line react/function-component-definition -- not a React component; the rule misreads this returned thunk as one.
  return () => {
    if (!promise) {
      promise = (async () => {
        const [core, sdk] = await Promise.all([
          import("../s3/core.js"),
          loadS3Sdk(name),
        ]);
        return core.createS3Adapter(sdk, config);
      })();
    }
    return promise;
  };
};

/**
 * An `Adapter<S3Client>` whose every method `await`s a lazily-imported s3
 * adapter (memoized after the first hit). The trade-off vs. a static import:
 * a bundle that imports the entry but runs on the fetch engine never includes
 * the AWS SDK's client-s3. The cost is one extra microtask on first call and a
 * `raw` getter that returns `undefined` until the import resolves (call any
 * method first to force the load).
 */
export const lazyS3Adapter = (
  config: S3AdapterOptions,
  name: string,
  events: EventCapability | false = false
): Adapter<S3Client> & { readonly bucket: string } => {
  const getInner = lazyS3(config, name);

  let cachedRaw: S3Client | undefined;
  const ensure = async (): Promise<S3Adapter> => {
    const inner = await getInner();
    cachedRaw ??= inner.raw;
    return inner;
  };

  return {
    // Exposed like the eager s3 adapter's, so `files-sdk/events` can filter
    // other buckets' notifications by default.
    bucket: config.bucket,
    // Upload/list/download all delegate to the inner S3 adapter, which honors
    // `metadata`, `cacheControl`, ListObjectsV2 `Delimiter`, and `Range` —
    // so advertise the same capabilities the eager s3 adapter does (including
    // the SigV4 one-week presign ceiling). This must be sync, hence hardcoded
    // rather than read off the lazy instance; keep it identical to the
    // declaration in `createS3Adapter`.
    capabilities: {
      cacheControl: true,
      delimiter: "any",
      // Always a custom endpoint (R2, MinIO, RustFS), so no notification
      // format is assumed; the wrapper passes the one its provider sends.
      events,
      metadata: true,
      publicUrl: Boolean(config.publicBaseUrl),
      rangeRead: true,
      // `copy()` delegates to the S3 adapter's server-side CopyObject.
      serverSideCopy: true,
      signedUpload: {
        contentType: true,
        maxExpiresIn: SIGV4_MAX_EXPIRES_IN,
        maxSize: true,
        supported: true,
      },
      signedUrl: {
        disposition: true,
        expiry: "exact",
        maxExpiresIn: SIGV4_MAX_EXPIRES_IN,
        supported: true,
      },
      // `upload` delegates to the underlying S3 adapter, which reports
      // byte-level progress via @aws-sdk/lib-storage when onProgress is set.
      uploadProgress: true,
    },
    async copy(from, to, operationOpts) {
      const adapter = await ensure();
      return adapter.copy(from, to, operationOpts);
    },
    async delete(key, operationOpts) {
      const adapter = await ensure();
      return adapter.delete(key, operationOpts);
    },
    async deleteMany(keys, deleteOpts) {
      const adapter = await ensure();
      // The s3 engine always implements `deleteMany` (batched DeleteObjects);
      // the fallback only satisfies the optional type.
      return (
        adapter.deleteMany?.(keys, deleteOpts) ??
        deleteManyWithFallback(keys, adapter.delete.bind(adapter), deleteOpts)
      );
    },
    async download(key, downloadOpts) {
      const adapter = await ensure();
      return adapter.download(key, downloadOpts);
    },
    async exists(key, operationOpts) {
      const adapter = await ensure();
      return adapter.exists(key, operationOpts);
    },
    async head(key, operationOpts) {
      const adapter = await ensure();
      return adapter.head(key, operationOpts);
    },
    async list(listOpts) {
      const adapter = await ensure();
      return adapter.list(listOpts);
    },
    name,
    // `raw` reflects the underlying S3Client once the lazy import has
    // resolved. Returns `undefined` if accessed before any method has
    // run — call any method first (the import is memoized, so it's a
    // one-time cost).
    get raw(): S3Client {
      // SAFETY: `Adapter<S3Client>` declares `raw` non-optional; the
      // pre-load `undefined` is the documented exception above, not a
      // second value type — once any method has run, `ensure` has cached
      // the inner adapter's `S3Client` here.
      return cachedRaw as S3Client;
    },
    // Resumable uploads delegate to the inner S3 driver. The driver must be
    // returned synchronously, but the S3 adapter loads lazily — so wrap it:
    // each async method awaits the (memoized) inner driver, and the sync
    // `adopt` just stashes the token for the first async call to apply.
    resumableUpload(key, resumableOpts): PartsResumableDriver {
      let inner: PartsResumableDriver | undefined;
      let stored: ResumableUploadSession | undefined;
      let partSize = 5 * 1024 * 1024;
      const build = async (): Promise<PartsResumableDriver> => {
        if (!inner) {
          const adapter = await ensure();
          // SAFETY: `createS3Adapter` always defines `resumableUpload` and
          // always returns a `"parts"`-mode driver (S3 multipart); the
          // `Adapter` type leaves the method optional and the driver mode
          // open only for the adapters that lack it.
          inner = (
            adapter.resumableUpload as NonNullable<
              typeof adapter.resumableUpload
            >
          )(key, resumableOpts) as PartsResumableDriver;
          if (stored) {
            inner.adopt(stored);
          }
          ({ partSize } = inner);
        }
        return inner;
      };
      return {
        adopt(session) {
          stored = session;
          if (session.provider === "s3") {
            ({ partSize } = session);
          }
        },
        begin: async (meta) => {
          const driver = await build();
          return driver.begin(meta);
        },
        complete: async (parts) => {
          const driver = await build();
          return driver.complete(parts);
        },
        discard: async () => {
          if (inner || stored) {
            const driver = await build();
            await driver.discard();
          }
        },
        mode: "parts",
        get partSize() {
          return inner?.partSize ?? partSize;
        },
        probe: async () => {
          const driver = await build();
          return driver.probe();
        },
        uploadPart: async (part) => {
          const driver = await build();
          return driver.uploadPart(part);
        },
      };
    },
    async signedUploadUrl(key, signOpts) {
      const adapter = await ensure();
      return adapter.signedUploadUrl(key, signOpts);
    },
    async upload(key, body, uploadOpts) {
      const adapter = await ensure();
      return adapter.upload(key, body, uploadOpts);
    },
    async url(key, urlOpts) {
      const adapter = await ensure();
      return adapter.url(key, urlOpts);
    },
  };
};
