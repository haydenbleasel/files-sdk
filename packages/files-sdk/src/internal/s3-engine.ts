import type { S3Client } from "@aws-sdk/client-s3";

import type {
  Adapter,
  PartsResumableDriver,
  ResumableUploadSession,
} from "../index.js";
import type { S3Adapter, S3AdapterOptions } from "../s3/core.js";
import { deleteManyWithFallback } from "./core.js";

// Shared plumbing for the S3-compatible adapters that offer both HTTP engines
// (`r2()`, `minio()`): which engine to pick when the caller didn't, and a
// lazily-loaded `@aws-sdk/client-s3` adapter for the `"aws-sdk"` engine that
// keeps the SDK out of Worker bundles running on the `"fetch"` engine.

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
  const g = globalThis as {
    DOMParser?: unknown;
    WebSocketPair?: unknown;
    navigator?: { userAgent?: string };
  };
  const onWorkerd = g.navigator
    ? g.navigator.userAgent === "Cloudflare-Workers"
    : typeof g.WebSocketPair === "function";
  const awsSdkCanParseXml = typeof g.DOMParser === "function";
  return onWorkerd && !awsSdkCanParseXml ? "fetch" : "aws-sdk";
};

// Lazy-load the s3 engine via dynamic imports so a fetch-engine Worker bundle
// doesn't pull in @aws-sdk/client-s3 (~500KB+ minified). This goes through
// the SDK-parameterized ../s3/core.js rather than ../s3/index.js: consumer
// bundlers resolve even dynamically-reached chunks at build time, so the
// entry's *static* `@aws-sdk/*` imports would hard-error against an
// optional-peer placeholder when the SDK isn't installed (#105). Dynamic
// specifiers stay unexecuted on the fetch path, so the placeholder never
// throws. The returned function is single-shot: it builds the adapter once on
// first call and returns the same promise on subsequent calls.
const lazyS3 = (config: S3AdapterOptions): (() => Promise<S3Adapter>) => {
  let promise: Promise<S3Adapter> | null = null;
  // oxlint-disable-next-line react/function-component-definition -- not a React component; the rule misreads this returned thunk as one.
  return () => {
    if (!promise) {
      promise = (async () => {
        const [core, clientS3, presignedPost, requestPresigner] =
          await Promise.all([
            import("../s3/core.js"),
            import("@aws-sdk/client-s3"),
            import("@aws-sdk/s3-presigned-post"),
            import("@aws-sdk/s3-request-presigner"),
          ]);
        return core.createS3Adapter(
          { clientS3, presignedPost, requestPresigner },
          config
        );
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
  name: string
): Adapter<S3Client> => {
  const getInner = lazyS3(config);

  let cachedRaw: S3Client | undefined;
  const ensure = async (): Promise<S3Adapter> => {
    const inner = await getInner();
    cachedRaw ??= inner.raw;
    return inner;
  };

  return {
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
      return cachedRaw as S3Client;
    },
    // `upload` delegates to the underlying S3 adapter, which reports
    // byte-level progress via @aws-sdk/lib-storage when onProgress is set.
    reportsUploadProgress: true,
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
          // The inner S3 adapter always defines `resumableUpload`.
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
    // Upload/list/download all delegate to the inner S3 adapter, which honors
    // `metadata`, `cacheControl`, ListObjectsV2 `Delimiter`, and `Range` —
    // so advertise the same capabilities the eager s3 adapter does. These
    // must be sync, hence hardcoded rather than read off the lazy instance.
    signedUrl: { supported: true },
    supportsCacheControl: true,
    supportsDelimiter: true,
    supportsMetadata: true,
    supportsRange: true,
    // `copy()` delegates to the S3 adapter's server-side CopyObject.
    supportsServerSideCopy: true,
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
