import {
  byteLengthOf,
  countingStream,
  deleteManyWithFallback,
  mapMany,
} from "./internal/core.js";
import { FilesError } from "./internal/errors.js";

export { FilesError, type FilesErrorCode } from "./internal/errors.js";
export type { BodySource, StoredFileMeta } from "./internal/stored-file.js";
export { createStoredFile } from "./internal/stored-file.js";
// Provider catalog. The full data, per-provider env specs, and helpers live in
// the zero-dependency `files-sdk/providers` subpath; the name list and core
// types are surfaced here too so callers can discover providers without a
// second import.
export {
  type Provider,
  PROVIDER_NAMES,
  type ProviderSlug,
} from "./providers/index.js";

export type Body =
  | Blob
  | File
  | ReadableStream<Uint8Array>
  | ArrayBuffer
  | ArrayBufferView
  | Uint8Array
  | string;

export interface RetryBackoffContext {
  /**
   * Retry attempt number, starting at 1 for the first retry after the
   * initial failed call.
   */
  attempt: number;
  error: FilesError;
}

export type RetryOptions =
  | number
  | {
      max: number;
      backoff?: (ctx: RetryBackoffContext) => number;
    };

export interface OperationOptions {
  /**
   * Abort the operation when this signal is aborted. When both constructor
   * and per-call signals are provided, either one can abort the call.
   */
  signal?: AbortSignal;
  /**
   * Overall timeout in milliseconds, applied to each attempt. A timeout
   * aborts the operation and is not retried. `0` or a negative value
   * disables timeout handling.
   */
  timeout?: number;
  /**
   * Retry provider failures. A number is treated as `{ max: number }`.
   */
  retries?: RetryOptions;
}

/**
 * A single upload-progress report. Passed to {@link UploadOptions.onProgress}
 * (and {@link UploadManyOptions.onProgress}, which also carries the item `key`).
 */
export interface UploadProgress {
  /** Cumulative bytes sent so far. */
  loaded: number;
  /**
   * Total bytes to send, when known. Present for buffered bodies (`File`,
   * `Blob`, `ArrayBuffer`, `Uint8Array`, `string`); omitted for
   * `ReadableStream` bodies of unknown length, where only `loaded` can be
   * reported.
   */
  total?: number;
}

/**
 * Tuning for multipart uploads. Pass `multipart: true` for sensible defaults,
 * or an object to override them. See {@link UploadOptions.multipart}.
 */
export interface MultipartOptions {
  /**
   * Size of each uploaded part, in bytes. Defaults to 5 MiB
   * (`5 * 1024 * 1024`) — also the S3-enforced minimum for every part except
   * the last. Adapters that chunk natively round this to their own valid
   * granularity (OneDrive to a 320-KiB multiple, GCS/Firebase to 256 KiB).
   */
  partSize?: number;
  /**
   * How many parts upload in parallel. Defaults to `4`. Higher values trade
   * memory (up to `partSize * concurrency` buffered at once) for throughput.
   */
  concurrency?: number;
}

export interface UploadOptions extends OperationOptions {
  /**
   * MIME type stored alongside the object and returned to readers in the
   * `Content-Type` response header. Inferred from `File` / `Blob` `type`
   * when not set; falls back to `application/octet-stream`.
   */
  contentType?: string;
  /**
   * `Cache-Control` header stored on the object. Sent verbatim to the
   * provider; controls how downstream caches and browsers cache reads of
   * this key.
   */
  cacheControl?: string;
  /**
   * Arbitrary user metadata stored alongside the object. Returned by
   * `head()` and `list()` where the provider supports it. Vercel Blob and
   * UploadThing have no user-metadata primitive, so it round-trips as
   * `undefined` there. Bunny Storage, Appwrite, and PocketBase have no
   * arbitrary metadata primitive, so those adapters throw when this option
   * is passed.
   */
  metadata?: Record<string, string>;
  /**
   * Called as the upload makes progress, for driving a progress bar.
   *
   * Granularity depends on the body and the adapter:
   * - A `ReadableStream` body is reported byte-by-byte as the adapter
   *   consumes it (`total` is omitted unless the length is known).
   * - A buffered body (`File`, `Blob`, `ArrayBuffer`, `Uint8Array`, `string`)
   *   is handed to the provider whole, so it reports `{ loaded: 0, total }`
   *   then `{ loaded: total, total }` — unless the adapter reports true
   *   progress itself (see below).
   * - **S3 and the S3-compatible adapters** report true byte-level progress
   *   for every body type (including multipart for large files). This path
   *   uses `@aws-sdk/lib-storage`, an optional peer dependency that must be
   *   installed when `onProgress` is used with those adapters.
   *
   * Only fires while the upload is in flight and on success; a failed upload
   * does not emit a final event. On retry, progress restarts.
   */
  onProgress?: (progress: UploadProgress) => void;
  /**
   * Upload the body in parallel parts instead of a single request. Pass `true`
   * for sensible defaults (5 MiB parts, 4 in flight), or an object to tune
   * `partSize` / `concurrency`. Multipart is the robust path for large objects
   * and for `ReadableStream` bodies of unknown length: a single PUT must buffer
   * or know the length up front, while multipart streams part-by-part.
   *
   * On S3-family adapters this routes through `@aws-sdk/lib-storage` (an
   * optional peer dependency) and is **auto-engaged for unknown-length
   * streams** even when this flag is unset. OneDrive, GCS, Firebase, and Azure
   * map it to their native chunking; other adapters already stream or chunk
   * transparently and ignore it.
   */
  multipart?: boolean | MultipartOptions;
}

export interface UploadResult {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
  lastModified?: number;
}

export interface StoredFile {
  name: string;
  size: number;
  type: string;
  lastModified?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  stream(): ReadableStream<Uint8Array>;
  blob(): Promise<Blob>;
  key: string;
  etag?: string;
  metadata?: Record<string, string>;
}

export interface DownloadOptions extends OperationOptions {
  as?: "blob" | "stream";
}

