// Shared building blocks for adapter authors.
//
// Adapters duplicate a small set of helpers — body normalization, URL
// joining, expiry defaults, the public-vs-sign precedence rule, and the
// error-mapping scaffold. Centralizing them here cuts ~50 lines per new
// adapter and codifies the security-relevant invariants (notably "asking
// for `responseContentDisposition` forces signing") in one place.

import type { Body } from "../index.js";
import { FilesError } from "./errors.js";
import type { FilesErrorCode } from "./errors.js";

// =============================================================================
// URL helpers
// =============================================================================

/**
 * Default expiry, in seconds, for adapter `url()` and signed-upload helpers
 * when neither a per-call `expiresIn` nor an adapter-level
 * `defaultUrlExpiresIn` is set. 1 hour: long enough for normal browser
 * flows, short enough that an accidentally-leaked URL stops working before
 * the day is out.
 */
export const DEFAULT_URL_EXPIRES_IN = 3600;

/**
 * Concatenate a public base URL with a key. Tolerates a single trailing
 * slash on the base. The key is URL-encoded so it's safe to embed in a URL path.
 * Pass raw keys — this function handles encoding. Passing a pre-encoded key
 * causes double-encoding (e.g. `%20` becomes `%2520`).
 */
export const joinPublicUrl = (base: string, key: string): string => {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/${key.split("/").map(encodeURIComponent).join("/")}`;
};

export interface UrlStrategyInput {
  publicBaseUrl?: string;
  responseContentDisposition?: string;
}

/**
 * Resolve which path `url()` should take when the adapter has both a
 * `publicBaseUrl` (unsigned, permanent) and a signing primitive available.
 *
 * - `"public"` — return `${publicBaseUrl}/${key}` unsigned.
 * - `"sign"` — mint a presigned/SAS URL.
 *
 * `responseContentDisposition` always forces `"sign"`, even when
 * `publicBaseUrl` is configured: a permanent CDN URL has no signature in
 * which to bind the override, and silently dropping the override is a
 * stored-XSS regression on user-uploaded HTML/SVG. The override wins.
 *
 * Adapters with three or more URL strategies (e.g. Supabase's
 * public/getPublicUrl/signed split, R2's binding/hybrid/throw split) keep
 * their own logic — this helper is for the common two-state case.
 */
export const resolveUrlStrategy = (
  input: UrlStrategyInput
): "public" | "sign" => {
  if (input.publicBaseUrl && !input.responseContentDisposition) {
    return "public";
  }
  return "sign";
};

// =============================================================================
// Body normalization
// =============================================================================

export interface NormalizedBody {
  /**
   * The body as either a fully-buffered `Uint8Array` (when the source had a
   * known length) or a `ReadableStream<Uint8Array>` (when it didn't).
   * Adapters whose SDK accepts neither shape natively (Node `Buffer`,
   * `ArrayBuffer`, Node `Readable`) should convert this themselves —
   * branching on `data instanceof ReadableStream` is one line each.
   */
  data: Uint8Array | ReadableStream<Uint8Array>;
  contentType: string;
  /**
   * Bytes the adapter can declare up-front. Absent when the body is a
   * `ReadableStream` of unknown length — in that case, adapters that need a
   * size in their response (`UploadResult.size`) typically do a follow-up
   * `head()` after upload to surface the authoritative value.
   */
  contentLength?: number;
}

/**
 * Convert a {@link Body} into a uniform shape adapters can hand to their
 * underlying SDK.
 *
 * `contentTypeHint` always wins. Otherwise the type is inferred:
 * - strings → `"text/plain; charset=utf-8"`
 * - Blobs → `blob.type` if non-empty, else `"application/octet-stream"`
 * - everything else → `"application/octet-stream"`
 */
export const normalizeBody = async (
  body: Body,
  contentTypeHint?: string
): Promise<NormalizedBody> => {
  if (typeof body === "string") {
    const data = new TextEncoder().encode(body);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? "text/plain; charset=utf-8",
      data,
    };
  }
  if (body instanceof Uint8Array) {
    return {
      contentLength: body.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data: body,
    };
  }
  if (body instanceof ArrayBuffer) {
    const data = new Uint8Array(body);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data,
    };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data,
    };
  }
  if (body instanceof Blob) {
    const buf = new Uint8Array(await body.arrayBuffer());
    return {
      contentLength: buf.byteLength,
      contentType: contentTypeHint ?? body.type ?? "application/octet-stream",
      data: buf,
    };
  }
  return {
    contentType: contentTypeHint ?? "application/octet-stream",
    data: body,
  };
};

// =============================================================================
// Error mapping factory
// =============================================================================

export interface ErrorExtract {
  /**
   * Provider-specific error identifier (the string code from the response
   * body or SDK error class — e.g. `"NoSuchKey"`, `"BlobNotFound"`,
   * `"Duplicate"`). Matched against the sets in {@link ErrorMapperConfig.codes}.
   */
  code?: string;
  /**
   * HTTP status code. Matched against the standard buckets — 404 →
   * NotFound, 401/403 → Unauthorized, 409/412 → Conflict.
   */
  status?: number;
  message?: string;
}

export interface ErrorMapperConfig {
  /** Used as the fallback `Provider`-code message when the source error has none. */
  providerLabel: string;
  /**
   * Storage-error code strings that should map to each `FilesErrorCode`.
   * Pass empty `Set`s for providers that classify only by HTTP status.
   */
  codes: {
    notFound: ReadonlySet<string>;
    unauthorized: ReadonlySet<string>;
    conflict: ReadonlySet<string>;
  };
  /**
   * Pull a `{ code, status, message }` triple out of an unknown provider
   * error. Different SDKs put these on different fields (e.g. AWS uses
   * `$metadata.httpStatusCode`, Azure uses `details.errorCode`, Supabase
   * stringifies its code under `statusCode`) — encode that variance here.
   */
  extract: (err: unknown) => ErrorExtract;
}

const NOT_FOUND_STATUS = new Set([404]);
const UNAUTH_STATUS = new Set([401, 403]);
const CONFLICT_STATUS = new Set([409, 412]);

const classify = (
  config: ErrorMapperConfig,
  code: string | undefined,
  status: number | undefined
): FilesErrorCode => {
  if (
    (code && config.codes.notFound.has(code)) ||
    NOT_FOUND_STATUS.has(status ?? 0)
  ) {
    return "NotFound";
  }
  if (
    (code && config.codes.unauthorized.has(code)) ||
    UNAUTH_STATUS.has(status ?? 0)
  ) {
    return "Unauthorized";
  }
  if (
    (code && config.codes.conflict.has(code)) ||
    CONFLICT_STATUS.has(status ?? 0)
  ) {
    return "Conflict";
  }
  return "Provider";
};

/**
 * Build a `(err) => FilesError` mapper from a per-provider config. The
 * returned function:
 * - returns `err` unchanged if it's already a {@link FilesError} (so
 *   adapters can re-throw their own programmatic errors without
 *   re-wrapping)
 * - extracts code/status/message via `config.extract`
 * - classifies via the provider's code sets and the standard HTTP status
 *   buckets
 * - preserves the original error as `cause`
 */
export const makeErrorMapper = (
  config: ErrorMapperConfig
): ((err: unknown) => FilesError) => {
  const fallback: Record<FilesErrorCode, string> = {
    Conflict: "Conflict",
    NotFound: "Not found",
    Provider: config.providerLabel,
    Unauthorized: "Unauthorized",
  };
  return (err) => {
    if (err instanceof FilesError) {
      return err;
    }
    const { code, status, message } = config.extract(err);
    const errorCode = classify(config, code, status);
    return new FilesError(errorCode, message ?? fallback[errorCode], err);
  };
};

/**
 * Standard `exists()` scaffold for providers whose "does this object exist?"
 * probe is "attempt a metadata lookup and classify NotFound specially".
 *
 * The `probe` should be the cheapest provider call that can distinguish
 * present vs missing for the adapter. Successful probes return `true`;
 * mapped `NotFound` errors return `false`; every other failure is rethrown.
 */
export const existsByProbe = async (
  probe: () => Promise<unknown>,
  mapError: (err: unknown) => FilesError
): Promise<boolean> => {
  try {
    await probe();
    return true;
  } catch (error) {
    const mapped = mapError(error);
    if (mapped.code === "NotFound") {
      return false;
    }
    throw mapped;
  }
};
