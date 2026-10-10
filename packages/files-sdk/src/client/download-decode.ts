// Turn a `download` `Response` into the same lazy `StoredFile` the server SDK
// returns, reusing `createStoredFile` so `blob()/text()/arrayBuffer()/stream()`
// behave identically (including the single-consumption guard). The body is a
// streaming `BodySource` over `Response.body` — a large download isn't buffered
// unless an accessor asks for the bytes. On runtimes whose fetch never exposes
// `Response.body` (React Native), it falls back to a lazy `arrayBuffer()`
// buffer instead. Metadata with no HTTP-header home (`key`, `metadata`) rides
// in the base64 `X-Files-Meta` header.

import type { StoredFile } from "../index.js";
import type { WireDownloadMeta } from "../internal/files-router/protocol.js";
import { isNumber } from "../internal/is.js";
import { createStoredFile } from "../internal/stored-file.js";

/**
 * The decoded `X-Files-Meta` header — every field optional, since a foreign or
 * garbled header decodes to `{}`. `size` is the whole object's, sent on a full
 * (200) proxied download only.
 */
type MetaHeader = Partial<WireDownloadMeta>;

// `MetaHeader` is decoded JSON, so `size` is re-checked at run time.
const byteCount = (value: number | undefined): number | undefined =>
  isNumber(value) && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const contentLength = (header: string | null): number | undefined =>
  header === null || header.trim() === ""
    ? undefined
    : byteCount(Number(header));

/** An HTTP date (`Last-Modified`) as epoch milliseconds, like `FileInfo`. */
const httpDate = (header: string | null): number | undefined => {
  const ms = header ? Date.parse(header) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

const decodeMeta = (header: string | null): MetaHeader => {
  if (!header) {
    return {};
  }
  try {
    const bytes = Uint8Array.from(atob(header), (c) => c.codePointAt(0) ?? 0);
    // SAFETY: `X-Files-Meta` is minted by the gateway's download handler
    // (`encodeMeta`) as the base64 JSON of exactly these optional fields; a
    // garbled or foreign header fails to decode and falls to the catch below.
    return JSON.parse(new TextDecoder().decode(bytes)) as MetaHeader;
  } catch {
    return {};
  }
};

export const decodeDownload = (
  res: Response,
  fallbackKey: string
): StoredFile => {
  const meta = decodeMeta(res.headers.get("x-files-meta"));
  // The gateway's own `size` wins on a full download: compression middleware
  // between it and the browser drops or rewrites `Content-Length`. A 206 is a
  // slice, whose size is its own length, and a redirected download has no
  // meta header, so both fall back to the header.
  const size =
    (res.status === 206 ? undefined : byteCount(meta.size)) ??
    contentLength(res.headers.get("content-length")) ??
    0;
  const { body } = res;
  return createStoredFile(
    {
      contentType:
        res.headers.get("content-type") ?? "application/octet-stream",
      // The gateway's `ETag` header is quoted for HTTP; `X-Files-Meta` keeps
      // the etag exactly as the adapter reported it, matching `head()`. A
      // redirected download has no meta header, so the storage `ETag` stands.
      etag: meta.etag ?? res.headers.get("etag") ?? undefined,
      key: meta.key ?? fallbackKey,
      // Likewise the storage host's `Last-Modified` stands in on a redirect.
      lastModified:
        meta.lastModified ?? httpDate(res.headers.get("last-modified")),
      metadata: meta.metadata,
      size,
    },
    body
      ? { factory: () => body, kind: "stream" }
      : {
          factory: async () => new Uint8Array(await res.arrayBuffer()),
          kind: "lazy",
        },
    // On the buffering (React Native) path, hand blob() the Response's own
    // native Blob — RN's Blob cannot be constructed from raw bytes.
    body ? undefined : () => res.blob()
  );
};