export interface ListOptions extends OperationOptions {
  /**
   * Filter results to keys that start with this string. Omit to list
   * everything in the bucket.
   */
  prefix?: string;
  /**
   * Continuation token from a prior result. Pass the `cursor` field of the
   * previous page back in to fetch the next page; omit on the first call.
   */
  cursor?: string;
  /**
   * Maximum number of items to return per page. Capped per-provider (most
   * providers max around 1000). Defaults to 1000.
   */
  limit?: number;
}

export interface ListResult {
  items: StoredFile[];
  cursor?: string;
}

export interface DeleteManyOptions {
  /**
   * How many per-key deletes run in parallel when an adapter falls back to
   * repeated `delete()` calls. Defaults to `8`. Adapters with a native bulk
   * primitive (S3, Supabase, UploadThing) ignore this — they delete in one
   * request.
   */
  concurrency?: number;
  /**
   * When `true`, stop at the first failure and return immediately with the
   * keys deleted so far plus that error. When `false` (default), process
   * every key and collect per-key failures in `errors`.
   */
  stopOnError?: boolean;
}

export interface DeleteManyError {
  key: string;
  error: FilesError;
}

export interface DeleteManyResult {
  /** Keys that were deleted, in the order they were supplied. */
  deleted: string[];
  /** Per-key failures. Omitted entirely when every key succeeded. */
  errors?: DeleteManyError[];
}

/**
 * Shared controls for the array form of the bulk methods (`upload`,
 * `download`, `head`, `exists`). Unlike `delete`, none of these have a native
 * provider batch primitive, so the SDK always fans out to per-key calls.
 */
export interface BulkOptions {
  /**
   * How many per-key operations run in parallel. Defaults to `8`. Ignored
   * when `stopOnError` is set — that path runs sequentially.
   */
  concurrency?: number;
  /**
   * When `true`, stop at the first failure and return immediately with the
   * results gathered so far plus that error. When `false` (default), process
   * every item and collect per-key failures in `errors`.
   */
  stopOnError?: boolean;
}

/** A single per-key failure from the array form of a bulk method. */
export interface BulkError {
  key: string;
  error: FilesError;
}

/** One item in the array form of {@link Files.upload}. */
export interface UploadManyItem {
  key: string;
  body: Body;
  /** Per-item MIME type. See {@link UploadOptions.contentType}. */
  contentType?: string;
  /** Per-item `Cache-Control`. See {@link UploadOptions.cacheControl}. */
  cacheControl?: string;
  /** Per-item user metadata. See {@link UploadOptions.metadata}. */
  metadata?: Record<string, string>;
  /** Per-item multipart toggle/tuning. See {@link UploadOptions.multipart}. */
  multipart?: boolean | MultipartOptions;
}

export interface UploadManyResult {
  /** Successful uploads, in the order their items were supplied. */
  uploaded: UploadResult[];
  /** Per-item failures. Omitted entirely when every item succeeded. */
  errors?: BulkError[];
}

export interface UploadManyOptions extends BulkOptions {
  /**
   * Called as each item makes progress. Same semantics as
   * {@link UploadOptions.onProgress}, with the item's `key` added so callers
   * can attribute the report to a file when several upload concurrently.
   */
  onProgress?: (progress: UploadProgress & { key: string }) => void;
}

export interface DownloadManyOptions extends BulkOptions {
  /** Applied to every download. See {@link DownloadOptions.as}. */
  as?: "blob" | "stream";
}

export interface DownloadManyResult {
  /** Downloaded files, in the order their keys were supplied. */
  downloaded: StoredFile[];
  /** Per-key failures. Omitted entirely when every key succeeded. */
  errors?: BulkError[];
}

export interface HeadManyResult {
  /** Metadata results, in the order their keys were supplied. */
  files: StoredFile[];
  /** Per-key failures. Omitted entirely when every key succeeded. */
  errors?: BulkError[];
}

export interface ExistsManyResult {
  /** Keys that exist, in input order. */
  existing: string[];
  /** Keys the provider reports as missing, in input order. */
  missing: string[];
  /**
   * Keys whose existence couldn't be determined — a hard error (auth,
   * transport) rather than a clean present/absent answer. Omitted when none.
   */
  errors?: BulkError[];
}

export interface UrlOptions extends OperationOptions {
  /**
   * Override the adapter's default URL expiry, in seconds.
   *
   * **Honored** by adapters that sign (S3, Cloudflare R2 over HTTP, MinIO,
   * DigitalOcean Spaces, Storj, Hetzner, Akamai, Backblaze B2, Wasabi,
   * Tigris, and the R2 binding when HTTP credentials are also configured) — those
   * adapters return a presigned URL that expires after `expiresIn` seconds.
   *
   * **Ignored** by Vercel Blob (public): the underlying CDN URL has no
   * expiry, and the adapter returns it unchanged. If you need expiring
   * URLs there, you'll need a different provider — Vercel Blob has no
   * signing primitive.
   *
   * **N/A** for adapters where `url()` throws (Vercel Blob private; the
   * R2 binding without `publicBaseUrl` and without HTTP credentials).
   */
  expiresIn?: number;
  /**
   * Override the `Content-Disposition` header on the response.
   *
   * **Strongly recommended** for buckets that contain user-uploaded
   * content. Without this override, the browser uses the stored
   * Content-Type to decide whether to render or download, which means a
   * user-uploaded `.html` (or SVG with embedded scripts) will execute
   * inline at your bucket's origin — stored XSS in the trust context of
   * your domain. Pass `"attachment"` (or `'attachment; filename="..."'`)
   * to force a download.
   *
   * **Forces the signing path.** On signing adapters (S3, R2 HTTP, MinIO,
   * DigitalOcean Spaces, Storj, Hetzner, Akamai, Backblaze B2, Wasabi,
   * Tigris, R2 hybrid), passing this option always returns a
   * presigned URL —
   * even when `publicBaseUrl` is configured, because a permanent CDN URL
   * has no signature in which to bind the override. If `publicBaseUrl`
   * was the deliberate choice and you also need the security override,
   * the override wins (it's the safe default).
   *
   * **Throws** on Vercel Blob (no Content-Disposition primitive) and on
   * the R2 binding without HTTP credentials (can't sign). These cases
   * fail loudly rather than silently dropping the security ask.
   */
  responseContentDisposition?: string;
}

