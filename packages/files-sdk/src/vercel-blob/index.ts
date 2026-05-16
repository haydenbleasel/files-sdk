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
  token?: string;
  /**
   * Whether blobs uploaded by this adapter are public or private.
   *
   * - `"public"` (default): blobs are uploaded with `access: "public"` and
   *   reachable via their CDN URL without authentication. `url()` returns a
   *   permanent public URL.
   * - `"private"`: blobs are uploaded with `access: "private"`. They cannot
   *   be fetched by URL — `download()` and the lazy bodies returned from
   *   `head()` / `list()` instead route through `blob.get(key, { access:
   *   "private" })`, which uses the token. `url()` throws because there is
   *   no permanent public URL for private blobs.
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

const withTimeoutSignal = (
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal | undefined => {
  if (timeoutMs <= 0) {
    return signal;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
};

const fetchWithTimeout = (
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> => {
  const mergedSignal = withTimeoutSignal(signal, timeoutMs);
  return mergedSignal ? fetch(url, { signal: mergedSignal }) : fetch(url);
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

export const vercelBlob = (
  config: VercelBlobAdapterOptions = {}
): VercelBlobAdapter => {
  const token = config.token ?? readEnv("BLOB_READ_WRITE_TOKEN");
  if (!token) {
    throw new FilesError(
      "Provider",
      "vercelBlob adapter: missing token. Pass `token` or set BLOB_READ_WRITE_TOKEN."
    );
  }

  const access = config.access ?? "public";
  const addRandomSuffix = config.addRandomSuffix ?? false;
  const allowOverwrite = config.allowOverwrite ?? true;
  const downloadTimeoutMs =
    config.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;

  // For private blobs the public URL field returned by head()/list() requires
  // authentication to fetch — a plain `fetch(url)` would 401. Route body reads
  // through `blob.get(...)` instead, which uses the token. Returns a stream
  // and a content type; callers can buffer or pipe it.
  const getPrivateBody = async (
    key: string,
    signal?: AbortSignal
  ): Promise<{
    contentType: string | undefined;
    size: number | undefined;
    stream: ReadableStream<Uint8Array>;
  }> => {
    const abortSignal = withTimeoutSignal(signal, downloadTimeoutMs);
    const got = await blob.get(key, {
      access: "private",
      token,
      ...(abortSignal && { abortSignal }),
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

  // BLOB_READ_WRITE_TOKEN format is `vercel_blob_rw_<storeId>_<random>`.
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
  const STORE_ID_RE = /^[A-Za-z0-9]{8,}$/u;
  let storeId: string | undefined;
  if (token.startsWith(TOKEN_PREFIX)) {
    const afterPrefix = token.slice(TOKEN_PREFIX.length);
    const sep = afterPrefix.indexOf("_");
    const candidate = sep === -1 ? afterPrefix : afterPrefix.slice(0, sep);
    if (candidate && STORE_ID_RE.test(candidate)) {
      storeId = candidate;
    }
  }

  const headRaw = async (key: string, signal?: AbortSignal) => {
    try {
      return await blob.head(key, {
        ...(signal && { abortSignal: signal }),
        token,
      });
    } catch (error) {
      throw mapBlobError(error);
    }
  };

  return {
    async copy(from, to, operationOpts) {
      try {
        await blob.copy(from, to, {
          access,
          addRandomSuffix,
          allowOverwrite,
          ...(operationOpts?.signal && {
            abortSignal: operationOpts.signal,
          }),
          token,
        });
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    async delete(key, operationOpts) {
      try {
        await blob.del(key, {
          ...(operationOpts?.signal && {
            abortSignal: operationOpts.signal,
          }),
          token,
        });
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    async download(key, downloadOpts) {
      const result = await headRaw(key, downloadOpts?.signal);
      try {
        const meta = {
          etag: result.etag,
          key: result.pathname,
          lastModified: result.uploadedAt?.getTime(),
          type: result.contentType ?? "application/octet-stream",
        };
        if (access === "private") {
          const got = await getPrivateBody(key, downloadOpts?.signal);
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
        const res = await fetchWithTimeout(
          result.url,
          downloadTimeoutMs,
          downloadOpts?.signal
        );
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
    exists(key, operationOpts) {
      return existsByProbe(
        () => headRaw(key, operationOpts?.signal),
        mapBlobError
      );
    },
    async head(key, operationOpts) {
      const result = await headRaw(key, operationOpts?.signal);
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
          ...(options?.signal && { abortSignal: options.signal }),
          token,
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
          ...(options?.signal && { abortSignal: options.signal }),
          token,
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
            ...(options?.signal && { abortSignal: options.signal }),
            token,
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
      const result = await headRaw(key, urlOpts?.signal);
      if (!result.url) {
        throw new FilesError("Provider", "vercel-blob: missing public URL");
      }
      return result.url;
    },
  };
};
