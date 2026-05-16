import { getDeployStore, getStore } from "@netlify/blobs";
import type { Store } from "@netlify/blobs";

import type {
  Adapter,
  Body,
  ListResult,
  SignedUpload,
  StoredFile,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from "../index.js";
import { deleteManyWithFallback } from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import type { FilesErrorCode } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface NetlifyBlobsAdapterOptions {
  /**
   * Store name. Required — Netlify Blobs is keyed per store, so the adapter
   * scopes every operation to this name. Max 64 bytes per Netlify's limits.
   */
  name: string;
  /**
   * Netlify site ID. Falls back to `NETLIFY_SITE_ID`. On Netlify Functions /
   * Edge / build runtimes the SDK auto-detects context from
   * `NETLIFY_BLOBS_CONTEXT`, so passing this explicitly is only required when
   * running outside Netlify (local dev without `netlify dev`, your own
   * server, etc.).
   */
  siteID?: string;
  /**
   * Netlify access token. Falls back to `NETLIFY_API_TOKEN` then
   * `NETLIFY_BLOBS_TOKEN`. Same auto-detection rules as `siteID` — only
   * required outside Netlify.
   */
  token?: string;
  /**
   * Use a deploy-scoped store (lifetime of the current deploy) instead of a
   * site-scoped store (persists across deploys). Defaults to `false` —
   * site-scoped is the right choice for almost everything; deploy-scoped is
   * for build artifacts you want garbage-collected with the deploy.
   */
  deployScoped?: boolean;
  /**
   * Read consistency mode. `"eventual"` (default) reads from the edge cache
   * and is faster; `"strong"` reads from the origin and guarantees
   * read-your-writes.
   */
  consistency?: "eventual" | "strong";
}

export type NetlifyBlobsClient = Store;

export type NetlifyBlobsAdapter = Adapter<NetlifyBlobsClient>;

// Internal metadata keys we own. We pack contentType / size / lastModified /
// cacheControl into Netlify's `metadata` map so head() / download() / list()
// can return them — Netlify Blobs has no native size or content-type. User
// metadata round-trips under `user`, namespaced so it never collides with
// our internal fields.
const META_CONTENT_TYPE = "__contentType";
const META_SIZE = "__size";
const META_LAST_MODIFIED = "__lastModified";
const META_CACHE_CONTROL = "__cacheControl";
const META_USER = "__user";

interface PackedMetadata {
  [META_CONTENT_TYPE]?: string;
  [META_SIZE]?: number;
  [META_LAST_MODIFIED]?: number;
  [META_CACHE_CONTROL]?: string;
  [META_USER]?: Record<string, string>;
  [key: string]: unknown;
}

const sizeOf = (body: Body): number | undefined => {
  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof Uint8Array) {
    return body.byteLength;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  if (body instanceof Blob) {
    return body.size;
  }
  return undefined;
};

// `Store.set()` accepts `string | ArrayBuffer | Blob`. Convert everything
// else (Uint8Array, ArrayBufferView, ReadableStream) into one of those.
// Streams are buffered up-front because Netlify's set() doesn't take a
// stream — there's no way to avoid materializing the body.
const bodyToStorable = async (
  body: Body,
  contentType: string | undefined
): Promise<{ data: string | ArrayBuffer | Blob; size: number }> => {
  if (typeof body === "string") {
    return {
      data: body,
      size: new TextEncoder().encode(body).byteLength,
    };
  }
  if (body instanceof Blob) {
    const data =
      contentType && body.type !== contentType
        ? new Blob([body], { type: contentType })
        : body;
    return { data, size: data.size };
  }
  if (body instanceof Uint8Array) {
    // Slice into a fresh ArrayBuffer to avoid handing the SDK a view that
    // covers more than the user's bytes (Uint8Array.buffer can be larger
    // than the view).
    const ab = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength
    ) as ArrayBuffer;
    return { data: ab, size: ab.byteLength };
  }
  if (body instanceof ArrayBuffer) {
    return { data: body, size: body.byteLength };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const ab = view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength
    ) as ArrayBuffer;
    return { data: ab, size: ab.byteLength };
  }
  // ReadableStream — buffer it. Netlify's set() has no streaming form.
  const collected = new Uint8Array(await new Response(body).arrayBuffer());
  const ab = collected.buffer.slice(
    collected.byteOffset,
    collected.byteOffset + collected.byteLength
  ) as ArrayBuffer;
  return { data: ab, size: ab.byteLength };
};