export interface SignUploadOptions extends OperationOptions {
  /**
   * How long the signed URL stays valid, in seconds. After it elapses, the
   * URL stops working and the client must request a new one.
   */
  expiresIn: number;
  /**
   * MIME type bound into the signature. The browser's PUT/POST must send a
   * matching `Content-Type` header or the provider rejects the upload.
   */
  contentType?: string;
  /**
   * Maximum upload size in bytes, enforced server-side.
   *
   * **Strongly recommended.** When omitted, the adapter falls back to a
   * presigned PUT URL with no server-side size limit — anyone with the URL
   * can upload an arbitrarily large file until `expiresIn` elapses. When set,
   * the adapter uses a presigned POST form (S3/R2) that enforces the size
   * via a `content-length-range` policy.
   */
  maxSize?: number;
  /**
   * Minimum upload size in bytes for the presigned POST policy. Defaults to
   * `1` — empty uploads are usually a sign of a broken client, and the most
   * common application assumption ("file present means real content") fails
   * silently when 0-byte objects can land. Pass `0` if you genuinely want to
   * allow empty uploads. Only used when `maxSize` is set (otherwise the
   * adapter falls back to a presigned PUT, which has no policy at all).
   */
  minSize?: number;
}

export type SignedUpload =
  | {
      method: "PUT";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      method: "POST";
      url: string;
      fields: Record<string, string>;
    };

export interface Adapter<Raw = unknown> {
  readonly name: string;
  readonly raw: Raw;
  /**
   * Set `true` when `upload` reports byte-level progress by calling
   * `opts.onProgress` itself (e.g. via a provider's native upload-progress
   * hook). The {@link Files} wrapper then defers progress entirely to the
   * adapter. When unset, the wrapper handles `onProgress` generically:
   * byte-level for `ReadableStream` bodies, start/finish for buffered ones.
   */
  readonly reportsUploadProgress?: boolean;
  upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult>;
  download(key: string, opts?: DownloadOptions): Promise<StoredFile>;
  /**
   * Fetch metadata only — does not transfer the body.
   *
   * **Note:** the returned `StoredFile` still exposes `text()` /
   * `arrayBuffer()` / `blob()` / `stream()`, but those accessors lazily
   * issue a full GET on first use. If you only want metadata, don't call
   * the body accessors. They are not free.
   */
  head(key: string, opts?: OperationOptions): Promise<StoredFile>;
  /**
   * Check whether `key` exists without fetching its body.
   *
   * Returns `true` when the object exists, `false` when the provider reports
   * `NotFound`, and rethrows every other error (permissions, transport
   * failures, bad credentials, etc.).
   */
  exists(key: string, opts?: OperationOptions): Promise<boolean>;
  delete(key: string, opts?: OperationOptions): Promise<void>;
  /**
   * Delete many keys in one call. Optional: when an adapter omits it, the
   * SDK fans out to `delete()` with bounded concurrency. Adapters that
   * implement it should use a native bulk primitive where one exists.
   */
  deleteMany?(
    keys: string[],
    opts?: DeleteManyOptions
  ): Promise<DeleteManyResult>;
  copy(from: string, to: string, opts?: OperationOptions): Promise<void>;
  list(opts?: ListOptions): Promise<ListResult>;
  /**
   * Return a URL the caller can use to fetch `key`.
   *
   * Adapters return the most direct URL they can produce:
   *
   * - **S3 / R2 (HTTP) / MinIO / DigitalOcean Spaces / Storj / Hetzner / Akamai / Backblaze B2 / Wasabi / Tigris** sign a `GetObject` request — the URL
   *   expires after `opts.expiresIn` seconds (or the adapter's default,
   *   typically 3600). If the adapter was constructed with
   *   `publicBaseUrl`, the URL is built against that origin instead and
   *   does not expire.
   * - **R2 (binding)** uses `publicBaseUrl` if configured, falls back to
   *   HTTP signing if HTTP credentials were also passed (hybrid mode),
   *   and otherwise throws.
   * - **Vercel Blob (public)** returns the permanent CDN URL.
   *   `expiresIn` is ignored.
   * - **Vercel Blob (private)** throws — there is no URL primitive for
   *   private blobs. Use `download()` instead.
   *
   * **Caller is responsible for URL-encoding.** Adapters do not escape
   * special characters in keys when building URLs against a
   * `publicBaseUrl` or Vercel Blob's fast path — the key is embedded
   * literally. If `key` is derived from untrusted input, callers should
   * validate or `encodeURIComponent`-style escape segments before
   * passing it in.
   */
  url(key: string, opts?: UrlOptions): Promise<string>;
  signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload>;
}

/** The public {@link Files} method a hook event describes. */
export type FilesActionType =
  | "upload"
  | "download"
  | "head"
  | "exists"
  | "delete"
  | "copy"
  | "list"
  | "url"
  | "signedUploadUrl";

/**
 * Delivered to {@link FilesHooks.onAction} once when a public operation
 * settles — on success and on failure. The array form of an operation reports
 * the caller's `keys` and emits a single event carrying the aggregated
 * `result` (any per-item failures live in that result's `errors`); the single
 * form reports `key`, or `from` / `to` for `copy`. Keys are always the ones
 * the caller passed, never the internal prefixed path.
 */
export interface FilesActionEvent {
  type: FilesActionType;
  /** Caller-facing key, for single-key operations. */
  key?: string;
  /** Caller-facing keys, for the array form. */
  keys?: string[];
  /** `copy` source / destination, as passed by the caller. */
  from?: string;
  to?: string;
  status: "success" | "error";
  /** The resolved value, on success. */
  result?: unknown;
  /** The error, on failure — also delivered to {@link FilesHooks.onError}. */
  error?: FilesError;
  /** Wall-clock duration of the public call, in milliseconds. */
  durationMs: number;
}

