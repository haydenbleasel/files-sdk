import type { S3Client } from "@aws-sdk/client-s3";
import type {
  R2Bucket,
  R2Object,
  R2ObjectBody,
} from "@cloudflare/workers-types";

import type {
  Adapter,
  Body,
  DownloadOptions,
  SignUploadOptions,
  SignedUpload,
  StoredFile,
  UploadResult,
  UrlOptions,
} from "../index.js";
import {
  DEFAULT_URL_EXPIRES_IN,
  deleteManyWithFallback,
  joinPublicUrl,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";
// Note: the s3 adapter is *not* imported eagerly. The HTTP and hybrid paths
// load it via dynamic import on first use so that a binding-only Worker
// bundle never pulls in @aws-sdk/client-s3 (~500KB+). See
// `loadHttpAdapter` below.
import type { S3Adapter, S3AdapterOptions } from "../s3/index.js";

export interface R2HttpOptions {
  /** R2 bucket name. */
  bucket: string;
  /**
   * Cloudflare account ID. Falls back to `R2_ACCOUNT_ID` env var; required
   * if no env var is set.
   */
  accountId?: string;
  /**
   * R2 access key ID. Falls back to `R2_ACCESS_KEY_ID` env var; required if
   * no env var is set.
   */
  accessKeyId?: string;
  /**
   * R2 secret access key. Falls back to `R2_SECRET_ACCESS_KEY` env var;
   * required if no env var is set.
   */
  secretAccessKey?: string;
  /**
   * Origin used to build URLs from `url()` — typically an `r2.dev`
   * subdomain or a custom domain bound to the bucket. When set, `url()`
   * returns `${publicBaseUrl}/${key}` and skips signing. When unset,
   * `url()` returns a presigned GetObject URL (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for `url()` when `publicBaseUrl` is unset.
   * Defaults to 3600.
   */
  defaultUrlExpiresIn?: number;
}

export interface R2BindingOptions {
  /** Workers `R2Bucket` binding. Reads and writes go through the binding. */
  binding: R2Bucket;
  /** R2 bucket name. Only used to label errors when reading via the binding. */
  bucket?: string;
  /**
   * Origin used to build URLs from `url()` — typically an `r2.dev`
   * subdomain or a custom domain bound to the bucket. Without this (and
   * without HTTP credentials below), `url()` throws because a Workers
   * binding has no signing primitive.
   */
  publicBaseUrl?: string;
  /**
   * Hybrid mode: Cloudflare account ID, used alongside `accessKeyId` +
   * `secretAccessKey` so `url()` and `signedUploadUrl()` can fall back to
   * the S3-compatible HTTP signer instead of throwing. Reads and writes
   * still go through the binding so they stay intra-Worker (no egress
   * fees). Useful for Workers that need browser-facing presigned URLs
   * without giving up the binding's I/O performance.
   */
  accountId?: string;
  /** Hybrid mode: R2 access key ID. See `accountId`. */
  accessKeyId?: string;
  /** Hybrid mode: R2 secret access key. See `accountId`. */
  secretAccessKey?: string;
  /**
   * Default expiry, in seconds, for `url()` when it falls back to HTTP
   * signing (hybrid mode without `publicBaseUrl`). Defaults to 3600.
   */
  defaultUrlExpiresIn?: number;
}

export type R2AdapterOptions = R2BindingOptions | R2HttpOptions;

export type R2Adapter = Adapter<S3Client | R2Bucket>;

// Lazy-load the s3 adapter via dynamic import so a binding-only Worker
// bundle doesn't pull in @aws-sdk/client-s3 (~500KB+ minified). The
// returned function is single-shot: it builds the adapter once on first
// call and returns the same promise on subsequent calls.
const lazyS3 = (config: S3AdapterOptions): (() => Promise<S3Adapter>) => {
  let promise: Promise<S3Adapter> | null = null;
  return () => {
    if (!promise) {
      promise = (async () => {
        const { s3 } = await import("../s3/index.js");
        return s3(config);
      })();
    }
    return promise;
  };
};

const normalizeForR2 = async (
  body: Body,
  contentTypeHint?: string
): Promise<{
  data: ArrayBuffer | ReadableStream<Uint8Array> | string;
  contentType: string;
  contentLength?: number;
}> => {
  if (typeof body === "string") {
    return {
      contentLength: new TextEncoder().encode(body).byteLength,
      contentType: contentTypeHint ?? "text/plain; charset=utf-8",
      data: body,
    };
  }
  if (body instanceof Uint8Array) {
    const buf = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength
    ) as ArrayBuffer;
    return {
      contentLength: buf.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data: buf,
    };
  }
  if (body instanceof ArrayBuffer) {
    return {
      contentLength: body.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data: body,
    };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const buf = view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength
    ) as ArrayBuffer;
    return {
      contentLength: buf.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data: buf,
    };
  }
  if (body instanceof Blob) {
    const buf = await body.arrayBuffer();
    return {
      contentLength: buf.byteLength,
      contentType: contentTypeHint ?? body.type ?? "application/octet-stream",
      data: buf,
    };
  }
  return {
    contentType: contentTypeHint ?? "application/octet-stream",
    data: body,
  };
};

