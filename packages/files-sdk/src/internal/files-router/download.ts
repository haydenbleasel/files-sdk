// The `download` byte path. Two strategies: redirect to a signed URL (bytes flow
// direct from storage, Range handled by the provider) when the adapter can sign;
// otherwise proxy the stream through the endpoint with full Range/206 support and
// the request signal wired into `files.download` so a client disconnect aborts
// the upstream fetch.

import type { ByteRange, Files } from "../../index.js";
import type { ResultModel } from "../router-core/web.js";
import type { Scope } from "./authorize.js";

export interface DownloadConfig {
  files: Files;
  downloadMode: "auto" | "redirect" | "proxy";
  onUnsupportedRange: "reject" | "ignore";
  forceDisposition: boolean;
  defaultExpiresIn: number;
}

type RangeParse =
  | { kind: "full" }
  | { kind: "range"; range: ByteRange; length: number }
  | { kind: "unsatisfiable" };

const parseRangeHeader = (header: string, size: number): RangeParse => {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) {
    return { kind: "full" };
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return { kind: "full" };
  }

  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix <= 0) {
      return { kind: "unsatisfiable" };
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (start >= size) {
      return { kind: "unsatisfiable" };
    }
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (end < start) {
      return { kind: "unsatisfiable" };
    }
  }
  return { kind: "range", length: end - start + 1, range: { end, start } };
};

const encodeMeta = (meta: unknown): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(meta));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

const rangeNotSatisfiable = (size: number): ResultModel => ({
  headers: { "content-range": `bytes */${size}` },
  kind: "empty",
  status: 416,
});

export const handleDownload = async (
  cfg: DownloadConfig,
  storageKey: string,
  unscopedKey: string,
  rangeHeader: string | null,
  scope: Scope,
  signal: AbortSignal
): Promise<ResultModel> => {
  const caps = cfg.files.capabilities;
  const disposition =
    scope.disposition ?? (cfg.forceDisposition ? "attachment" : undefined);

  const useRedirect =
    cfg.downloadMode === "redirect" ||
    (cfg.downloadMode === "auto" && caps.signedUrl.supported);

  if (useRedirect) {
    let expiresIn = cfg.defaultExpiresIn;
    if (scope.maxExpiresIn !== undefined) {
      expiresIn = Math.min(expiresIn, scope.maxExpiresIn);
    }
    if (caps.signedUrl.maxExpiresIn !== undefined) {
      expiresIn = Math.min(expiresIn, caps.signedUrl.maxExpiresIn);
    }
    const url = await cfg.files.url(storageKey, {
      expiresIn,
      ...(disposition ? { responseContentDisposition: disposition } : {}),
    });
    return { kind: "redirect", location: url, status: 302 };
  }

  const meta = await cfg.files.head(storageKey, { signal });
  const { size } = meta;

  let range: ByteRange | undefined;
  let length = size;
  let status = 200;
  if (rangeHeader) {
    if (caps.rangeRead) {
      const parsed = parseRangeHeader(rangeHeader, size);
      if (parsed.kind === "unsatisfiable") {
        return rangeNotSatisfiable(size);
      }
      if (parsed.kind === "range") {
        ({ range } = parsed);
        ({ length } = parsed);
        status = 206;
      }
    } else if (cfg.onUnsupportedRange === "reject") {
      return rangeNotSatisfiable(size);
    }
  }

  const file = await cfg.files.download(storageKey, {
    as: "stream",
    signal,
    ...(range ? { range } : {}),
  });

  const headers: Record<string, string> = {
    "accept-ranges": "bytes",
    "content-length": String(length),
    "content-type": file.type || "application/octet-stream",
    "x-files-meta": encodeMeta({
      etag: meta.etag,
      key: unscopedKey,
      lastModified: meta.lastModified,
      metadata: meta.metadata,
    }),
  };
  if (meta.etag) {
    headers.etag = meta.etag;
  }
  if (disposition) {
    headers["content-disposition"] = disposition;
  }
  if (range) {
    headers["content-range"] = `bytes ${range.start}-${range.end}/${size}`;
  }

  return { headers, kind: "stream", status, stream: file.stream() };
};