// Netlify throws `BlobsInternalError` whose message embeds the upstream
// status code (e.g. "Netlify Blobs has generated an internal error
// (401 status code, ID: ...)"). Pattern-match on that since the SDK doesn't
// expose a structured status field.
const STATUS_RE = /(\d{3}) status code/u;

const classifyNetlifyError = (
  err: unknown
): { code: FilesErrorCode; message: string } => {
  const e = err as { name?: string; message?: string };
  const message = e?.message ?? "Netlify Blobs error";
  if (e?.name === "MissingBlobsEnvironmentError") {
    return { code: "Provider", message };
  }
  const match = STATUS_RE.exec(message);
  const status = match?.[1] ? Number(match[1]) : undefined;
  if (status === 404) {
    return { code: "NotFound", message };
  }
  if (status === 401 || status === 403) {
    return { code: "Unauthorized", message };
  }
  if (status === 409 || status === 412) {
    return { code: "Conflict", message };
  }
  if (/not found/iu.test(message)) {
    return { code: "NotFound", message };
  }
  if (/unauthor|forbidden/iu.test(message)) {
    return { code: "Unauthorized", message };
  }
  return { code: "Provider", message };
};

const mapNetlifyError = (err: unknown): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  const { code, message } = classifyNetlifyError(err);
  return new FilesError(code, message, err);
};