/**
 * Delivered to {@link FilesHooks.onError} when a public call rejects, just
 * before the matching `onAction({ status: "error" })`. Partial failures
 * collected in a bulk result's `errors[]` are not rejections and do not fire
 * it.
 */
export interface FilesErrorEvent {
  type: FilesActionType;
  key?: string;
  keys?: string[];
  from?: string;
  to?: string;
  error: FilesError;
  durationMs: number;
}

/**
 * Delivered to {@link FilesHooks.onRetry} each time the SDK schedules a retry
 * for a single-operation call. Not fired on the first attempt, for
 * non-retryable errors, or for stream uploads (which never retry); bulk calls
 * do not retry, so they never fire it either.
 */
export interface FilesRetryEvent {
  type: FilesActionType;
  key?: string;
  from?: string;
  to?: string;
  /** The retry about to be scheduled — `1` is the first retry. */
  attempt: number;
  /** Total retries allowed for this call. */
  maxRetries: number;
  /** Milliseconds the SDK will wait before that attempt. */
  delayMs: number;
  /** The error that triggered the retry. */
  error: FilesError;
}

/**
 * Observability callbacks for a {@link Files} instance, passed as
 * `new Files({ hooks })`. Each mirrors the lightweight
 * {@link UploadOptions.onProgress} style — caller-facing payloads, no internal
 * adapter detail — and is fire-and-forget: the SDK calls it but does not await
 * it, and a hook that throws can never fail the operation it observes.
 */
export interface FilesHooks {
  onAction?: (event: FilesActionEvent) => void;
  onError?: (event: FilesErrorEvent) => void;
  onRetry?: (event: FilesRetryEvent) => void;
}

export interface FilesOptions<A extends Adapter> extends OperationOptions {
  adapter: A;
  prefix?: string;
  /** Observability callbacks — see {@link FilesHooks}. */
  hooks?: FilesHooks;
}

export interface FileHandle {
  readonly key: string;
  upload(body: Body, opts?: UploadOptions): Promise<UploadResult>;
  download(opts?: DownloadOptions): Promise<StoredFile>;
  head(opts?: OperationOptions): Promise<StoredFile>;
  exists(opts?: OperationOptions): Promise<boolean>;
  delete(opts?: OperationOptions): Promise<void>;
  url(opts?: UrlOptions): Promise<string>;
  signedUploadUrl(opts: SignUploadOptions): Promise<SignedUpload>;
  copyTo(destinationKey: string, opts?: OperationOptions): Promise<void>;
  copyFrom(sourceKey: string, opts?: OperationOptions): Promise<void>;
}

const DEFAULT_RETRY_BACKOFF_MS = 100;
// Cap the built-in exponential backoff so a large `retries` count can't
// schedule an absurd sleep (and `2 ** attempt` can't overflow to Infinity).
// Only applies to the default curve — a caller-supplied `backoff` is theirs.
const MAX_DEFAULT_RETRY_BACKOFF_MS = 30_000;

const timeoutError = (timeout: number): FilesError =>
  new FilesError(
    "Provider",
    `Operation timed out after ${timeout}ms`,
    undefined,
    {
      aborted: true,
    }
  );

const mergeSignals = (
  signals: AbortSignal[],
  timeout?: number
): { signal?: AbortSignal; cleanup?: () => void } => {
  if (signals.length === 0 && (timeout ?? 0) <= 0) {
    return {};
  }
  if (signals.length === 1 && (timeout ?? 0) <= 0) {
    return { signal: signals[0] };
  }

  const controller = new AbortController();
  const listeners: (() => void)[] = [];
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal.reason);
    } else {
      const onAbort = () => abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      listeners.push(() => signal.removeEventListener("abort", onAbort));
    }
  }

  const timer =
    timeout !== undefined && timeout > 0
      ? setTimeout(() => {
          abort(timeoutError(timeout));
        }, timeout)
      : undefined;

  return {
    cleanup: () => {
      if (timer) {
        clearTimeout(timer);
      }
      for (const cleanup of listeners) {
        cleanup();
      }
    },
    signal: controller.signal,
  };
};

const abortError = (reason: unknown): FilesError => {
  if (reason instanceof FilesError) {
    return reason;
  }
  if (reason instanceof Error) {
    return new FilesError(
      "Provider",
      `Operation aborted: ${reason.message}`,
      reason,
      { aborted: true }
    );
  }
  return new FilesError(
    "Provider",
    reason === undefined
      ? "Operation aborted"
      : `Operation aborted: ${String(reason)}`,
    reason,
    { aborted: true }
  );
};

const runWithSignal = async <T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>
): Promise<T> => {
  if (!signal) {
    return await fn();
  }
  if (signal.aborted) {
    throw abortError(signal.reason);
  }

  // oxlint-disable-next-line promise/avoid-new -- AbortSignal needs callback interop.
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    fn()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
};

const sleep = async (
  ms: number,
  signal: AbortSignal | undefined
): Promise<void> => {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw abortError(signal.reason);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    // oxlint-disable-next-line promise/avoid-new -- setTimeout and AbortSignal are callback APIs.
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, ms);
      onAbort = () => {
        clearTimeout(timer);
        reject(abortError(signal?.reason));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
};

const maxRetries = (
  retries: RetryOptions | undefined,
  retryable: boolean
): number => {
  if (!retryable) {
    return 0;
  }
  const max = typeof retries === "number" ? retries : retries?.max;
  return Math.max(0, Math.floor(max ?? 0));
};

const retryBackoff = (
  retries: RetryOptions | undefined,
  attempt: number,
  error: FilesError
): number => {
  if (typeof retries === "object" && retries.backoff) {
    return Math.max(0, retries.backoff({ attempt, error }));
  }
  const backoff = DEFAULT_RETRY_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(MAX_DEFAULT_RETRY_BACKOFF_MS, backoff);
};

const canRetry = (
  error: FilesError,
  attempt: number,
  maxAttempts: number
): boolean =>
  attempt < maxAttempts && error.code === "Provider" && !error.aborted;

