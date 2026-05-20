import * as blob from "@vercel/blob";

import type {
  Adapter,
  Body,
  ListResult,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import { existsByProbe, joinPublicUrl } from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import type { FilesErrorCode } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface VercelBlobAdapterOptions {
  /**
   * Long-lived read-write token. Defaults to `process.env.BLOB_READ_WRITE_TOKEN`.
   *
   * Takes priority over OIDC even when both are present (mirrors the
   * upstream `@vercel/blob` resolution order). For code running on
   * Vercel, prefer leaving this unset and using OIDC instead.
   */
  token?: string;
  /**
   * Vercel OIDC token. Defaults to `process.env.VERCEL_OIDC_TOKEN`, which
   * Vercel populates automatically on every deployment when a Blob store
   * is connected to the project.
   *
   * OIDC tokens are short-lived and auto-rotated, so they remove the risk
   * that a long-lived `BLOB_READ_WRITE_TOKEN` leaks from your codebase
   * or environment. To activate OIDC, **both** `oidcToken` and `storeId`
   * must be available (option or env) and `token` must be unset — that
   * matches the upstream SDK's resolution order.
   *
   * Pass `oidcToken` explicitly when your framework doesn't load
   * `.env.local` into `process.env` automatically (Vite, etc.) — the
   * adapter would otherwise silently fall back to the read-write token.
   */
  oidcToken?: string;
  /**
   * Blob store id, used with OIDC. Defaults to `process.env.BLOB_STORE_ID`.
   * Accepted in either `store_<id>` or `<id>` form (mirrors the SDK).
   *
   * Independently powers the `url()` fast path: when a `storeId` is known
   * (from option, env, or derived from a `vercel_blob_rw_<storeId>_…`
   * token), public URLs are synthesized without a round trip if
   * `addRandomSuffix: false`.
   */
  storeId?: string;
  /**
   * Whether blobs uploaded by this adapter are public or private.
   *
   * - `"public"` (default): blobs are uploaded with `access: "public"` and
   *   reachable via their CDN URL without authentication. `url()` returns a
   *   permanent public URL.
   * - `"private"`: blobs are uploaded with `access: "private"`. They cannot
   *   be fetched by URL — `download()` and the lazy bodies returned from
   *   `head()` / `list()` instead route through `blob.get(key, { access:
   *   "private" })`, which uses whichever credentials the adapter resolved
   *   (read-write token or OIDC). `url()` throws because there is no
   *   permanent public URL for private blobs.
   *
   * The setting is fixed at construction so a single `Files` instance is
   * unambiguously one or the other. If you need both, instantiate two
   * adapters.
   */
  access?: "public" | "private";
  /**
   * Add a random suffix to uploaded keys (Vercel default).
   *
   * When `false`, the resulting pathname matches the key 1:1, which keeps
   * the API consistent with S3/R2 where callers expect to control the key.
   * Defaults to `false`.
   */
  addRandomSuffix?: boolean;
  /**
   * Allow overwriting existing keys on upload. Defaults to `true` so that the
   * "predictable keys" behavior (`addRandomSuffix: false`) actually works —
   * Vercel rejects same-pathname uploads otherwise.
   *
   * **Trade-off:** with the defaults, an `upload(key, ...)` call silently
   * clobbers any existing object at `key`. If keys are derived from
   * untrusted input or your callers expect "create-only" semantics, set
   * `allowOverwrite: false` and handle the resulting Conflict.
   */
  allowOverwrite?: boolean;
  /**
   * Timeout in milliseconds for public-URL fetches issued by `download()`,
   * and by lazy bodies returned from `head()`/`list()`. A hung CDN response
   * would otherwise leak a fetch that never resolves.
   *
   * Defaults to 300_000 (5 minutes). Pass `0` to disable the timeout (not
   * recommended in server contexts — a stuck request will pin a connection
   * until the runtime tears it down).
   */
  downloadTimeoutMs?: number;
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000;

const fetchWithTimeout = (
  url: string,
  timeoutMs: number
): Promise<Response> => {
  if (timeoutMs <= 0) {
    return fetch(url);
  }
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
};

export type VercelBlobClient = typeof blob;

export type VercelBlobAdapter = Adapter<VercelBlobClient>;

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

const parseCacheControlMaxAge = (header: string): number | undefined => {
  const match = /max-age=(\d+)/u.exec(header);
  return match?.[1] ? Number(match[1]) : undefined;
};

// Prefer HTTP status codes (stable contract) over error name substrings
// (e.g. "BlobNotFoundError"), which would silently break if @vercel/blob
// renames its error classes upstream. Name matching is kept as a fallback
// for environments where the underlying fetch error doesn't surface a status.
const classifyBlobError = (
  status: number | undefined,
  name: string
): FilesErrorCode => {
  if (status === 404 || name.includes("NotFound")) {
    return "NotFound";
  }
  if (
    status === 401 ||
    status === 403 ||
    name.includes("Forbidden") ||
    name.includes("Unauthorized")
  ) {
    return "Unauthorized";
  }
  if (status === 409 || status === 412 || name.includes("Precondition")) {
    return "Conflict";
  }
  return "Provider";
};

const DEFAULT_BLOB_MESSAGES: Record<FilesErrorCode, string> = {
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: "vercel-blob error",
  Unauthorized: "Unauthorized",
};

const mapBlobError = (err: unknown): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  const e = err as { name?: string; message?: string; status?: number };
  const code = classifyBlobError(e?.status, e?.name ?? "");
  return new FilesError(code, e?.message ?? DEFAULT_BLOB_MESSAGES[code], err);
};

// `BLOB_READ_WRITE_TOKEN` format is `vercel_blob_rw_<storeId>_<random>`.
// We use the storeId to synthesize public URLs without a round trip when
// the pathname is predictable (i.e. `addRandomSuffix: false`).
//
// Parse defensively: require the exact `vercel_blob_rw_` prefix and a
// segment shaped like a real storeId (alphanumeric, ≥8 chars — real ones
// are ~24). If Vercel ever inserts a version segment (e.g.
// `vercel_blob_rw_v2_<storeId>_<random>`), changes separators, or
// shortens the storeId, the candidate fails the shape check and we fall
// through to `undefined` — `url()` then does a real head() call instead
// of building a URL pointing at the wrong (or someone else's) store.
const TOKEN_PREFIX = "vercel_blob_rw_";
const STORE_ID_PREFIX = "store_";
const STORE_ID_RE = /^[A-Za-z0-9]{8,}$/u;

const deriveStoreIdFromToken = (rwToken: string): string | undefined => {
  if (!rwToken.startsWith(TOKEN_PREFIX)) {
    return undefined;
  }
  const afterPrefix = rwToken.slice(TOKEN_PREFIX.length);
  const sep = afterPrefix.indexOf("_");
  const candidate = sep === -1 ? afterPrefix : afterPrefix.slice(0, sep);
  return candidate && STORE_ID_RE.test(candidate) ? candidate : undefined;
};

// `BLOB_STORE_ID` is documented as accepting either `store_<id>` or
// `<id>` form. The CDN URL uses the bare id, so strip the prefix if
// present before validating shape.
const normalizeExplicitStoreId = (id: string): string | undefined => {
  const candidate = id.startsWith(STORE_ID_PREFIX)
    ? id.slice(STORE_ID_PREFIX.length)
    : id;
  return STORE_ID_RE.test(candidate) ? candidate : undefined;
};

// Credentials passed to every `@vercel/blob` call. Mirrors `BlobCommandOptions`
// (the upstream interface shared across put/get/head/del/copy/list) so a
// single resolved object can be spread into every call site.
interface BlobAuthOptions {
  token?: string;
  oidcToken?: string;
  storeId?: string;
}

export const vercelBlob = (
  opts: VercelBlobAdapterOptions = {}
): VercelBlobAdapter => {
  const explicitToken = opts.token;
  const envToken = readEnv("BLOB_READ_WRITE_TOKEN");
  const oidcToken = opts.oidcToken ?? readEnv("VERCEL_OIDC_TOKEN");
  const explicitStoreId = opts.storeId ?? readEnv("BLOB_STORE_ID");

  // Mirrors the upstream SDK's resolution order:
  //   1. explicit `token` (RW or client token) — wins over OIDC
  //   2. OIDC pair (`oidcToken` + `storeId`, either option or env)
  //   3. `BLOB_READ_WRITE_TOKEN` env
  // Anything else is a construction-time error so OIDC misconfigurations
  // (e.g. only one of the two env vars set) surface immediately rather
  // than silently falling back to anonymous calls.
  const auth: BlobAuthOptions = {};
  if (explicitToken) {
    auth.token = explicitToken;
  } else if (oidcToken && explicitStoreId) {
    auth.oidcToken = oidcToken;
    auth.storeId = explicitStoreId;
  } else if (envToken) {
    auth.token = envToken;
  } else {
    throw new FilesError(
      "Provider",
      "vercelBlob adapter: missing credentials. Pass `token`, or `oidcToken` + `storeId`, or set BLOB_READ_WRITE_TOKEN, or set both VERCEL_OIDC_TOKEN and BLOB_STORE_ID."
    );
  }

  const access = opts.access ?? "public";
  const addRandomSuffix = opts.addRandomSuffix ?? false;
  const allowOverwrite = opts.allowOverwrite ?? true;
  const downloadTimeoutMs =
    opts.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  // For private blobs the public URL field returned by head()/list() requires
  // authentication to fetch — a plain `fetch(url)` would 401. Route body reads
  // through `blob.get(...)` instead, which uses whichever credentials the
  // adapter resolved. Returns a stream and a content type; callers can buffer
  // or pipe it.
  const getPrivateBody = async (
    key: string
  ): Promise<{
    contentType: string | undefined;
    size: number | undefined;
    stream: ReadableStream<Uint8Array>;
  }> => {
    const signal =
      downloadTimeoutMs > 0
        ? AbortSignal.timeout(downloadTimeoutMs)
        : undefined;
    const got = await blob.get(key, {
      access: "private",
      ...auth,
      ...(signal && { abortSignal: signal }),
    });
    if (!got || got.statusCode !== 200) {
      throw new FilesError(
        "NotFound",
        `vercel-blob: private blob not found: ${key}`
      );
    }
    return {
      contentType: got.blob.contentType,
      size: got.blob.size,
      stream: got.stream,
    };
  };

  // Prefer the explicit storeId (option or `BLOB_STORE_ID` env) since it
  // works for OIDC and any future credential shape. Fall back to deriving
  // from a read-write token (the only credential shape that embeds the
  // storeId) so existing setups keep their no-round-trip URL fast path.
  let storeId: string | undefined;
  if (explicitStoreId) {
    storeId = normalizeExplicitStoreId(explicitStoreId);
  }
  if (!storeId) {
    const rwToken = explicitToken ?? envToken;
    if (rwToken) {
      storeId = deriveStoreIdFromToken(rwToken);
    }
  }

  const headRaw = async (key: string) => {
    try {
      return await blob.head(key, { ...auth });
    } catch (error) {
      throw mapBlobError(error);
    }
  };

  return {
    async copy(from, to) {
      try {
        await blob.copy(from, to, {
          access,
          addRandomSuffix,
          allowOverwrite,
          ...auth,
        });
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    async delete(key) {
      try {
        await blob.del(key, { ...auth });
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    async download(key, downloadOpts) {
      const result = await headRaw(key);
      try {
        const meta = {
          etag: result.etag,
          key: result.pathname,
          lastModified: result.uploadedAt?.getTime(),
          type: result.contentType ?? "application/octet-stream",
        };
        if (access === "private") {
          const got = await getPrivateBody(key);
          if (downloadOpts?.as === "stream") {
            return createStoredFile(
              { ...meta, size: result.size },
              { factory: () => got.stream, kind: "stream" }
            );
          }
          const bytes = new Uint8Array(
            await new Response(got.stream).arrayBuffer()
          );
          return createStoredFile(
            { ...meta, size: bytes.byteLength },
            { data: bytes, kind: "buffer" }
          );
        }
        const res = await fetchWithTimeout(result.url, downloadTimeoutMs);
        if (!res.ok) {
          throw new FilesError(
            res.status === 404 ? "NotFound" : "Provider",
            `vercel-blob download failed: ${res.status} ${res.statusText}`
          );
        }
        if (downloadOpts?.as === "stream" && res.body) {
          const stream = res.body;
          return createStoredFile(
            { ...meta, size: result.size },
            { factory: () => stream, kind: "stream" }
          );
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        return createStoredFile(
          { ...meta, size: bytes.byteLength },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    exists(key) {
      return existsByProbe(() => headRaw(key), mapBlobError);
    },
    async head(key) {
      const result = await headRaw(key);
      return createStoredFile(
        {
          etag: result.etag,
          key: result.pathname,
          lastModified: result.uploadedAt?.getTime(),
          size: result.size,
          type: result.contentType ?? "application/octet-stream",
        },
        {
          factory: async () => {
            if (access === "private") {
              const got = await getPrivateBody(key);
              return new Uint8Array(
                await new Response(got.stream).arrayBuffer()
              );
            }
            const res = await fetchWithTimeout(result.url, downloadTimeoutMs);
            return new Uint8Array(await res.arrayBuffer());
          },
          kind: "lazy",
        }
      );
    },
    async list(options): Promise<ListResult> {
      try {
        const result = await blob.list({
          ...auth,
          ...(options?.prefix && { prefix: options.prefix }),
          ...(options?.limit !== undefined && { limit: options.limit }),
          ...(options?.cursor && { cursor: options.cursor }),
        });
        const items: StoredFile[] = result.blobs.map((b) =>
          createStoredFile(
            {
              etag: b.etag,
              key: b.pathname,
              lastModified: b.uploadedAt?.getTime(),
              size: b.size,
              type: "application/octet-stream",
            },
            {
              factory: async () => {
                if (access === "private") {
                  const got = await getPrivateBody(b.pathname);
                  return new Uint8Array(
                    await new Response(got.stream).arrayBuffer()
                  );
                }
                const res = await fetchWithTimeout(b.url, downloadTimeoutMs);
                return new Uint8Array(await res.arrayBuffer());
              },
              kind: "lazy",
            }
          )
        );
        return {
          cursor: result.hasMore ? result.cursor : undefined,
          items,
        };
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    name: "vercel-blob",
    raw: blob,
    signedUploadUrl(_key, _opts): Promise<SignedUpload> {
      throw new FilesError(
        "Provider",
        "vercel-blob: signed upload URLs are not available. Use Vercel's `handleUpload()` route handler with the `@vercel/blob/client` package for browser uploads."
      );
    },
    async upload(key, body, options) {
      try {
        const result = await blob.put(key, body as Blob | string, {
          access,
          addRandomSuffix,
          allowOverwrite,
          ...auth,
          ...(options?.contentType && { contentType: options.contentType }),
          ...(options?.cacheControl && {
            cacheControlMaxAge: parseCacheControlMaxAge(options.cacheControl),
          }),
        });
        // Vercel's PutBlobResult has no size; for stream bodies we can't compute
        // it locally, so fall back to a follow-up head() to get the authoritative
        // size (and lastModified). For known-size bodies, skip the extra round trip.
        const localSize = sizeOf(body);
        let size = localSize;
        let lastModified = Date.now();
        if (size === undefined) {
          const { size: headSize, uploadedAt } = await blob.head(result.url, {
            ...auth,
          });
          size = headSize;
          lastModified = uploadedAt?.getTime() ?? lastModified;
        }
        return {
          contentType:
            result.contentType ??
            options?.contentType ??
            "application/octet-stream",
          etag: result.etag,
          key: result.pathname,
          lastModified,
          size,
        } satisfies UploadResult;
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    async url(key, urlOpts) {
      // `urlOpts.expiresIn` is intentionally ignored: Vercel Blob has no
      // signing primitive, so the public CDN URL is the only thing we can
      // return — and it doesn't expire. Documented on `UrlOptions`.
      //
      // `responseContentDisposition` is a different story — it's a
      // security knob (force download for user-uploaded HTML/SVG to
      // prevent stored XSS). Silently dropping it would be a regression,
      // so we throw if it's passed. There's no Vercel Blob primitive for
      // overriding Content-Disposition on a public CDN URL.
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "vercel-blob: `responseContentDisposition` is not supported. Vercel Blob has no signing primitive, so the Content-Disposition override that prevents stored XSS on user-uploaded HTML/SVG cannot be applied. Use a different provider for buckets with untrusted content."
        );
      }
      // Private blobs have no permanent public URL — the `url` field
      // returned by head()/list() requires authentication to fetch. Returning
      // it from `url()` would silently violate the documented "permanent
      // public URL" contract; callers would hand out URLs that always 401.
      if (access === "private") {
        throw new FilesError(
          "Provider",
          "vercel-blob: url() is not supported for private blobs. Use `download()` to read the body via the SDK with the token."
        );
      }
      // Fast path: with a known storeId and predictable keys, derive the
      // URL without an API call. `addRandomSuffix: true` makes the actual
      // pathname unknowable in advance, so we have to head() in that case.
      if (storeId && !addRandomSuffix) {
        return joinPublicUrl(
          `https://${storeId}.public.blob.vercel-storage.com`,
          key
        );
      }
      const result = await headRaw(key);
      if (!result.url) {
        throw new FilesError("Provider", "vercel-blob: missing public URL");
      }
      return result.url;
    },
  };
};
