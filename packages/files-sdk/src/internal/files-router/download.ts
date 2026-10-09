// The `download` byte path. Two strategies: redirect to a signed URL (bytes flow
// direct from storage, Range handled by the provider) when the adapter can sign;
// otherwise proxy the stream through the endpoint with full Range/206 support and
// the request signal wired into `files.download` so a client disconnect aborts
// the upstream fetch.

import type { ByteRange, Files, UrlOptions } from "../../index.js";
import { isDispositionUnsupported } from "../errors.js";
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
  const match = /^bytes=(?<start>\d*)-(?<end>\d*)$/u.exec(header.trim());
  if (!match) {
    return { kind: "full" };
  }
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return { kind: "full" };
  }
  if (size === 0) {
    // No byte of an empty object is addressable. `bytes=0-` already fails
    // the `start < size` check below, but a suffix (`bytes=-N`) would resolve
    // to `end = -1` — an inverted range the SDK rejects with a 500 rather
    // than the 416 (`Content-Range: bytes */0`) the client can act on.
    return { kind: "unsatisfiable" };
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

/** The `X-Files-Meta` payload — metadata with no HTTP-header home. */
interface DownloadMeta {
  etag: string | undefined;
  key: string;
  lastModified: number | undefined;
  metadata: Record<string, string> | undefined;
}

const encodeMeta = (meta: DownloadMeta): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(meta));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

/** The byte-range request headers the proxy path honours. */
export interface RangeRequest {
  range: string | null;
  ifRange: string | null;
}

const opaqueTag = (tag: string): string | undefined => {
  const trimmed = tag.trim();
  // A weak validator never satisfies If-Range (RFC 9110 §13.1.5).
  if (trimmed.startsWith("W/")) {
    return undefined;
  }
  return trimmed.replace(/^"(?<tag>.*)"$/u, "$<tag>");
};

/**
 * Whether an `If-Range` validator still names the current representation — a
 * strong entity-tag match, or an HTTP-date equal to `lastModified` (to the
 * second). Anything else means the object changed since the client's first
 * slice, so the range must be ignored and the full body sent (200) rather than
 * splicing a slice of the new object onto the old one.
 */
const ifRangeMatches = (
  validator: string,
  etag: string | undefined,
  lastModified: number | undefined
): boolean => {
  const value = validator.trim();
  const date = Date.parse(value);
  if (
    !(value.startsWith('"') || value.startsWith("W/") || Number.isNaN(date))
  ) {
    return (
      lastModified !== undefined &&
      Math.floor(date / 1000) === Math.floor(lastModified / 1000)
    );
  }
  // An entity-tag — quoted per spec, or echoed bare from an adapter whose
  // `etag` header carries no quotes.
  const wanted = opaqueTag(value);
  const current = etag === undefined ? undefined : opaqueTag(etag);
  return wanted !== undefined && wanted === current;
};

/** The `Range` to honour: dropped when an `If-Range` validator is stale. */
const honouredRange = (
  request: RangeRequest,
  meta: { etag?: string; lastModified?: number }
): string | null =>
  request.ifRange === null ||
  ifRangeMatches(request.ifRange, meta.etag, meta.lastModified)
    ? request.range
    : null;

const rangeNotSatisfiable = (size: number): ResultModel => ({
  headers: { "content-range": `bytes */${size}` },
  kind: "empty",
  status: 416,
});

/**
 * `bytes=0-`: the open-ended range from the first byte, which the whole body
 * satisfies. Browsers open every `<video>`/`<audio>` with it, so a non-range
 * adapter answers it with the full object (200) rather than a 416.
 */
const isWholeObjectRange = (header: string): boolean =>
  /^bytes=0+-$/u.test(header.trim());

/**
 * The `ETag` response header in RFC 9110 entity-tag form. Adapters report
 * etags as the provider gave them — the S3 family strips the quotes — so a
 * bare value is quoted, and an already-quoted or weak one is left alone.
 */
const entityTag = (etag: string): string =>
  etag.startsWith('"') || etag.startsWith('W/"') ? etag : `"${etag}"`;

/**
 * Whether `authorize` deliberately allowed inline rendering. Only then may a
 * URL go out without the disposition an adapter refused to bind: a bare URL
 * renders however the provider serves it, which inline policy already accepts.
 */
const isInlinePolicy = (policy: string | undefined): boolean =>
  policy !== undefined && /^\s*inline\b/iu.test(policy);