const r2ObjectToStoredFile = (
  obj: R2Object | R2ObjectBody,
  downloadOpts?: DownloadOptions,
  fallbackBody?: () => Promise<Uint8Array>
): StoredFile => {
  const meta = {
    etag: obj.etag,
    key: obj.key,
    lastModified: obj.uploaded.getTime(),
    metadata: obj.customMetadata,
    size: obj.size,
    type: obj.httpMetadata?.contentType ?? "application/octet-stream",
  };
  if ("body" in obj && obj.body) {
    if (downloadOpts?.as === "stream") {
      const stream = obj.body as unknown as ReadableStream<Uint8Array>;
      return createStoredFile(meta, { factory: () => stream, kind: "stream" });
    }
    return createStoredFile(meta, {
      factory: async () => new Uint8Array(await obj.arrayBuffer()),
      kind: "lazy",
    });
  }
  return createStoredFile(meta, {
    factory: fallbackBody ?? (() => Promise.resolve(new Uint8Array())),
    kind: "lazy",
  });
};

// R2 binding errors throw with `name` (string) and `code` (number) fields.
// See https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
// for the published code list. We classify the common ones; unknowns fall
// through to "Provider" so callers can still distinguish failures from success.
const mapR2Error = (err: unknown): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  const e = err as { name?: string; code?: number; message?: string };
  const name = e?.name ?? "";
  const code = e?.code;
  const message =
    e?.message ?? (err instanceof Error ? err.message : String(err));

  if (name.includes("NotFound") || name.includes("NoSuch") || code === 10_002) {
    return new FilesError("NotFound", message, err);
  }
  if (name.includes("Precondition") || code === 10_007) {
    return new FilesError("Conflict", message, err);
  }
  if (
    name.includes("Forbidden") ||
    name.includes("Unauthorized") ||
    code === 10_004 ||
    code === 10_006
  ) {
    return new FilesError("Unauthorized", message, err);
  }
  return new FilesError("Provider", message, err);
};