// Catch the obviously-broken cases at the SDK boundary so callers get a
// useful error from us instead of an opaque provider 400. We deliberately
// don't try to be exhaustive (length, allowed characters, leading slashes)
// — those rules differ across S3/R2/Vercel and we'd rather surface real
// provider errors than enforce the strictest superset.
const assertValidKey = (key: string, label = "key"): void => {
  if (typeof key !== "string" || key.length === 0) {
    throw new FilesError("Provider", `${label} must be a non-empty string`);
  }
  if (key.includes("\0")) {
    throw new FilesError("Provider", `${label} must not contain null bytes`);
  }
};

// Normalize the prefix the same way the rest of the SDK treats keys: no
// leading slash (S3/R2 store `/users/x` under a literal empty-named folder,
// which is never what callers want), and no trailing slash so we control the
// single separator when joining. `"/users/"`, `"users/"`, and `"users"` all
// collapse to `"users"`.
const normalizePrefix = (prefix: string | undefined): string => {
  if (prefix === undefined) {
    return "";
  }
  if (typeof prefix !== "string") {
    throw new FilesError("Provider", "prefix must be a string");
  }
  // The `(?<!\/)` before the trailing-slash run anchors each match to the
  // first slash of the run, so the engine can't re-attempt at every slash —
  // that backtracking is what makes a bare `\/+$` polynomial (ReDoS) on input
  // like `"users////…"`.
  const normalized = prefix.replaceAll(/^\/+|(?<!\/)\/+$/gu, "");
  assertValidKey(normalized, "prefix");
  return normalized;
};

/**
 * The caller-facing identity of an operation, shared by the action wrapper
 * (for `onAction` / `onError`) and {@link Files.#run} (for `onRetry`). Holds
 * only what the hook payloads expose — public keys, never internal paths.
 */
interface ActionContext {
  type: FilesActionType;
  key?: string;
  keys?: string[];
  from?: string;
  to?: string;
}

/**
 * Invoke a hook without letting it affect the operation it observes: a thrown
 * error is swallowed, and the return value is ignored — hooks are
 * fire-and-forget, like {@link UploadOptions.onProgress}.
 */
const emitHook = <E>(
  hook: ((event: E) => void) | undefined,
  event: E
): void => {
  if (!hook) {
    return;
  }
  try {
    hook(event);
  } catch {
    // Observability must not break the operation.
  }
};

export class Files<A extends Adapter = Adapter> {
  readonly #adapter: A;
  readonly #defaults: OperationOptions;
  readonly #hooks: FilesHooks | undefined;
  readonly #prefix: string;

  constructor(opts: FilesOptions<A>) {
    const { adapter, hooks, prefix, ...defaults } = opts;
    this.#adapter = adapter;
    this.#hooks = hooks;
    this.#prefix = normalizePrefix(prefix);
    this.#defaults = defaults;
  }

