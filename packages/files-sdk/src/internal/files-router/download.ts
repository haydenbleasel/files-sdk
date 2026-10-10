// The `download` byte path. Two strategies: redirect to a signed URL (bytes flow
// direct from storage, Range handled by the provider) when the adapter can sign;
// otherwise proxy the stream through the endpoint with full Range/206 support and
// the request signal wired into `files.download` so a client disconnect aborts
// the upstream fetch.

import type { ByteRange, FileInfo, Files, UrlOptions } from "../../index.js";
import { attachmentDisposition } from "../content-disposition.js";
import { FilesError, isDispositionUnsupported } from "../errors.js";
import { mediaTypeEssence } from "../media-type.js";
import type { ResultModel } from "../router-core/web.js";
import type { Scope } from "./authorize.js";
import type { WireDownloadMeta, WireError } from "./protocol.js";

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

const encodeMeta = (meta: WireDownloadMeta): string => {
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

/** A download request: its range headers, and whether it's a `HEAD`. */
export interface DownloadRequest extends RangeRequest {
  /** A `HEAD`: answer with the `GET`'s headers and no body. */
  head: boolean;
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

// A 416 still carries the gateway's error envelope, so the client reports it
// as the bad request it is (`Invalid`) rather than a generic failure.
const rangeNotSatisfiable = (size: number): ResultModel => {
  const body: WireError = {
    error: {
      code: "Validation",
      message: `range not satisfiable for a ${size}-byte object`,
      reason: "range",
    },
  };
  return {
    body,
    headers: {
      "cache-control": "private, no-store",
      "content-range": `bytes */${size}`,
    },
    kind: "json",
    status: 416,
  };
};

/**
 * Content types a browser renders without running anything from the response
 * itself: raster images, audio, video, and PDF (whose viewer is sandboxed by
 * the browser, and which a CSP `sandbox` would block from rendering in an
 * `<object>`/`<iframe>` preview). Everything else — HTML, SVG, XML, unknown
 * types — is served under {@link SANDBOX_POLICY}. So is a value that isn't
 * exactly one well-formed media type: a browser reads `image/png, text/html`
 * as its last entry and renders HTML.
 */
const isPassiveMedia = (contentType: string): boolean => {
  const type = mediaTypeEssence(contentType);
  if (type === undefined) {
    return false;
  }
  return (
    type === "application/pdf" ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    (type.startsWith("image/") && !type.startsWith("image/svg"))
  );
};

/**
 * The proxy serves storage content from the app's own origin, so a stored
 * `text/html` or SVG opened inline (an `authorize` `disposition: "inline"`, or
 * `forceDownloadDisposition: false`) would run its script as the app. Under
 * this policy the document gets an opaque origin, loads nothing, and runs no
 * script; inline styles still apply, so it previews legibly. It has no effect
 * where the body is embedded as an image or media element.
 */
const SANDBOX_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/**
 * Whether a refusal from `url()` means "redirecting can't honor this", not a
 * failure: the proxy can still serve it, so `auto` mode falls back to it.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a predicate over whatever a `catch` caught
const isRedirectRefusal = (error: unknown): boolean =>
  isDispositionUnsupported(error) ||
  (error instanceof FilesError && error.code === "Unsupported");

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

/**
 * The redirect for a download, or `undefined` to stream it through the proxy.
 * A redirect needs a URL that honors everything the download must carry: a
 * signed one binds the expiry and — when the adapter declares
 * `signedUrl.disposition` — the forced disposition, while `authorize`'s inline
 * policy needs no binding (a bare URL renders inline). The permanent public
 * link binds neither, so it serves only when nothing must be bound and
 * `authorize` doesn't cap the lifetime. Anything else streams through the
 * proxy, which sets both itself. An adapter refusal the declarations didn't
 * predict still falls back to the proxy in `auto` mode.
 */
const redirectTarget = async (
  cfg: DownloadConfig,
  storageKey: string,
  scope: Scope,
  disposition: string | undefined,
  signal: AbortSignal
): Promise<ResultModel | undefined> => {
  const caps = cfg.files.capabilities;
  // An inline policy is satisfied by a URL with no disposition at all.
  const mustBind = disposition !== undefined && !isInlinePolicy(disposition);
  const canSign =
    caps.signedUrl.supported && (!mustBind || caps.signedUrl.disposition);
  const canLinkPublic =
    caps.publicUrl && !mustBind && scope.maxExpiresIn === undefined;
  const useRedirect =
    cfg.downloadMode === "redirect" ||
    (cfg.downloadMode === "auto" && (canSign || canLinkPublic));
  if (!useRedirect) {
    return undefined;
  }
  if (canLinkPublic) {
    try {
      const url = await cfg.files.url(storageKey, { signal });
      return { kind: "redirect", location: url, status: 302 };
    } catch (error) {
      // A plugin (or the adapter) can still refuse the bare link — a
      // `signedUrlPolicy()` that insists on a disposition the public URL
      // can't carry, say. The proxy sets everything itself.
      if (cfg.downloadMode === "auto" && isRedirectRefusal(error)) {
        return undefined;
      }
      throw error;
    }
  }
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
    if (cfg.downloadMode === "auto" && isRedirectRefusal(error)) {
      return undefined;
    }
    throw error;
  }
};

/**
 * The disposition the proxy sends. The gateway's own `attachment` default
 * names the file after the key's last segment: the proxy URL ends in the
 * endpoint (`/api/files`), so a bare `attachment` would save every download
 * as `files`. A disposition `authorize` chose is sent as given.
 */
const proxyDisposition = (
  disposition: string | undefined,
  scope: Scope,
  unscopedKey: string
): string | undefined =>
  disposition !== undefined && scope.disposition === undefined
    ? attachmentDisposition(unscopedKey.slice(unscopedKey.lastIndexOf("/") + 1))
    : disposition;

/** What the proxy sends for a request's `Range`: a slice, or the whole body. */
interface Served {
  range: ByteRange | undefined;
  length: number;
  status: 200 | 206;
}

/**
 * The part of the object to send for `rangeHeader`, or `undefined` when the
 * range must be refused (416): unsatisfiable on a range adapter, or any range
 * but the whole object on one that can't read ranges, under `"reject"`.
 */
const servedRange = (
  cfg: DownloadConfig,
  rangeHeader: string | null,
  size: number
): Served | undefined => {
  const whole: Served = { length: size, range: undefined, status: 200 };
  if (!rangeHeader) {
    return whole;
  }
  if (!cfg.files.capabilities.rangeRead) {
    return cfg.onUnsupportedRange === "reject" &&
      !isWholeObjectRange(rangeHeader)
      ? undefined
      : whole;
  }
  const parsed = parseRangeHeader(rangeHeader, size);
  if (parsed.kind === "unsatisfiable") {
    return undefined;
  }
  return parsed.kind === "range"
    ? { length: parsed.length, range: parsed.range, status: 206 }
    : whole;
};

/** The proxied response's headers for `served` of the object `meta` describes. */
const proxyHeaders = (
  cfg: DownloadConfig,
  meta: FileInfo,
  contentType: string,
  served: Served,
  extra: { key: string; disposition: string | undefined }
) => {
  const { range } = served;
  return {
    "accept-ranges": cfg.files.capabilities.rangeRead ? "bytes" : "none",
    // Download URLs are tenant-relative (`?op=download&key=avatar.jpg` is the
    // same URL for every user under their own `keyPrefix`), so no shared cache
    // may store one user's bytes and serve them to the next.
    "cache-control": "private, no-store",
    "content-length": String(served.length),
    "content-type": contentType,
    // The body is storage content served from the app's origin: never let the
    // browser sniff it into something executable (HTML/script).
    "x-content-type-options": "nosniff",
    ...(!isPassiveMedia(contentType) && {
      "content-security-policy": SANDBOX_POLICY,
    }),
    "x-files-meta": encodeMeta({
      etag: meta.etag,
      key: extra.key,
      lastModified: meta.lastModified,
      metadata: meta.metadata,
      // The whole object's size, for a client behind compression middleware
      // that drops `Content-Length`. A 206 slice's length isn't the size.
      ...(served.status === 200 && { size: meta.size }),
    }),
    ...(meta.etag && { etag: entityTag(meta.etag) }),
    ...(meta.lastModified !== undefined && {
      "last-modified": new Date(meta.lastModified).toUTCString(),
    }),
    ...(extra.disposition && { "content-disposition": extra.disposition }),
    ...(range && {
      "content-range": `bytes ${range.start}-${range.end}/${meta.size}`,
    }),
  };
};

export const handleDownload = async (
  cfg: DownloadConfig,
  storageKey: string,
  unscopedKey: string,
  request: DownloadRequest,
  scope: Scope,
  signal: AbortSignal
): Promise<ResultModel> => {
  const disposition =
    scope.disposition ?? (cfg.forceDisposition ? "attachment" : undefined);

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

  const meta = await cfg.files.head(storageKey, { signal });
  // Range is defined for GET alone (RFC 9110 §14.2): a HEAD describes the
  // whole representation.
  const served = servedRange(
    cfg,
    request.head ? null : honouredRange(request, meta),
    meta.size
  );
  if (!served) {
    return rangeNotSatisfiable(meta.size);
  }

  // A HEAD never opens the body: `head()` already answered everything the
  // headers need.
  const file = request.head
    ? undefined
    : await cfg.files.download(storageKey, {
        as: "stream",
        signal,
        ...(served.range && { range: served.range }),
      });

  const headers = proxyHeaders(
    cfg,
    meta,
    (file ?? meta).contentType || "application/octet-stream",
    served,
    {
      disposition: proxyDisposition(disposition, scope, unscopedKey),
      key: unscopedKey,
    }
  );
  return {
    headers,
    kind: "stream",
    status: served.status,
    stream: file?.stream() ?? null,
  };
};