const r2FromBinding = (opts: R2BindingOptions): R2Adapter => {
  const bucket = opts.binding;
  const { publicBaseUrl } = opts;
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

  // Hybrid mode: when full HTTP creds are passed alongside the binding,
  // build (lazily, once) an inner s3 adapter to handle URL signing. Reads
  // and writes still go through the binding — only the signing surface
  // delegates. The opts object is reused as the cache key so repeated
  // calls share one adapter instance.
  const httpBucket = (opts as Partial<R2HttpOptions>).bucket;
  const hybrid =
    opts.accountId && opts.accessKeyId && opts.secretAccessKey && httpBucket
      ? lazyS3({
          bucket: httpBucket,
          credentials: {
            accessKeyId: opts.accessKeyId,
            secretAccessKey: opts.secretAccessKey,
          },
          defaultProviderMessage: "R2 error",
          ...(opts.defaultUrlExpiresIn !== undefined && {
            defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
          }),
          endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
          forcePathStyle: true,
          region: "auto",
        })
      : null;
  const getSigner = (): Promise<S3Adapter> => {
    if (!hybrid) {
      throw new FilesError(
        "Provider",
        "r2 binding: signing requires either `publicBaseUrl` (for url()) or HTTP credentials (`accountId`, `accessKeyId`, `secretAccessKey`, `bucket`) for presigned URLs. See https://developers.cloudflare.com/r2/api/s3/tokens/."
      );
    }
    return hybrid();
  };

  return {
    async copy(from, to) {
      // R2 bindings have no server-side copy, so this is a read-then-write.
      // Stream the body straight through `put` instead of buffering the whole
      // object — multi-GB copies would otherwise blow past the Worker's
      // memory limit. Source and destination are not atomic; concurrent
      // mutations to `from` between the get and put are not detected.
      let obj: Awaited<ReturnType<typeof bucket.get>>;
      try {
        obj = await bucket.get(from);
      } catch (error) {
        throw mapR2Error(error);
      }
      if (!obj) {
        throw new FilesError("NotFound", `Object not found: ${from}`);
      }
      try {
        await bucket.put(to, obj.body, {
          customMetadata: obj.customMetadata,
          httpMetadata: obj.httpMetadata,
        });
      } catch (error) {
        throw mapR2Error(error);
      }
    },
    async delete(key) {
      try {
        await bucket.delete(key);
      } catch (error) {
        throw mapR2Error(error);
      }
    },
    async download(key, downloadOpts) {
      let obj: Awaited<ReturnType<typeof bucket.get>>;
      try {
        obj = await bucket.get(key);
      } catch (error) {
        throw mapR2Error(error);
      }
      if (!obj) {
        throw new FilesError("NotFound", `Object not found: ${key}`);
      }
      return r2ObjectToStoredFile(obj, downloadOpts);
    },
    async exists(key) {
      // R2's binding `head()` returns null for a missing object on the happy
      // path, but the runtime can also throw on transport-level failures that
      // the mapper classifies as NotFound — handle both.
      try {
        return (await bucket.head(key)) !== null;
      } catch (error) {
        const mapped = mapR2Error(error);
        if (mapped.code === "NotFound") {
          return false;
        }
        throw mapped;
      }
    },
    async head(key) {
      let obj: Awaited<ReturnType<typeof bucket.head>>;
      try {
        obj = await bucket.head(key);
      } catch (error) {
        throw mapR2Error(error);
      }
      if (!obj) {
        throw new FilesError("NotFound", `Object not found: ${key}`);
      }
      return r2ObjectToStoredFile(obj, undefined, async () => {
        const got = await bucket.get(obj.key);
        if (!got) {
          return new Uint8Array();
        }
        return new Uint8Array(await got.arrayBuffer());
      });
    },
    async list(options) {
      let result: Awaited<ReturnType<typeof bucket.list>>;
      try {
        result = await bucket.list({
          ...(options?.prefix && { prefix: options.prefix }),
          ...(options?.limit !== undefined && { limit: options.limit }),
          ...(options?.cursor && { cursor: options.cursor }),
        });
      } catch (error) {
        throw mapR2Error(error);
      }
      const items: StoredFile[] = result.objects.map((obj) =>
        createStoredFile(
          {
            etag: obj.etag,
            key: obj.key,
            lastModified: obj.uploaded.getTime(),
            metadata: obj.customMetadata,
            size: obj.size,
            type: obj.httpMetadata?.contentType ?? "application/octet-stream",
          },
          {
            factory: async () => {
              const got = await bucket.get(obj.key);
              if (!got) {
                return new Uint8Array();
              }
              return new Uint8Array(await got.arrayBuffer());
            },
            kind: "lazy",
          }
        )
      );
      return {
        cursor: result.truncated ? result.cursor : undefined,
        items,
      };
    },
    name: "r2-binding",
    raw: bucket,
    async signedUploadUrl(
      key,
      signOpts: SignUploadOptions
    ): Promise<SignedUpload> {
      const signer = await getSigner();
      return signer.signedUploadUrl(key, signOpts);
    },
    async upload(key, body, options) {
      const { data, contentType, contentLength } = await normalizeForR2(
        body,
        options?.contentType
      );
      try {
        const value = data as Parameters<typeof bucket.put>[1];
        const result = await bucket.put(key, value, {
          httpMetadata: {
            contentType,
            ...(options?.cacheControl && {
              cacheControl: options.cacheControl,
            }),
          },
          ...(options?.metadata && { customMetadata: options.metadata }),
        });
        return {
          contentType,
          etag: result?.etag,
          key,
          lastModified: result?.uploaded?.getTime(),
          size: result?.size ?? contentLength ?? 0,
        } satisfies UploadResult;
      } catch (error) {
        throw mapR2Error(error);
      }
    },
    async url(key, urlOpts: UrlOptions = {}): Promise<string> {
      // `responseContentDisposition` requires signing — bypass the
      // publicBaseUrl path and route through hybrid signing if available.
      // No hybrid? Throw rather than silently dropping the security ask.
      const wantsDisposition = Boolean(urlOpts.responseContentDisposition);
      if (wantsDisposition && !hybrid) {
        throw new FilesError(
          "Provider",
          "r2 binding: `responseContentDisposition` requires signing, which a Workers binding cannot do alone. Pass HTTP credentials (`accountId` + `accessKeyId` + `secretAccessKey` + `bucket`) to enable hybrid signing."
        );
      }
      // Order: explicit `publicBaseUrl` wins (cheapest, no network call) —
      // unless the caller asked for `responseContentDisposition`, which
      // forces signing. After that, hybrid HTTP creds let url() sign.
      // Without either, throw with guidance.
      if (publicBaseUrl && !wantsDisposition) {
        return joinPublicUrl(publicBaseUrl, key);
      }
      if (hybrid) {
        const signer = await getSigner();
        return signer.url(key, {
          expiresIn: urlOpts.expiresIn ?? defaultUrlExpiresIn,
          ...(urlOpts.responseContentDisposition && {
            responseContentDisposition: urlOpts.responseContentDisposition,
          }),
        });
      }
      throw new FilesError(
        "Provider",
        "r2 binding: url() requires either `publicBaseUrl` (e.g. an r2.dev or custom domain bound to the bucket) or HTTP credentials for presigned URLs. See https://developers.cloudflare.com/r2/buckets/public-buckets/."
      );
    },
  };
};

