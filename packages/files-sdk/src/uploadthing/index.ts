import { UTApi, UTFile } from "uploadthing/server";

import type {
  Adapter,
  Body,
  ListResult,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  assertRangeHonored,
  DEFAULT_URL_EXPIRES_IN,
  deleteManyWithFallback,
  existsByProbe,
  rangeRequestHeaders,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import type { FilesErrorCode } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface UploadThingAdapterOptions {
  /**
   * UploadThing token. Falls back to `process.env.UPLOADTHING_TOKEN`.
   *
   * Tokens are base64-encoded JSON of the form
   * `{ apiKey, appId, regions: string[] }` — the adapter decodes them at
   * construction time so it can compute the public CDN host
   * (`{appId}.ufs.sh`) and sign UFS presigned PUT URLs without an API
   * round-trip. A token that doesn't decode to that shape throws
   * immediately rather than failing later on the first call.
   */
  token?: string;
  /**
   * ACL applied to uploads. Drives both the upload-time ACL and `url()`
   * behavior — `"public-read"` returns the permanent CDN URL, `"private"`
   * mints a short-lived signed URL via `generateSignedURL`. Defaults to
   * `"public-read"`, which matches UploadThing's most common use case.
   *
   * Fixed at construction so a single `Files` instance is unambiguously
   * one or the other. If you need both, instantiate two adapters.
   */
  acl?: "public-read" | "private";
  /**
   * UploadThing file-router slug. Required only by `signedUploadUrl()`,
   * which embeds it as `x-ut-slug` on the ingest URL — UploadThing
   * validates the upload against the route's config (allowed file
   * types/sizes). Server-side `upload()` does not need it.
   */
  slug?: string;
  /**
   * Default expiry (seconds) for signed download URLs and for `url()`
   * when `acl` is `"private"`. UploadThing caps signed URLs at 7 days.
   * Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
  /**
   * Timeout in milliseconds for the HEAD/GET fallbacks that `head()`,
   * `download()`, and lazy bodies returned from `list()` issue against
   * the file URL. A hung CDN response would otherwise leak a fetch that
   * never resolves. Defaults to 300_000 (5 minutes). Pass `0` to
   * disable.
   */
  downloadTimeoutMs?: number;
  /**
   * Override the region alias used to construct the ingest URL for
   * `signedUploadUrl()`. Defaults to the first region in the decoded
   * token, or `"sea1"` if none is present.
   */
  region?: string;
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000;
const DEFAULT_REGION = "sea1";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const ACL_PUBLIC_READ = "public-read" as const;

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
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> => {
  const signal = withTimeoutSignal(init?.signal ?? undefined, timeoutMs);
  return signal ? fetch(url, { ...init, signal }) : fetch(url, init);
};

export type UploadThingClient = UTApi;
export type UploadThingAdapter = Adapter<UploadThingClient>;

interface DecodedToken {
  apiKey: string;
  appId: string;
  regions?: string[];
}

const decodeToken = (token: string): DecodedToken => {
  let json: string;
  try {
    // Browser-safe base64 decode; works in Node 16+ and Workers.
    json =
      typeof atob === "function"
        ? atob(token)
        : // oxlint-disable-next-line @typescript-oxlint/no-explicit-any
          (globalThis as any).Buffer.from(token, "base64").toString("utf-8");
  } catch (error) {
    throw new FilesError(
      "Provider",
      "uploadthing: UPLOADTHING_TOKEN is not valid base64",
      error
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new FilesError(
      "Provider",
      "uploadthing: UPLOADTHING_TOKEN does not decode to JSON",
      error
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as DecodedToken).apiKey !== "string" ||
    typeof (parsed as DecodedToken).appId !== "string"
  ) {
    throw new FilesError(
      "Provider",
      "uploadthing: UPLOADTHING_TOKEN missing apiKey or appId"
    );
  }
  return parsed as DecodedToken;
};

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

const bodyToBlob = async (
  body: Body,
  contentType: string | undefined
): Promise<Blob> => {
  const type = contentType ?? DEFAULT_CONTENT_TYPE;
  if (body instanceof Blob) {
    return contentType && body.type !== contentType
      ? new Blob([body], { type })
      : body;
  }
  if (typeof body === "string") {
    return new Blob([body], { type });
  }
  if (body instanceof Uint8Array) {
    return new Blob([body as BlobPart], { type });
  }
  if (body instanceof ArrayBuffer) {
    return new Blob([body], { type });
  }
  if (ArrayBuffer.isView(body)) {
    // Copy the view's bytes into a fresh Uint8Array so we don't accidentally
    // include unrelated bytes from the underlying ArrayBuffer.
    const view = body as ArrayBufferView;
    const bytes = new Uint8Array(
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
    );
    return new Blob([bytes as BlobPart], { type });
  }
  // ReadableStream — drain into a single buffer. UploadThing's uploadFiles
  // requires a Blob, so streaming uploads aren't possible without buffering.
  const collected = new Uint8Array(await new Response(body).arrayBuffer());
  return new Blob([collected as BlobPart], { type });
};

const basename = (key: string): string => {
  const idx = key.lastIndexOf("/");
  return idx === -1 ? key : key.slice(idx + 1);
};

// HTTP status takes precedence over message substrings — the status is the
// stable contract; UploadThingError messages can change between versions.
const classifyUploadThingError = (
  status: number | undefined,
  message: string,
  code: string | undefined
): FilesErrorCode => {
  if (status === 404 || code === "NOT_FOUND" || /not found/iu.test(message)) {
    return "NotFound";
  }
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- flat OR of the equivalent 401/403 status + error-code + message signals; splitting hurts readability.
    status === 401 ||
    status === 403 ||
    code === "FORBIDDEN" ||
    code === "UNAUTHORIZED" ||
    /unauthor|forbidden/iu.test(message)
  ) {
    return "Unauthorized";
  }
  if (status === 409 || /already exists|conflict/iu.test(message)) {
    return "Conflict";
  }
  return "Provider";
};

const mapUploadThingError = (err: unknown): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  const e = err as {
    name?: string;
    message?: string;
    status?: number;
    code?: string;
  };
  const code = classifyUploadThingError(e?.status, e?.message ?? "", e?.code);
  return new FilesError(code, e?.message ?? `uploadthing error (${code})`, err);
};

const hex = (bytes: Uint8Array): string => {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
};

// HMAC-SHA256(url, apiKey) → hex. Uses Web Crypto so the adapter works in
// every modern runtime (Node 18+, Workers, Bun, Deno) without pulling in
// `node:crypto`.
const hmacSha256Hex = async (
  message: string,
  secret: string
): Promise<string> => {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return hex(new Uint8Array(sig));
};

// File-key seed for UFS presigned PUTs. UploadThing's own scheme encodes
// the appId via Sqids; we don't strictly need that to be reversible because
// we set `x-ut-custom-id` to the user's key — every subsequent operation
// routes by customId, never by the synthesized fileKey. So a random
// 32-char alphanumeric is sufficient. (If callers want UploadThing-native
// keys, they can use the file-router pattern via `raw`.)
const randomFileKey = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (const b of bytes) {
    out += chars[b % chars.length];
  }
  return out;
};