  /**
   * Wrap a public operation so it reports a single `onAction` event when it
   * settles, plus `onError` when it rejects. Short-circuits to the bare call
   * when neither hook is set, so the no-hooks path stays cheap. `onRetry` is
   * emitted separately, from {@link Files.#run}.
   */
  async #action<T>(ctx: ActionContext, fn: () => Promise<T>): Promise<T> {
    const hooks = this.#hooks;
    if (!(hooks?.onAction || hooks?.onError)) {
      return fn();
    }
    const startedAt = Date.now();
    try {
      const result = await fn();
      emitHook(hooks.onAction, {
        ...ctx,
        durationMs: Date.now() - startedAt,
        result,
        status: "success",
      });
      return result;
    } catch (error) {
      const wrapped = FilesError.wrap(error);
      const durationMs = Date.now() - startedAt;
      emitHook(hooks.onError, { ...ctx, durationMs, error: wrapped });
      emitHook(hooks.onAction, {
        ...ctx,
        durationMs,
        error: wrapped,
        status: "error",
      });
      throw wrapped;
    }
  }

  get raw(): A["raw"] {
    return this.#adapter.raw;
  }

  get adapter(): A {
    return this.#adapter;
  }

  file(key: string): FileHandle {
    assertValidKey(key);
    return {
      copyFrom: (sourceKey, opts) => this.copy(sourceKey, key, opts),
      copyTo: (destinationKey, opts) => this.copy(key, destinationKey, opts),
      delete: (opts) => this.delete(key, opts),
      download: (opts) => this.download(key, opts),
      exists: (opts) => this.exists(key, opts),
      head: (opts) => this.head(key, opts),
      key,
      signedUploadUrl: (opts) => this.signedUploadUrl(key, opts),
      upload: (body, opts) => this.upload(key, body, opts),
      url: (opts) => this.url(key, opts),
    };
  }

  /**
   * Upload one object or many.
   *
   * - `upload(key, body, opts)` stores a single object and resolves to its
   *   {@link UploadResult}. A failure **throws** a {@link FilesError}.
   * - `upload(items)` stores many in one call — each item carries its own
   *   `key`, `body`, and optional `contentType` / `cacheControl` / `metadata`
   *   — and resolves to an {@link UploadManyResult}. It does **not** throw on
   *   partial failure: successes land in `uploaded`, per-item failures
   *   (including invalid keys) in `errors`, both in the order supplied. The
   *   SDK fans out with bounded `concurrency` (default 8); `stopOnError`
   *   short-circuits at the first failure.
   *
   * Both forms honor the client's `prefix`; the array form reports the keys
   * the caller passed, not the internal prefixed paths.
   */
  upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult>;
  upload(
    items: UploadManyItem[],
    opts?: UploadManyOptions
  ): Promise<UploadManyResult>;
  upload(
    keyOrItems: string | UploadManyItem[],
    bodyOrOpts?: Body | UploadManyOptions,
    opts?: UploadOptions
  ): Promise<UploadResult | UploadManyResult> {
    if (Array.isArray(keyOrItems)) {
      const items = keyOrItems;
      const bulkOpts = bodyOrOpts as UploadManyOptions | undefined;
      return this.#action(
        { keys: items.map((item) => item.key), type: "upload" },
        () => this.#uploadMany(items, bulkOpts)
      );
    }
    const body = bodyOrOpts as Body;
    const ctx: ActionContext = { key: keyOrItems, type: "upload" };
    return this.#action(ctx, () =>
      this.#runUpload(keyOrItems, body, opts, ctx)
    );
  }

  /**
   * Run a single upload, threading {@link UploadOptions.onProgress} through.
   *
   * When the adapter reports progress itself
   * ({@link Adapter.reportsUploadProgress}) the callback is passed straight to
   * it. Otherwise the wrapper reports generically: a `ReadableStream` body is
   * wrapped so bytes are counted as the adapter drains it; a buffered body
   * brackets the call with a `0` and a final event.
   */
  #runUpload(
    key: string,
    body: Body,
    opts?: UploadOptions,
    ctx?: ActionContext
  ): Promise<UploadResult> {
    const path = this.#path(key);
    const isStream = body instanceof ReadableStream;
    const onProgress = opts?.onProgress;

    if (!onProgress || this.#adapter.reportsUploadProgress) {
      return this.#run(
        opts,
        async (attemptOpts) =>
          this.#uploadResult(
            await this.#adapter.upload(path, body, attemptOpts)
          ),
        !isStream,
        ctx
      );
    }

    // Generic progress: the adapter does not report it, so the wrapper does.
    // Strip `onProgress` from the options the adapter sees — it would ignore
    // it anyway, and dropping it keeps `total` ownership here.
    const { onProgress: _onProgress, ...rest } = opts ?? {};
    const total = byteLengthOf(body);

    if (isStream) {
      const tracked = countingStream(body, (loaded) =>
        onProgress(total === undefined ? { loaded } : { loaded, total })
      );
      return this.#run(
        rest,
        async (attemptOpts) =>
          this.#uploadResult(
            await this.#adapter.upload(path, tracked, attemptOpts)
          ),
        false,
        ctx
      );
    }

    onProgress(total === undefined ? { loaded: 0 } : { loaded: 0, total });
    return this.#run(
      rest,
      async (attemptOpts) => {
        const result = this.#uploadResult(
          await this.#adapter.upload(path, body, attemptOpts)
        );
        const done = total ?? result.size;
        onProgress({ loaded: done, total: done });
        return result;
      },
      true,
      ctx
    );
  }

  async #uploadMany(
    items: UploadManyItem[],
    opts?: UploadManyOptions
  ): Promise<UploadManyResult> {
    const onProgress = opts?.onProgress;
    const { errors, results } = await mapMany(
      items,
      (item) => item.key,
      (item) =>
        this.#runUpload(item.key, item.body, {
          cacheControl: item.cacheControl,
          contentType: item.contentType,
          metadata: item.metadata,
          ...(item.multipart !== undefined && { multipart: item.multipart }),
          ...(onProgress && {
            onProgress: (progress: UploadProgress) =>
              onProgress({ ...progress, key: item.key }),
          }),
        }),
      opts
    );
    return errors.length === 0
      ? { uploaded: results }
      : { errors, uploaded: results };
  }

  /**
   * Download one object or many.
   *
   * - `download(key, opts)` resolves to a single {@link StoredFile}; a missing
   *   key (or any failure) **throws** a {@link FilesError}.
   * - `download(keys, opts)` resolves to a {@link DownloadManyResult} and does
   *   **not** throw on partial failure: successes land in `downloaded`,
   *   per-key failures (a missing key included) in `errors`, both in input
   *   order. `as` applies to every download; the SDK fans out with bounded
   *   `concurrency` (default 8) and `stopOnError` stops at the first failure.
   *
   * Both forms honor the client's `prefix` and report the caller's keys.
   */
  download(key: string, opts?: DownloadOptions): Promise<StoredFile>;
  download(
    keys: string[],
    opts?: DownloadManyOptions
  ): Promise<DownloadManyResult>;
  download(
    keyOrKeys: string | string[],
    opts?: DownloadOptions | DownloadManyOptions
  ): Promise<StoredFile | DownloadManyResult> {
    if (Array.isArray(keyOrKeys)) {
      const keys = keyOrKeys;
      return this.#action({ keys, type: "download" }, () =>
        this.#downloadMany(keys, opts as DownloadManyOptions | undefined)
      );
    }
    const ctx: ActionContext = { key: keyOrKeys, type: "download" };
    return this.#action(ctx, () => {
      const path = this.#path(keyOrKeys);
      return this.#run(
        opts as DownloadOptions | undefined,
        async (attemptOpts) =>
          this.#storedFile(await this.#adapter.download(path, attemptOpts)),
        true,
        ctx
      );
    });
  }

  async #downloadMany(
    keys: string[],
    opts?: DownloadManyOptions
  ): Promise<DownloadManyResult> {
    const as = opts?.as;
    const { errors, results } = await mapMany(
      keys,
      (key) => key,
      async (key) =>
        this.#storedFile(
          await this.#adapter.download(this.#path(key), as ? { as } : undefined)
        ),
      opts
    );
    return errors.length === 0
      ? { downloaded: results }
      : { downloaded: results, errors };
  }

  /**
   * Fetch metadata only — does not transfer the body. Pass one key for a
   * single {@link StoredFile} (throws on failure), or an array for a
   * {@link HeadManyResult} (`files` + per-key `errors`, never throws on
   * partial failure; honors `concurrency` / `stopOnError`).
   *
   * **Note:** the returned `StoredFile` still exposes `text()` /
   * `arrayBuffer()` / `blob()` / `stream()`, but those accessors lazily
   * issue a full GET on first use. If you only want metadata, don't call
   * the body accessors. They are not free.
   */
  head(key: string, opts?: OperationOptions): Promise<StoredFile>;
  head(keys: string[], opts?: BulkOptions): Promise<HeadManyResult>;
  head(
    keyOrKeys: string | string[],
    opts?: OperationOptions | BulkOptions
  ): Promise<StoredFile | HeadManyResult> {
    if (Array.isArray(keyOrKeys)) {
      const keys = keyOrKeys;
      return this.#action({ keys, type: "head" }, () =>
        this.#headMany(keys, opts as BulkOptions | undefined)
      );
    }
    const ctx: ActionContext = { key: keyOrKeys, type: "head" };
    return this.#action(ctx, () => {
      const path = this.#path(keyOrKeys);
      return this.#run(
        opts as OperationOptions | undefined,
        async (attemptOpts) =>
          this.#storedFile(await this.#adapter.head(path, attemptOpts)),
        true,
        ctx
      );
    });
  }

  async #headMany(keys: string[], opts?: BulkOptions): Promise<HeadManyResult> {
    const { errors, results } = await mapMany(
      keys,
      (key) => key,
      async (key) =>
        this.#storedFile(await this.#adapter.head(this.#path(key))),
      opts
    );
    return errors.length === 0
      ? { files: results }
      : { errors, files: results };
  }

  /**
   * Check whether one key or many exist, without fetching bodies.
   *
   * - `exists(key)` resolves to `true` when the object exists and `false` when
   *   the adapter reports `NotFound`. Other failures still propagate so
   *   callers do not treat auth or transport errors as "missing file".
   * - `exists(keys)` resolves to an {@link ExistsManyResult}: keys split into
   *   `existing` / `missing` (both in input order), with hard errors (auth,
   *   transport) collected in `errors` rather than thrown. The SDK fans out
   *   with bounded `concurrency` (default 8); `stopOnError` stops at the first
   *   hard error.
   */
  exists(key: string, opts?: OperationOptions): Promise<boolean>;
  exists(keys: string[], opts?: BulkOptions): Promise<ExistsManyResult>;
  exists(
    keyOrKeys: string | string[],
    opts?: OperationOptions | BulkOptions
  ): Promise<boolean | ExistsManyResult> {
    if (Array.isArray(keyOrKeys)) {
      const keys = keyOrKeys;
      return this.#action({ keys, type: "exists" }, () =>
        this.#existsMany(keys, opts as BulkOptions | undefined)
      );
    }
    const ctx: ActionContext = { key: keyOrKeys, type: "exists" };
    return this.#action(ctx, () => {
      const path = this.#path(keyOrKeys);
      return this.#run(
        opts as OperationOptions | undefined,
        (attemptOpts) => this.#adapter.exists(path, attemptOpts),
        true,
        ctx
      );
    });
  }

  async #existsMany(
    keys: string[],
    opts?: BulkOptions
  ): Promise<ExistsManyResult> {
    const { errors, results } = await mapMany(
      keys,
      (key) => key,
      async (key) => ({
        exists: await this.#adapter.exists(this.#path(key)),
        key,
      }),
      opts
    );
    const existing: string[] = [];
    const missing: string[] = [];
    for (const result of results) {
      (result.exists ? existing : missing).push(result.key);
    }
    return errors.length === 0
      ? { existing, missing }
      : { errors, existing, missing };
  }

  /**
   * Remove one key or many.
   *
   * - `delete(key)` removes a single object and resolves to `void`. A failure
   *   (including a missing key on providers that don't treat delete as
   *   idempotent) **throws** a {@link FilesError}.
   * - `delete(keys)` removes many in one call and resolves to a
   *   {@link DeleteManyResult}. It does **not** throw on partial failure —
   *   per-key failures (and invalid keys) are collected in `errors`, deleted
   *   keys in `deleted`, both in the order supplied. The adapter's native
   *   bulk primitive is used when available, otherwise the SDK fans out to
   *   single deletes with bounded `concurrency`. With `stopOnError`, the first
   *   failure short-circuits and returns the keys deleted so far plus that
   *   error.
   *
   * Both forms honor the client's `prefix`; the array form reports the keys
   * the caller passed, not the internal prefixed paths.
   */
  delete(key: string, opts?: OperationOptions): Promise<void>;
  delete(keys: string[], opts?: DeleteManyOptions): Promise<DeleteManyResult>;
  delete(
    key: string | string[],
    opts?: OperationOptions | DeleteManyOptions
  ): Promise<void | DeleteManyResult> {
    if (Array.isArray(key)) {
      const keys = key;
      return this.#action({ keys, type: "delete" }, () =>
        this.#deleteMany(keys, opts as DeleteManyOptions | undefined)
      );
    }
    const ctx: ActionContext = { key, type: "delete" };
    return this.#action(ctx, () => {
      const path = this.#path(key);
      return this.#run(
        opts as OperationOptions | undefined,
        (attemptOpts) => this.#adapter.delete(path, attemptOpts),
        true,
        ctx
      );
    });
  }

  async #deleteMany(
    keys: string[],
    opts?: DeleteManyOptions
  ): Promise<DeleteManyResult> {
    // Track each error's position in the caller's array so the final
    // `errors` list stays in input order, even when invalid keys (caught
    // here) interleave with provider failures (reported by the adapter).
    const errors: (DeleteManyError & { index: number })[] = [];
    // Adapters operate on prefixed paths; map each back so the result
    // reflects the keys the caller passed, not the internal path.
    const paths: string[] = [];
    const keyByPath = new Map<string, string>();
    const indexByPath = new Map<string, number>();

    for (const [index, key] of keys.entries()) {
      let path: string;
      try {
        path = this.#path(key);
      } catch (error) {
        if (opts?.stopOnError) {
          // Short-circuit before any delete is attempted.
          return {
            deleted: [],
            errors: [{ error: FilesError.wrap(error), key: String(key) }],
          };
        }
        errors.push({ error: FilesError.wrap(error), index, key: String(key) });
        continue;
      }
      paths.push(path);
      if (!keyByPath.has(path)) {
        keyByPath.set(path, key);
        indexByPath.set(path, index);
      }
    }

    const toKey = (path: string): string => keyByPath.get(path) ?? path;

    const result = this.#adapter.deleteMany
      ? await this.#adapter.deleteMany(paths, opts)
      : await deleteManyWithFallback(
          paths,
          (path) => this.#adapter.delete(path),
          opts
        );

    const deleted = result.deleted.map(toKey);
    for (const entry of result.errors ?? []) {
      errors.push({
        error: entry.error,
        index: indexByPath.get(entry.key) ?? Number.MAX_SAFE_INTEGER,
        key: toKey(entry.key),
      });
    }

    if (errors.length === 0) {
      return { deleted };
    }
    errors.sort((a, b) => a.index - b.index);
    return {
      deleted,
      errors: errors.map(({ error, key }) => ({ error, key })),
    };
  }

  copy(from: string, to: string, opts?: OperationOptions): Promise<void> {
    const ctx: ActionContext = { from, to, type: "copy" };
    return this.#action(ctx, () => {
      const fromPath = this.#path(from, "copy source");
      const toPath = this.#path(to, "copy destination");
      return this.#run(
        opts,
        (attemptOpts) => this.#adapter.copy(fromPath, toPath, attemptOpts),
        true,
        ctx
      );
    });
  }

  list(opts?: ListOptions): Promise<ListResult> {
    const ctx: ActionContext = { type: "list" };
    return this.#action(ctx, () => {
      if (!this.#prefix) {
        return this.#run(
          opts,
          (attemptOpts) => this.#adapter.list(attemptOpts),
          true,
          ctx
        );
      }
      const prefix = opts?.prefix
        ? `${this.#prefix}/${opts.prefix.replace(/^\/+/u, "")}`
        : `${this.#prefix}/`;
      return this.#run(
        opts,
        async (attemptOpts) => {
          const result = await this.#adapter.list({ ...attemptOpts, prefix });
          return {
            ...result,
            items: result.items.map((item) => this.#storedFile(item)),
          };
        },
        true,
        ctx
      );
    });
  }

  /**
   * Return a URL the caller can use to fetch `key`.
   *
   * The exact URL kind depends on the adapter — see {@link Adapter.url}
   * for the per-provider behavior. In short: signing adapters (S3, R2
   * HTTP, MinIO, DigitalOcean Spaces, Storj, Hetzner, Akamai, Backblaze B2,
   * Wasabi, Tigris) return an expiring presigned URL by default;
   * Vercel-Blob-public returns its permanent CDN URL; configurations
   * with no URL primitive (Vercel-Blob-private, R2 binding without
   * `publicBaseUrl`/HTTP creds) throw.
   *
   * **Caller is responsible for URL-encoding.** Adapters do not escape
   * special characters in keys when building URLs against a
   * `publicBaseUrl` or Vercel Blob's fast path. If `key` is derived
   * from untrusted input, callers should validate or escape it.
   */
  url(key: string, opts?: UrlOptions): Promise<string> {
    const ctx: ActionContext = { key, type: "url" };
    return this.#action(ctx, () => {
      const path = this.#path(key);
      return this.#run(
        opts,
        (attemptOpts) => this.#adapter.url(path, attemptOpts),
        true,
        ctx
      );
    });
  }

  signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload> {
    const ctx: ActionContext = { key, type: "signedUploadUrl" };
    return this.#action(ctx, () => {
      const path = this.#path(key);
      return this.#run(
        opts,
        (attemptOpts) =>
          this.#adapter.signedUploadUrl(path, attemptOpts as SignUploadOptions),
        true,
        ctx
      );
    });
  }

  async #run<O extends OperationOptions, T>(
    opts: O | undefined,
    fn: (opts: O | undefined) => Promise<T>,
    retryable = true,
    ctx?: ActionContext
  ): Promise<T> {
    const { retries: _retries, timeout: _timeout, ...adapterOpts } = opts ?? {};
    const baseOpts = opts ? (adapterOpts as O) : undefined;
    const retryOptions = opts?.retries ?? this.#defaults.retries;
    const maxAttempts = maxRetries(retryOptions, retryable);
    const signals = [this.#defaults.signal, opts?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );

    for (let attempt = 0; ; attempt += 1) {
      const runtime = mergeSignals(
        signals,
        opts?.timeout ?? this.#defaults.timeout
      );
      const attemptOpts = runtime.signal
        ? ({ ...baseOpts, signal: runtime.signal } as O)
        : baseOpts;
      try {
        return await runWithSignal(runtime.signal, () => fn(attemptOpts));
      } catch (error) {
        const wrapped = runtime.signal?.aborted
          ? abortError(runtime.signal.reason)
          : FilesError.wrap(error);
        if (!canRetry(wrapped, attempt, maxAttempts)) {
          throw wrapped;
        }
        const delayMs = retryBackoff(retryOptions, attempt + 1, wrapped);
        if (ctx && this.#hooks?.onRetry) {
          emitHook(this.#hooks.onRetry, {
            attempt: attempt + 1,
            delayMs,
            error: wrapped,
            from: ctx.from,
            key: ctx.key,
            maxRetries: maxAttempts,
            to: ctx.to,
            type: ctx.type,
          });
        }
        const wait = mergeSignals(signals);
        try {
          await sleep(delayMs, wait.signal);
        } finally {
          wait.cleanup?.();
        }
      } finally {
        runtime.cleanup?.();
      }
    }
  }

  #path(key: string, label = "key"): string {
    assertValidKey(key, label);
    return this.#prefix ? `${this.#prefix}/${key.replace(/^\/+/u, "")}` : key;
  }

  #storedFile(file: StoredFile): StoredFile {
    if (!this.#prefix) {
      return file;
    }
    // `name` is an alias for the full key (see createStoredFile), so strip it
    // alongside `key` — otherwise the result is internally inconsistent.
    return {
      ...file,
      key: this.#stripPrefix(file.key),
      name: this.#stripPrefix(file.name),
    };
  }

  #uploadResult(result: UploadResult): UploadResult {
    return this.#prefix
      ? { ...result, key: this.#stripPrefix(result.key) }
      : result;
  }

  #stripPrefix(key: string): string {
    const scoped = `${this.#prefix}/`;
    return key.startsWith(scoped) ? key.slice(scoped.length) : key;
  }
}
