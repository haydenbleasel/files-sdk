// Turn a `download` `Response` into the same lazy `StoredFile` the server SDK
// returns, reusing `createStoredFile` so `blob()/text()/arrayBuffer()/stream()`
// behave identically (including the single-consumption guard). The body is a
// streaming `BodySource` over `Response.body` — a large download isn't buffered
// unless an accessor asks for the bytes. On runtimes whose fetch never exposes
// `Response.body` (React Native), it falls back to a lazy `arrayBuffer()`
// buffer instead. Metadata with no HTTP-header home (`key`, `metadata`) rides
// in the base64 `X-Files-Meta` header.

import type { StoredFile } from "../index.js";
import { createStoredFile } from "../internal/stored-file.js";

interface MetaHeader {
  key?: string;
  metadata?: Record<string, string>;
  lastModified?: number;
  etag?: string;
}

const decodeMeta = (header: string | null): MetaHeader => {
  if (!header) {
    return {};
  }
  try {
    const bytes = Uint8Array.from(atob(header), (c) => c.codePointAt(0) ?? 0);
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
  const lengthHeader = res.headers.get("content-length");
  const size = lengthHeader === null ? 0 : Number(lengthHeader);
  const { body } = res;
  return createStoredFile(
    {
      etag: res.headers.get("etag") ?? meta.etag,
      key: meta.key ?? fallbackKey,
      lastModified: meta.lastModified,
      metadata: meta.metadata,
      size,
      type: res.headers.get("content-type") ?? "application/octet-stream",
    },
    body
      ? { factory: () => body, kind: "stream" }
      : {
          factory: async () => new Uint8Array(await res.arrayBuffer()),
          kind: "lazy",
        }
  );
};