const unpackUserMetadata = (
  meta: Record<string, unknown> | undefined
): Record<string, string> | undefined => {
  if (!meta) {
    return;
  }
  const user = meta[META_USER];
  if (!user || typeof user !== "object") {
    return;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(user)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const readPackedMetadata = (
  meta: Record<string, unknown> | undefined
): {
  contentType: string;
  size: number;
  lastModified: number | undefined;
  cacheControl: string | undefined;
  userMetadata: Record<string, string> | undefined;
} => {
  const m = (meta ?? {}) as PackedMetadata;
  return {
    cacheControl:
      typeof m[META_CACHE_CONTROL] === "string"
        ? m[META_CACHE_CONTROL]
        : undefined,
    contentType:
      typeof m[META_CONTENT_TYPE] === "string"
        ? m[META_CONTENT_TYPE]
        : "application/octet-stream",
    lastModified:
      typeof m[META_LAST_MODIFIED] === "number"
        ? m[META_LAST_MODIFIED]
        : undefined,
    size: typeof m[META_SIZE] === "number" ? m[META_SIZE] : 0,
    userMetadata: unpackUserMetadata(meta),
  };
};

const buildStoreOptions = (
  opts: NetlifyBlobsAdapterOptions
): {
  name: string;
  consistency?: "eventual" | "strong";
  siteID?: string;
  token?: string;
} => {
  const siteID = opts.siteID ?? readEnv("NETLIFY_SITE_ID");
  const token =
    opts.token ??
    readEnv("NETLIFY_API_TOKEN") ??
    readEnv("NETLIFY_BLOBS_TOKEN");
  // Both must be set together for explicit auth; if one is missing we let
  // the SDK pick up its ambient context (NETLIFY_BLOBS_CONTEXT etc.) and
  // surface its own MissingBlobsEnvironmentError on first call.
  return {
    name: opts.name,
    ...(opts.consistency && { consistency: opts.consistency }),
    ...(siteID && token && { siteID, token }),
  };
};

export const netlifyBlobs = (
  opts: NetlifyBlobsAdapterOptions
): NetlifyBlobsAdapter => {
  if (!opts.name || typeof opts.name !== "string") {
    throw new FilesError(
      "Provider",
      "netlifyBlobs adapter: `name` is required."
    );
  }

  let store: Store;
  try {
    const storeOpts = buildStoreOptions(opts);
    store = opts.deployScoped ? getDeployStore(storeOpts) : getStore(storeOpts);
  } catch (error) {
    throw mapNetlifyError(error);
  }

  const packMetadata = (
    contentType: string,
    size: number,
    uploadOpts?: UploadOptions
  ): PackedMetadata => {
    const meta: PackedMetadata = {
      [META_CONTENT_TYPE]: contentType,
      [META_LAST_MODIFIED]: Date.now(),
      [META_SIZE]: size,
    };
    if (uploadOpts?.cacheControl) {
      meta[META_CACHE_CONTROL] = uploadOpts.cacheControl;
    }
    if (uploadOpts?.metadata) {
      meta[META_USER] = uploadOpts.metadata;
    }
    return meta;
  };

  const adapter: NetlifyBlobsAdapter = {
    async copy(from, to) {
      // No native copy primitive — read the source body + metadata and
      // re-write at the destination. Not server-side atomic; concurrent
      // writes to `from` between the get and put are not detected.
      //
      // Forward the source's packed metadata verbatim so user `metadata`,
      // `contentType`, `size`, and `cacheControl` all round-trip on copy.
      // Refresh `__lastModified` to the time of the copy — the destination
      // is a new write, not a clone of the source's mtime (matches S3
      // server-side copy semantics).
      try {
        const src = await store.getWithMetadata(from, {
          type: "arrayBuffer",
        });
        if (!src) {
          throw new FilesError("NotFound", `netlify-blobs: not found: ${from}`);
        }
        const meta: PackedMetadata = {
          ...src.metadata,
          [META_LAST_MODIFIED]: Date.now(),
        };
        await store.set(to, src.data, { metadata: meta });
      } catch (error) {
        throw mapNetlifyError(error);
      }
    },
    async delete(key) {
      try {
        // Netlify's delete is idempotent — succeeds whether or not the key
        // existed. Matches the unified contract.
        await store.delete(key);
      } catch (error) {
        throw mapNetlifyError(error);
      }
    },
    deleteMany(keys, deleteOpts) {
      return deleteManyWithFallback(
        keys,
        (key) => store.delete(key),
        deleteOpts,
        mapNetlifyError
      );
    },
    async download(key, downloadOpts) {
      try {
        if (downloadOpts?.as === "stream") {
          const result = await store.getWithMetadata(key, { type: "stream" });
          if (!result) {
            throw new FilesError(
              "NotFound",
              `netlify-blobs: not found: ${key}`
            );
          }
          const packed = readPackedMetadata(result.metadata);
          return createStoredFile(
            {
              etag: result.etag,
              key,
              lastModified: packed.lastModified,
              metadata: packed.userMetadata,
              size: packed.size,
              type: packed.contentType,
            },
            {
              factory: () => result.data as ReadableStream<Uint8Array>,
              kind: "stream",
            }
          );
        }
        const result = await store.getWithMetadata(key, {
          type: "arrayBuffer",
        });
        if (!result) {
          throw new FilesError("NotFound", `netlify-blobs: not found: ${key}`);
        }
        const bytes = new Uint8Array(result.data);
        const packed = readPackedMetadata(result.metadata);
        return createStoredFile(
          {
            etag: result.etag,
            key,
            lastModified: packed.lastModified,
            metadata: packed.userMetadata,
            // Prefer the actual byte length over the embedded size — those
            // can disagree if a blob was written outside the SDK.
            size: bytes.byteLength || packed.size,
            type: packed.contentType,
          },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapNetlifyError(error);
      }
    },
    async exists(key) {
      let result: Awaited<ReturnType<Store["getMetadata"]>>;
      try {
        result = await store.getMetadata(key);
      } catch (error) {
        const mapped = mapNetlifyError(error);
        if (mapped.code === "NotFound") {
          return false;
        }
        throw mapped;
      }
      return result !== null;
    },
    async head(key) {
      let result: Awaited<ReturnType<Store["getMetadata"]>>;
      try {
        result = await store.getMetadata(key);
      } catch (error) {
        throw mapNetlifyError(error);
      }
      if (!result) {
        throw new FilesError("NotFound", `netlify-blobs: not found: ${key}`);
      }
      const packed = readPackedMetadata(result.metadata);
      return createStoredFile(
        {
          etag: result.etag,
          key,
          lastModified: packed.lastModified,
          metadata: packed.userMetadata,
          size: packed.size,
          type: packed.contentType,
        },
        {
          factory: async () => {
            const got = await store.get(key, { type: "arrayBuffer" });
            if (!got) {
              throw new FilesError(
                "NotFound",
                `netlify-blobs: not found: ${key}`
              );
            }
            return new Uint8Array(got);
          },
          kind: "lazy",
        }
      );
    },
    async list(options): Promise<ListResult> {
      // Use the paginated iterator so a small `limit` actually bounds
      // server-side I/O — the non-paginated form drains every page
      // internally, which on a large store could cost MBs of network
      // traffic for `limit: 10`. Netlify's pagination cursor is opaque
      // (not exposed on the iterator value), so we still can't thread
      // it through the unified `cursor` API; we just stop iterating
      // when we have enough.
      const limit = options?.limit;
      const blobs: { etag: string; key: string }[] = [];
      const reachedLimit = (): boolean =>
        limit !== undefined && blobs.length >= limit;
      try {
        const iter = store.list({
          paginate: true,
          ...(options?.prefix && { prefix: options.prefix }),
        });
        for await (const page of iter) {
          for (const b of page.blobs) {
            blobs.push(b);
            if (reachedLimit()) {
              break;
            }
          }
          if (reachedLimit()) {
            break;
          }
        }
      } catch (error) {
        throw mapNetlifyError(error);
      }
      const items: StoredFile[] = blobs.map((b) =>
        createStoredFile(
          {
            etag: b.etag,
            key: b.key,
            // Netlify's list response only carries key + etag. Rich metadata
            // (size, contentType, lastModified) requires a per-item head().
            size: 0,
            type: "application/octet-stream",
          },
          {
            factory: async () => {
              const got = await store.get(b.key, { type: "arrayBuffer" });
              if (!got) {
                throw new FilesError(
                  "NotFound",
                  `netlify-blobs: not found: ${b.key}`
                );
              }
              return new Uint8Array(got);
            },
            kind: "lazy",
          }
        )
      );
      return { items };
    },
    name: "netlify-blobs",
    raw: store,
    signedUploadUrl(_key, _opts): Promise<SignedUpload> {
      throw new FilesError(
        "Provider",
        "netlify-blobs: signed upload URLs are not available. Netlify Blobs has no presigned upload primitive — upload via the SDK or proxy through your application."
      );
    },
    async upload(key, body, options): Promise<UploadResult> {
      const contentType = options?.contentType ?? "application/octet-stream";
      let storable: Awaited<ReturnType<typeof bodyToStorable>>;
      try {
        storable = await bodyToStorable(body, options?.contentType);
      } catch (error) {
        throw mapNetlifyError(error);
      }
      // Prefer the locally-known size for known-size bodies; fall back to
      // the buffered length for streams/views.
      const size = sizeOf(body) ?? storable.size;
      const packed = packMetadata(contentType, size, options);
      try {
        const result = await store.set(key, storable.data, {
          metadata: packed,
        });
        return {
          contentType,
          ...(result.etag && { etag: result.etag }),
          key,
          lastModified: packed[META_LAST_MODIFIED] as number,
          size,
        };
      } catch (error) {
        throw mapNetlifyError(error);
      }
    },
    url(_key, _urlOpts?: UrlOptions): Promise<string> {
      throw new FilesError(
        "Provider",
        "netlify-blobs: url() is not supported. Netlify Blobs has no public URL primitive — use download() to read the body via the SDK with the token."
      );
    },
  };

  return adapter;
};