export const uploadthing = (
  config: UploadThingAdapterOptions = {}
): UploadThingAdapter => {
  const token = config.token ?? readEnv("UPLOADTHING_TOKEN");
  if (!token) {
    throw new FilesError(
      "Provider",
      "uploadthing adapter: missing token. Pass `token` or set UPLOADTHING_TOKEN."
    );
  }
  const decoded = decodeToken(token);
  const { apiKey, appId } = decoded;
  const region = config.region ?? decoded.regions?.[0] ?? DEFAULT_REGION;
  const acl = config.acl ?? ACL_PUBLIC_READ;
  const downloadTimeoutMs =
    config.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const defaultExpiresIn = config.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

  // `defaultKeyType: "customId"` makes deleteFiles / generateSignedURL /
  // updateACL route by the user's key (passed as customId on upload)
  // instead of UploadThing's auto-generated fileKey.
  const utapi = new UTApi({
    defaultKeyType: "customId",
    token,
  });

  const publicUrl = (key: string): string =>
    `https://${appId}.ufs.sh/f/${encodeURIComponent(key)}`;

  // Resolve the URL we'd fetch for a given key, honoring the configured ACL.
  // For public, we synthesize the CDN URL from appId + customId — no API
  // round trip. For private we ask UploadThing for a short-lived signed URL.
  const resolveFetchUrl = async (key: string): Promise<string> => {
    if (acl === ACL_PUBLIC_READ) {
      return publicUrl(key);
    }
    const { ufsUrl } = await utapi.generateSignedURL(key, {
      expiresIn: defaultExpiresIn,
      keyType: "customId",
    });
    return ufsUrl;
  };

  const headViaFetch = async (
    url: string,
    key: string,
    signal?: AbortSignal
  ): Promise<{
    size: number;
    type: string;
    etag: string | undefined;
    lastModified: number | undefined;
  }> => {
    const res = await fetchWithTimeout(
      url,
      { method: "HEAD", ...(signal && { signal }) },
      downloadTimeoutMs
    );
    if (!res.ok) {
      throw new FilesError(
        res.status === 404 ? "NotFound" : "Provider",
        `uploadthing head failed: ${res.status} ${res.statusText} for ${key}`
      );
    }
    const lengthHeader = res.headers.get("content-length");
    const lastModifiedHeader = res.headers.get("last-modified");
    return {
      etag: res.headers.get("etag") ?? undefined,
      lastModified: lastModifiedHeader
        ? Date.parse(lastModifiedHeader) || undefined
        : undefined,
      size: lengthHeader ? Number(lengthHeader) : 0,
      type: res.headers.get("content-type") ?? DEFAULT_CONTENT_TYPE,
    };
  };

  const adapter: UploadThingAdapter = {
    async copy(from, to, opts) {
      // UploadThing has no server-side copy, so this downloads and
      // re-uploads. Note the re-upload **buffers the whole object**:
      // `uploadFiles` needs a Blob, so `bodyToBlob` drains the stream into
      // memory — a multi-GB copy will exhaust serverless memory limits.
      // Source and destination are not atomic; concurrent mutations to
      // `from` between the get and put are not detected. This call costs
      // both an egress download and an ingest upload — for large files,
      // prefer doing the copy at the application layer with a different
      // storage strategy.
      const src = await adapter.download(from, {
        as: "stream",
        signal: opts?.signal,
      });
      await adapter.upload(to, src.stream(), {
        ...(src.type && { contentType: src.type }),
        signal: opts?.signal,
      });
    },
    async delete(key) {
      try {
        // UploadThing's deleteFiles is idempotent — `success: true` is
        // returned whether or not the file existed.
        await utapi.deleteFiles(key);
      } catch (error) {
        throw mapUploadThingError(error);
      }
    },
    async deleteMany(keys, deleteOpts) {
      if (keys.length === 0) {
        return { deleted: [] };
      }
      if (deleteOpts?.stopOnError) {
        return deleteManyWithFallback(
          keys,
          (key) => adapter.delete(key),
          deleteOpts,
          mapUploadThingError
        );
      }
      try {
        // No documented per-request key cap, so send the whole list in one
        // call. `deleteFiles` reports only whole-request failure, not per-key,
        // so on error the mapped error is attributed to every key.
        await utapi.deleteFiles(keys);
        return { deleted: [...keys] };
      } catch (error) {
        const mapped = mapUploadThingError(error);
        return {
          deleted: [],
          errors: keys.map((key) => ({ error: mapped, key })),
        };
      }
    },
    async download(key, downloadOpts) {
      const url = await resolveFetchUrl(key);
      const range = downloadOpts?.range;
      let res: Response;
      try {
        res = await fetchWithTimeout(
          url,
          {
            ...(downloadOpts?.signal && { signal: downloadOpts.signal }),
            ...(range && { headers: rangeRequestHeaders(range) }),
          },
          downloadTimeoutMs
        );
      } catch (error) {
        throw mapUploadThingError(error);
      }
      if (!res.ok) {
        throw new FilesError(
          res.status === 404 ? "NotFound" : "Provider",
          `uploadthing download failed: ${res.status} ${res.statusText} for ${key}`
        );
      }
      if (range) {
        // 206 means the CDN honored the slice; a 200 here would be the whole
        // object masquerading as a range.
        assertRangeHonored(res.status, "uploadthing");
      }
      // On a 206 the content-length header is the slice length, so the stream
      // path's size below is already correct for ranged reads.
      const lengthHeader = res.headers.get("content-length");
      const lastModifiedHeader = res.headers.get("last-modified");
      const meta = {
        etag: res.headers.get("etag") ?? undefined,
        key,
        lastModified: lastModifiedHeader
          ? Date.parse(lastModifiedHeader) || undefined
          : undefined,
        size: lengthHeader ? Number(lengthHeader) : 0,
        type: res.headers.get("content-type") ?? DEFAULT_CONTENT_TYPE,
      };
      if (downloadOpts?.as === "stream" && res.body) {
        const stream = res.body;
        return createStoredFile(meta, {
          factory: () => stream,
          kind: "stream",
        });
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return createStoredFile(
        { ...meta, size: bytes.byteLength },
        { data: bytes, kind: "buffer" }
      );
    },
    exists(key, opts) {
      return existsByProbe(async () => {
        const url = await resolveFetchUrl(key);
        await headViaFetch(url, key, opts?.signal);
      }, mapUploadThingError);
    },
    async head(key, opts) {
      const url = await resolveFetchUrl(key);
      let info: Awaited<ReturnType<typeof headViaFetch>>;
      try {
        info = await headViaFetch(url, key, opts?.signal);
      } catch (error) {
        throw mapUploadThingError(error);
      }
      return createStoredFile(
        {
          etag: info.etag,
          key,
          lastModified: info.lastModified,
          size: info.size,
          type: info.type,
        },
        {
          factory: async () => {
            const res = await fetchWithTimeout(
              url,
              undefined,
              downloadTimeoutMs
            );
            if (!res.ok) {
              throw new FilesError(
                res.status === 404 ? "NotFound" : "Provider",
                `uploadthing fetch failed: ${res.status} ${res.statusText} for ${key}`
              );
            }
            return new Uint8Array(await res.arrayBuffer());
          },
          kind: "lazy",
        }
      );
    },
    async list(options): Promise<ListResult> {
      const limit = options?.limit;
      const offset = options?.cursor ? Number(options.cursor) : 0;
      let result: Awaited<ReturnType<typeof utapi.listFiles>>;
      try {
        result = await utapi.listFiles({
          ...(limit !== undefined && { limit }),
          offset,
        });
      } catch (error) {
        throw mapUploadThingError(error);
      }
      // UploadThing's listFiles has no server-side prefix filter. Apply
      // the prefix client-side over the returned page if the caller asked
      // for one — note that this filters within a page, not across the
      // whole bucket, so a too-narrow prefix on a non-prefix-clustered
      // store will under-return. Document this limitation in the README.
      const filtered = options?.prefix
        ? result.files.filter((f) =>
            (f.customId ?? f.key).startsWith(options.prefix as string)
          )
        : result.files;
      const items: StoredFile[] = filtered.map((f) => {
        // We always uploaded with customId = user key, so customId is the
        // canonical identifier. Fall back to the UploadThing key if a file
        // was uploaded out-of-band without a customId.
        const itemKey = f.customId ?? f.key;
        return createStoredFile(
          {
            key: itemKey,
            lastModified: f.uploadedAt,
            size: f.size,
            type: DEFAULT_CONTENT_TYPE,
          },
          {
            factory: async () => {
              const url = await resolveFetchUrl(itemKey);
              const res = await fetchWithTimeout(
                url,
                undefined,
                downloadTimeoutMs
              );
              return new Uint8Array(await res.arrayBuffer());
            },
            kind: "lazy",
          }
        );
      });
      return {
        cursor: result.hasMore
          ? String(offset + result.files.length)
          : undefined,
        items,
      };
    },
    name: "uploadthing",
    raw: utapi,
    async signedUploadUrl(key, options): Promise<SignedUpload> {
      // Construct a UFS ingest URL the client PUTs to directly. The query
      // params encode the upload's contract (size cap, content type, ACL)
      // and the signature is HMAC-SHA256 over the URL signed with the
      // UploadThing API key — see
      // https://docs.uploadthing.com/uploading-files for the wire format.
      //
      // UploadThing's UFS presigned PUT flow has no SDK-visible
      // content-length-range policy equivalent. Refuse policy-backed size
      // caps rather than returning a URL whose limit is only advisory.
      if (options.maxSize !== undefined) {
        throw new FilesError(
          "Provider",
          "uploadthing: `maxSize` is not supported for signed upload URLs. UploadThing UFS presigned PUT URLs do not expose a server-enforced content-length-range policy; enforce the limit through your application gateway or omit `maxSize` and accept the unbounded PUT."
        );
      }
      const fileKey = randomFileKey();
      const url = new URL(
        `https://${region}.ingest.uploadthing.com/${fileKey}`
      );
      url.searchParams.set(
        "expires",
        String(Date.now() + options.expiresIn * 1000)
      );
      url.searchParams.set("x-ut-identifier", appId);
      url.searchParams.set("x-ut-file-name", basename(key));
      if (config.slug) {
        url.searchParams.set("x-ut-slug", config.slug);
      }
      if (options.contentType) {
        url.searchParams.set("x-ut-file-type", options.contentType);
      }
      url.searchParams.set("x-ut-custom-id", key);
      url.searchParams.set("x-ut-acl", acl);
      const signature = `hmac-sha256=${await hmacSha256Hex(url.toString(), apiKey)}`;
      url.searchParams.set("signature", signature);
      return {
        method: "PUT",
        url: url.toString(),
      };
    },
    // `url()` mints a `generateSignedURL` for private files (public-read
    // returns the CDN URL).
    signedUrl: { supported: true },
    supportsRange: true,
    // No server-side copy — `copy()` downloads then re-uploads (buffered).
    supportsServerSideCopy: false,
    async upload(key, body, options): Promise<UploadResult> {
      const contentType = options?.contentType;
      const blob = await bodyToBlob(body, contentType);
      const file = new UTFile([blob], basename(key), {
        customId: key,
        ...(contentType && { type: contentType }),
      });
      // Deliberately call the single-file overload (not the array one) so
      // the inferred return type is `UploadFileResult`, not
      // `UploadFileResult[]` — TypeScript otherwise picks the last
      // overload via `ReturnType<typeof utapi.uploadFiles>`.
      let result;
      try {
        result = await utapi.uploadFiles(file, {
          acl,
          ...(options?.signal && { signal: options.signal }),
        });
      } catch (error) {
        throw mapUploadThingError(error);
      }
      if (result.error) {
        throw mapUploadThingError(result.error);
      }
      const { data } = result;
      // Prefer the locally-known size when available — saves us from
      // trusting an unverified value back from the API for known-size
      // bodies. Stream uploads were already buffered in bodyToBlob, so
      // sizeOf() finds them too.
      const localSize = sizeOf(body);
      return {
        contentType: data.type || contentType || DEFAULT_CONTENT_TYPE,
        etag: data.fileHash,
        key,
        lastModified: data.lastModified ?? Date.now(),
        size: localSize ?? data.size,
      };
    },
    async url(key, urlOpts): Promise<string> {
      // UploadThing's CDN has no Content-Disposition override, so a public
      // URL can't carry the security knob that forces a download for
      // user-uploaded HTML/SVG. Throw rather than silently dropping the
      // override — same shape as the Vercel Blob adapter.
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "uploadthing: `responseContentDisposition` is not supported. UploadThing has no override for the Content-Disposition header on signed or CDN URLs."
        );
      }
      if (acl === ACL_PUBLIC_READ) {
        return publicUrl(key);
      }
      const expiresIn = urlOpts?.expiresIn ?? defaultExpiresIn;
      try {
        const { ufsUrl } = await utapi.generateSignedURL(key, {
          expiresIn,
          keyType: "customId",
        });
        return ufsUrl;
      } catch (error) {
        throw mapUploadThingError(error);
      }
    },
  };

  return adapter;
};
