import { getDeployStore, getStore } from "@netlify/blobs";
import type { GetWithMetadataResult, Store } from "@netlify/blobs";

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
import { assertSlashDelimiter } from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import type { FilesErrorCode } from "../internal/errors.js";
import { isNumber, isObject, isString } from "../internal/is.js";
import type { JsonObject } from "../internal/json.js";
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
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

// The metadata block this adapter writes. It is a JSON object (Netlify
// serializes metadata as JSON) so it stays assignable to the SDK's
// dictionary-typed `metadata` option.
interface PackedMetadata extends JsonObject {
  [META_CONTENT_TYPE]: string;
  [META_SIZE]: number;
  [META_LAST_MODIFIED]: number;
  [META_CACHE_CONTROL]?: string;
  [META_USER]?: Record<string, string>;
}

// The metadata block Netlify hands back. The SDK types it as an open
// dictionary — blobs written outside this adapter can carry anything — so
// every field is checked as it is read.
type NetlifyMetadata = GetWithMetadataResult["metadata"];

const sizeOf = (body: Body): number | undefined => {
  if (isString(body)) {
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

interface StorableBody {
  data: string | ArrayBuffer | Blob;
  size: number;
}

// Copy a view's bytes into a fresh, exactly-sized `ArrayBuffer` so the SDK is
// never handed a buffer that covers more than the user's bytes (a view's
// `.buffer` can be larger than the view).
const copyToArrayBuffer = (view: ArrayBufferView): ArrayBuffer => {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
};

// `Store.set()` accepts `string | ArrayBuffer | Blob`. Convert everything
// else (Uint8Array, ArrayBufferView, ReadableStream) into one of those.
// Streams are buffered up-front because Netlify's set() doesn't take a
// stream — there's no way to avoid materializing the body.
const bodyToStorable = async (
  body: Body,
  contentType: string | undefined
): Promise<StorableBody> => {
  if (isString(body)) {
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
    const ab = copyToArrayBuffer(body);
    return { data: ab, size: ab.byteLength };
  }
  if (body instanceof ArrayBuffer) {
    return { data: body, size: body.byteLength };
  }
  if (ArrayBuffer.isView(body)) {
    const ab = copyToArrayBuffer(body);
    return { data: ab, size: ab.byteLength };
  }
  // ReadableStream — buffer it. Netlify's set() has no streaming form.
  // `Response#arrayBuffer` already yields a fresh, exactly-sized buffer.
  const ab = await new Response(body).arrayBuffer();
  return { data: ab, size: ab.byteLength };
};

// Netlify throws `BlobsInternalError` whose message embeds the upstream
// status code (e.g. "Netlify Blobs has generated an internal error
// (401 status code, ID: ...)"). Pattern-match on that since the SDK doesn't
// expose a structured status field.
const STATUS_RE = /(?<status>\d{3}) status code/u;

interface NetlifyErrorClass {
  code: FilesErrorCode;
  message: string;
}

const classifyNetlifyError = (cause: unknown): NetlifyErrorClass => {
  const name =
    isObject(cause) && "name" in cause && isString(cause.name)
      ? cause.name
      : undefined;
  const message =
    isObject(cause) && "message" in cause && isString(cause.message)
      ? cause.message
      : "Netlify Blobs error";
  if (name === "MissingBlobsEnvironmentError") {
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

const mapNetlifyError = (cause: unknown): FilesError => {
  if (cause instanceof FilesError) {
    return cause;
  }
  const { code, message } = classifyNetlifyError(cause);
  return new FilesError(code, message, cause);
};

const unpackUserMetadata = (
  meta: NetlifyMetadata | undefined
): Record<string, string> | undefined => {
  const user = meta?.[META_USER];
  if (!isObject(user)) {
    return;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(user)) {
    if (isString(v)) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

interface UnpackedMetadata {
  contentType: string;
  size: number;
  lastModified: number | undefined;
  cacheControl: string | undefined;
  userMetadata: Record<string, string> | undefined;
}

const readPackedMetadata = (
  meta: NetlifyMetadata | undefined
): UnpackedMetadata => {
  const cacheControl = meta?.[META_CACHE_CONTROL];
  const contentType = meta?.[META_CONTENT_TYPE];
  const lastModified = meta?.[META_LAST_MODIFIED];
  const size = meta?.[META_SIZE];
  return {
    cacheControl: isString(cacheControl) ? cacheControl : undefined,
    contentType: isString(contentType) ? contentType : DEFAULT_CONTENT_TYPE,
    lastModified: isNumber(lastModified) ? lastModified : undefined,
    size: isNumber(size) ? size : 0,
    userMetadata: unpackUserMetadata(meta),
  };
};

interface NetlifyStoreOptions {
  name: string;
  consistency?: "eventual" | "strong";
  siteID?: string;
  token?: string;
}

const buildStoreOptions = (
  opts: NetlifyBlobsAdapterOptions
): NetlifyStoreOptions => {
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
  if (!opts.name || !isString(opts.name)) {
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
        await store.set(to, src.data, {
          metadata: { ...src.metadata, [META_LAST_MODIFIED]: Date.now() },
        });
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
              factory: () => result.data,
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
      if (options?.delimiter) {
        assertSlashDelimiter("netlify-blobs", options.delimiter);
      }
      const limit = options?.limit;
      const blobs: { etag: string; key: string }[] = [];
      // Directories repeat across pages, so collect them in a Set.
      const directories = new Set<string>();
      const reachedLimit = (): boolean =>
        limit !== undefined && blobs.length >= limit;
      try {
        const iter = store.list({
          paginate: true,
          ...(options?.prefix && { prefix: options.prefix }),
          ...(options?.delimiter && { directories: true }),
        });
        for await (const page of iter) {
          // `directories` is only populated when requested via the option.
          for (const d of page.directories ?? []) {
            directories.add(d);
          }
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
            type: DEFAULT_CONTENT_TYPE,
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
      return {
        items,
        ...(directories.size && { prefixes: [...directories] }),
      };
    },
    name: "netlify-blobs",
    raw: store,
    signedUploadUrl(_key, _opts): Promise<SignedUpload> {
      throw new FilesError(
        "Provider",
        "netlify-blobs: signed upload URLs are not available. Netlify Blobs has no presigned upload primitive — upload via the SDK or proxy through your application."
      );
    },
    // Netlify Blobs has no public-URL primitive — `url()` throws.
    signedUrl: { supported: false },
    supportsCacheControl: true,
    supportsDelimiter: true,
    supportsMetadata: true,
    // No native copy — `copy()` reads the source and re-writes the body.
    supportsServerSideCopy: false,
    async upload(key, body, options): Promise<UploadResult> {
      const contentType = options?.contentType ?? DEFAULT_CONTENT_TYPE;
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
          lastModified: packed[META_LAST_MODIFIED],
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