/**
 * `files.url()` carrying `disposition`. When the adapter refuses to bind any
 * disposition into its URLs (see `isDispositionUnsupported`) and the
 * disposition is `authorize`'s inline policy, the URL is minted without one;
 * any other refusal — the gateway's own `attachment` default — is rethrown,
 * because the gateway can't guarantee that disposition.
 */
export const urlWithDisposition = async (
  files: Files,
  key: string,
  opts: UrlOptions,
  disposition: string | undefined,
  policy: string | undefined
): Promise<string> => {
  if (!disposition) {
    return await files.url(key, opts);
  }
  try {
    return await files.url(key, {
      ...opts,
      responseContentDisposition: disposition,
    });
  } catch (error) {
    if (isDispositionUnsupported(error) && isInlinePolicy(policy)) {
      return await files.url(key, opts);
    }
    throw error;
  }
};

// The signed-URL redirect, or `undefined` when `auto` mode should proxy
// instead: the adapter can sign but can't bind the `attachment` disposition
// the gateway forces, and the proxy path sets `Content-Disposition` itself.
const redirectTarget = async (
  cfg: DownloadConfig,
  storageKey: string,
  scope: Scope,
  disposition: string | undefined,
  signal: AbortSignal
): Promise<ResultModel | undefined> => {
  const caps = cfg.files.capabilities;
  let expiresIn = cfg.defaultExpiresIn;
  if (scope.maxExpiresIn !== undefined) {
    expiresIn = Math.min(expiresIn, scope.maxExpiresIn);
  }
  if (caps.signedUrl.maxExpiresIn !== undefined) {
    expiresIn = Math.min(expiresIn, caps.signedUrl.maxExpiresIn);
  }
  try {
    const url = await urlWithDisposition(
      cfg.files,
      storageKey,
      { expiresIn, signal },
      disposition,
      scope.disposition
    );
    return { kind: "redirect", location: url, status: 302 };
  } catch (error) {
    if (cfg.downloadMode === "auto" && isDispositionUnsupported(error)) {
      return undefined;
    }
    throw error;
  }
};

export const handleDownload = async (
  cfg: DownloadConfig,
  storageKey: string,
  unscopedKey: string,
  request: RangeRequest,
  scope: Scope,
  signal: AbortSignal
  // oxlint-disable-next-line sonarjs/cognitive-complexity -- download flow (redirect vs proxy, Range + If-Range, disposition) is cohesive; splitting it would scatter tightly-coupled response logic
): Promise<ResultModel> => {
  const caps = cfg.files.capabilities;
  const disposition =
    scope.disposition ?? (cfg.forceDisposition ? "attachment" : undefined);

  const useRedirect =
    cfg.downloadMode === "redirect" ||
    (cfg.downloadMode === "auto" && caps.signedUrl.supported);

  if (useRedirect) {
    const redirect = await redirectTarget(
      cfg,
      storageKey,
      scope,
      disposition,
      signal
    );
    if (redirect) {
      return redirect;
    }
  }

  const meta = await cfg.files.head(storageKey, { signal });
  const { size } = meta;
  const rangeHeader = honouredRange(request, meta);

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
    } else if (
      cfg.onUnsupportedRange === "reject" &&
      !isWholeObjectRange(rangeHeader)
    ) {
      return rangeNotSatisfiable(size);
    }
  }

  const file = await cfg.files.download(storageKey, {
    as: "stream",
    signal,
    ...(range && { range }),
  });

  const headers = {
    "accept-ranges": caps.rangeRead ? "bytes" : "none",
    "content-length": String(length),
    "content-type": file.contentType || "application/octet-stream",
    // The body is storage content served from the app's origin: never let the
    // browser sniff it into something executable (HTML/script).
    "x-content-type-options": "nosniff",
    "x-files-meta": encodeMeta({
      etag: meta.etag,
      key: unscopedKey,
      lastModified: meta.lastModified,
      metadata: meta.metadata,
    }),
    ...(meta.etag && { etag: entityTag(meta.etag) }),
    ...(meta.lastModified !== undefined && {
      "last-modified": new Date(meta.lastModified).toUTCString(),
    }),
    ...(disposition && { "content-disposition": disposition }),
    ...(range && {
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
    }),
  };

  return { headers, kind: "stream", status, stream: file.stream() };
};