const r2FromHttp = (opts: R2HttpOptions): R2Adapter => {
  const accountId = opts.accountId ?? readEnv("R2_ACCOUNT_ID");
  const accessKeyId = opts.accessKeyId ?? readEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("R2_SECRET_ACCESS_KEY");

  if (!accountId) {
    throw new FilesError(
      "Provider",
      "r2 adapter: missing accountId. Pass `accountId` or set R2_ACCOUNT_ID."
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "r2 adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY."
    );
  }

  // The s3 adapter is loaded lazily via dynamic import — every method on
  // this proxy `await`s the inner instance, and the import is memoized
  // after the first hit. The trade-off vs. a static import: a Worker
  // bundle that imports `files-sdk/r2` but only uses the binding path
  // never includes @aws-sdk/client-s3. The cost is one extra microtask
  // on first call and a `raw` getter that returns `undefined` until the
  // import resolves (call any method first to force the load).
  const getInner = lazyS3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    defaultProviderMessage: "R2 error",
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: "auto",
  });

  let cachedRaw: S3Client | undefined;
  const ensure = async (): Promise<S3Adapter> => {
    const inner = await getInner();
    cachedRaw ??= inner.raw;
    return inner;
  };

  return {
    async copy(from, to) {
      const adapter = await ensure();
      return adapter.copy(from, to);
    },
    async delete(key) {
      const adapter = await ensure();
      return adapter.delete(key);
    },
    async deleteMany(keys, deleteOpts) {
      const adapter = await ensure();
      return (
        adapter.deleteMany?.(keys, deleteOpts) ??
        deleteManyWithFallback(keys, (key) => adapter.delete(key), deleteOpts)
      );
    },
    async download(key, downloadOpts) {
      const adapter = await ensure();
      return adapter.download(key, downloadOpts);
    },
    async exists(key) {
      const adapter = await ensure();
      return adapter.exists(key);
    },
    async head(key) {
      const adapter = await ensure();
      return adapter.head(key);
    },
    async list(listOpts) {
      const adapter = await ensure();
      return adapter.list(listOpts);
    },
    name: "r2-http",
    // `raw` reflects the underlying S3Client once the lazy import has
    // resolved. Returns `undefined` if accessed before any method has
    // run — call any method first (the import is memoized, so it's a
    // one-time cost).
    get raw(): S3Client {
      return cachedRaw as S3Client;
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

export const r2 = (opts: R2AdapterOptions): R2Adapter => {
  if ("binding" in opts && opts.binding) {
    return r2FromBinding(opts);
  }
  return r2FromHttp(opts as R2HttpOptions);
};

// Re-export R2 type so consumers don't need to import workers-types directly.
export type { R2Bucket } from "@cloudflare/workers-types";
