import { deleteManyWithFallback, mapMany } from "./internal/core.js";
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
}

export interface UploadManyResult {
  /** Successful uploads, in the order their items were supplied. */
  uploaded: UploadResult[];
  /** Per-item failures. Omitted entirely when every item succeeded. */
  errors?: BulkError[];
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

export interface FilesHookOptions {
  as?: "blob" | "stream";
  cacheControl?: string;
  concurrency?: number;
  contentType?: string;
  cursor?: string;
  expiresIn?: number;
  limit?: number;
  maxSize?: number;
  metadata?: Record<string, string>;
  minSize?: number;
  prefix?: string;
  responseContentDisposition?: string;
  retries?: RetryOptions;
  stopOnError?: boolean;
  timeout?: number;
}

export interface FilesBodySummary {
  kind:
    | "arrayBuffer"
    | "arrayBufferView"
    | "blob"
    | "file"
    | "stream"
    | "string"
    | "uint8Array";
  contentType?: string;
  name?: string;
  size?: number;
}

export interface FilesUploadItemSummary {
  body: FilesBodySummary;
  cacheControl?: string;
  contentType?: string;
  key: string;
  metadata?: Record<string, string>;
  path?: string;
}

export type FilesActionInput =
  | {
      body: FilesBodySummary;
    }
  | {
      items: FilesUploadItemSummary[];
    };

export interface FilesHookEventBase {
  adapter: string;
  attemptCount: number;
  bulk: boolean;
  durationMs: number;
  effectivePrefix?: string;
  endedAt: number;
  from?: string;
  fromPath?: string;
  input?: FilesActionInput;
  key?: string;
  keys?: string[];
  options?: FilesHookOptions;
  path?: string;
  paths?: (string | undefined)[];
  requestedPrefix?: string;
  startedAt: number;
  to?: string;
  toPath?: string;
  type: FilesActionType;
}

export interface FilesActionEvent extends FilesHookEventBase {
  error?: FilesError;
  result?: unknown;
  status: "error" | "success";
}

export interface FilesErrorEvent extends FilesHookEventBase {
  error: FilesError;
}

export interface FilesRetryEvent {
  adapter: string;
  attempt: number;
  bulk: boolean;
  delayMs: number;
  effectivePrefix?: string;
  error: FilesError;
  from?: string;
  fromPath?: string;
  input?: FilesActionInput;
  key?: string;
  keys?: string[];
  maxRetries: number;
  options?: FilesHookOptions;
  path?: string;
  paths?: (string | undefined)[];
  requestedPrefix?: string;
  to?: string;
  toPath?: string;
  type: FilesActionType;
}

export interface FilesHooks {
  onAction?: (event: FilesActionEvent) => void | Promise<void>;
  onError?: (event: FilesErrorEvent) => void | Promise<void>;
  onRetry?: (event: FilesRetryEvent) => void | Promise<void>;
}

export interface Adapter<Raw = unknown> {
  readonly name: string;
  readonly raw: Raw;
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

export interface FilesOptions<A extends Adapter> extends OperationOptions {
  adapter: A;
  hooks?: FilesHooks;
  prefix?: string;
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

interface HookContext {
  attemptCount?: number;
  bulk: boolean;
  effectivePrefix?: string;
  from?: string;
  fromPath?: string;
  input?: FilesActionInput;
  key?: string;
  keys?: string[];
  options?: FilesHookOptions;
  path?: string;
  paths?: (string | undefined)[];
  requestedPrefix?: string;
  to?: string;
  toPath?: string;
  type: FilesActionType;
}

const summarizeBody = (body: Body): FilesBodySummary => {
  if (typeof body === "string") {
    return {
      contentType: "text/plain; charset=utf-8",
      kind: "string",
      size: new TextEncoder().encode(body).byteLength,
    };
  }
  if (body instanceof Uint8Array) {
    return { kind: "uint8Array", size: body.byteLength };
  }
  if (body instanceof ArrayBuffer) {
    return { kind: "arrayBuffer", size: body.byteLength };
  }
  if (ArrayBuffer.isView(body)) {
    return { kind: "arrayBufferView", size: body.byteLength };
  }
  if (typeof File !== "undefined" && body instanceof File) {
    return {
      contentType: body.type || undefined,
      kind: "file",
      name: body.name,
      size: body.size,
    };
  }
  if (body instanceof Blob) {
    return {
      contentType: body.type || undefined,
      kind: "blob",
      size: body.size,
    };
  }
  return { kind: "stream" };
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
    opts?: BulkOptions
  ): Promise<UploadManyResult>;
  upload(
    keyOrItems: string | UploadManyItem[],
    bodyOrOpts?: Body | BulkOptions,
    opts?: UploadOptions
  ): Promise<UploadResult | UploadManyResult> {
    if (Array.isArray(keyOrItems)) {
      const bulkOpts = bodyOrOpts as BulkOptions | undefined;
      return this.#withAction(
        {
          bulk: true,
          input: {
            items: keyOrItems.map((item) => ({
              body: summarizeBody(item.body),
              cacheControl: item.cacheControl,
              contentType: item.contentType,
              key: item.key,
              metadata: item.metadata,
              path: this.#safePath(item.key),
            })),
          },
          keys: keyOrItems.map((item) => item.key),
          options: this.#sanitizeOptions(bulkOpts),
          paths: keyOrItems.map((item) => this.#safePath(item.key)),
          type: "upload",
        },
        () => this.#uploadMany(keyOrItems, bulkOpts)
      );
    }
    const body = bodyOrOpts as Body;
    return this.#withAction(
      {
        bulk: false,
        input: { body: summarizeBody(body) },
        key: keyOrItems,
        options: this.#operationOptions(opts),
        type: "upload",
      },
      async (ctx) => {
        const path = this.#path(keyOrItems);
        ctx.path = path;
        return await this.#run(
          ctx,
          opts,
          async (attemptOpts) =>
            this.#uploadResult(
              await this.#adapter.upload(path, body, attemptOpts)
            ),
          !(body instanceof ReadableStream)
        );
      }
    );
  }

  async #uploadMany(
    items: UploadManyItem[],
    opts?: BulkOptions
  ): Promise<UploadManyResult> {
    const { errors, results } = await mapMany(
      items,
      (item) => item.key,
      async (item) =>
        this.#uploadResult(
          await this.#adapter.upload(this.#path(item.key), item.body, {
            cacheControl: item.cacheControl,
            contentType: item.contentType,
            metadata: item.metadata,
          })
        ),
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
      const bulkOpts = opts as DownloadManyOptions | undefined;
      return this.#withAction(
        {
          bulk: true,
          keys: keyOrKeys,
          options: this.#sanitizeOptions(bulkOpts),
          paths: this.#safePaths(keyOrKeys),
          type: "download",
        },
        () =>
          this.#downloadMany(
            keyOrKeys,
            bulkOpts
          )
      );
    }
    return this.#withAction(
      {
        bulk: false,
        key: keyOrKeys,
        options: this.#operationOptions(opts as DownloadOptions | undefined),
        type: "download",
      },
      async (ctx) => {
        const path = this.#path(keyOrKeys);
        ctx.path = path;
        return await this.#run(
          ctx,
          opts as DownloadOptions | undefined,
          async (attemptOpts) =>
            this.#storedFile(await this.#adapter.download(path, attemptOpts))
        );
      }
    );
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
      const bulkOpts = opts as BulkOptions | undefined;
      return this.#withAction(
        {
          bulk: true,
          keys: keyOrKeys,
          options: this.#sanitizeOptions(bulkOpts),
          paths: this.#safePaths(keyOrKeys),
          type: "head",
        },
        () => this.#headMany(keyOrKeys, bulkOpts)
      );
    }
    return this.#withAction(
      {
        bulk: false,
        key: keyOrKeys,
        options: this.#operationOptions(opts as OperationOptions | undefined),
        type: "head",
      },
      async (ctx) => {
        const path = this.#path(keyOrKeys);
        ctx.path = path;
        return await this.#run(
          ctx,
          opts as OperationOptions | undefined,
          async (attemptOpts) =>
            this.#storedFile(await this.#adapter.head(path, attemptOpts))
        );
      }
    );
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
      const bulkOpts = opts as BulkOptions | undefined;
      return this.#withAction(
        {
          bulk: true,
          keys: keyOrKeys,
          options: this.#sanitizeOptions(bulkOpts),
          paths: this.#safePaths(keyOrKeys),
          type: "exists",
        },
        () => this.#existsMany(keyOrKeys, bulkOpts)
      );
    }
    return this.#withAction(
      {
        bulk: false,
        key: keyOrKeys,
        options: this.#operationOptions(opts as OperationOptions | undefined),
        type: "exists",
      },
      async (ctx) => {
        const path = this.#path(keyOrKeys);
        ctx.path = path;
        return await this.#run(
          ctx,
          opts as OperationOptions | undefined,
          (attemptOpts) => this.#adapter.exists(path, attemptOpts)
        );
      }
    );
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
      const bulkOpts = opts as DeleteManyOptions | undefined;
      return this.#withAction(
        {
          bulk: true,
          keys: key,
          options: this.#sanitizeOptions(bulkOpts),
          paths: this.#safePaths(key),
          type: "delete",
        },
        () => this.#deleteMany(key, bulkOpts)
      );
    }
    return this.#withAction(
      {
        bulk: false,
        key,
        options: this.#operationOptions(opts as OperationOptions | undefined),
        type: "delete",
      },
      async (ctx) => {
        const path = this.#path(key);
        ctx.path = path;
        return await this.#run(
          ctx,
          opts as OperationOptions | undefined,
          (attemptOpts) => this.#adapter.delete(path, attemptOpts)
        );
      }
    );
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
    return this.#withAction(
      {
        bulk: false,
        from,
        options: this.#operationOptions(opts),
        to,
        type: "copy",
      },
      async (ctx) => {
        const fromPath = this.#path(from, "copy source");
        const toPath = this.#path(to, "copy destination");
        ctx.fromPath = fromPath;
        ctx.toPath = toPath;
        return await this.#run(ctx, opts, (attemptOpts) =>
          this.#adapter.copy(fromPath, toPath, attemptOpts)
        );
      }
    );
  }

  list(opts?: ListOptions): Promise<ListResult> {
    return this.#withAction(
      {
        bulk: false,
        effectivePrefix: this.#listPrefix(opts),
        options: this.#operationOptions(opts),
        requestedPrefix: opts?.prefix,
        type: "list",
      },
      (ctx) =>
        this.#run(ctx, opts, async (attemptOpts) => {
          if (!this.#prefix) {
            return await this.#adapter.list(attemptOpts);
          }
          const prefix = this.#listPrefix(opts);
          ctx.effectivePrefix = prefix;
          const result = await this.#adapter.list({ ...attemptOpts, prefix });
          return {
            ...result,
            items: result.items.map((item) => this.#storedFile(item)),
          };
        })
    );
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
    return this.#withAction(
      {
        bulk: false,
        key,
        options: this.#operationOptions(opts),
        type: "url",
      },
      async (ctx) => {
        const path = this.#path(key);
        ctx.path = path;
        return await this.#run(ctx, opts, (attemptOpts) =>
          this.#adapter.url(path, attemptOpts)
        );
      }
    );
  }

  signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload> {
    return this.#withAction(
      {
        bulk: false,
        key,
        options: this.#operationOptions(opts),
        type: "signedUploadUrl",
      },
      async (ctx) => {
        const path = this.#path(key);
        ctx.path = path;
        return await this.#run(ctx, opts, (attemptOpts) =>
          this.#adapter.signedUploadUrl(path, attemptOpts as SignUploadOptions)
        );
      }
    );
  }

  async #run<O extends OperationOptions, T>(
    ctx: HookContext,
    opts: O | undefined,
    fn: (opts: O | undefined) => Promise<T>,
    retryable = true
  ): Promise<T> {
    const { retries: _retries, timeout: _timeout, ...adapterOpts } = opts ?? {};
    const baseOpts = opts ? (adapterOpts as O) : undefined;
    const retryOptions = opts?.retries ?? this.#defaults.retries;
    const retryCount = maxRetries(retryOptions, retryable);
    const signals = [this.#defaults.signal, opts?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );

    for (let attempt = 0; ; attempt += 1) {
      ctx.attemptCount = attempt + 1;
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
        if (!canRetry(wrapped, attempt, retryCount)) {
          throw wrapped;
        }
        const delayMs = retryBackoff(retryOptions, attempt + 1, wrapped);
        await this.#runHook(this.#hooks?.onRetry, {
          adapter: this.#adapter.name,
          attempt: attempt + 1,
          bulk: ctx.bulk,
          delayMs,
          effectivePrefix: ctx.effectivePrefix,
          error: wrapped,
          from: ctx.from,
          fromPath: ctx.fromPath,
          input: ctx.input,
          key: ctx.key,
          keys: ctx.keys,
          maxRetries: retryCount,
          options: ctx.options,
          path: ctx.path,
          paths: ctx.paths,
          requestedPrefix: ctx.requestedPrefix,
          to: ctx.to,
          toPath: ctx.toPath,
          type: ctx.type,
        });
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

  async #withAction<T>(
    ctx: HookContext,
    fn: (ctx: HookContext) => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await fn(ctx);
      const endedAt = Date.now();
      await this.#runHook(this.#hooks?.onAction, {
        ...this.#eventBase(ctx, startedAt, endedAt),
        result,
        status: "success",
      });
      return result;
    } catch (error) {
      const wrapped = FilesError.wrap(error);
      const endedAt = Date.now();
      const base = this.#eventBase(ctx, startedAt, endedAt);
      await this.#runHook(this.#hooks?.onError, { ...base, error: wrapped });
      await this.#runHook(this.#hooks?.onAction, {
        ...base,
        error: wrapped,
        status: "error",
      });
      throw wrapped;
    }
  }

  #path(key: string, label = "key"): string {
    assertValidKey(key, label);
    return this.#prefix ? `${this.#prefix}/${key.replace(/^\/+/u, "")}` : key;
  }

  #safePath(key: string): string | undefined {
    try {
      return this.#path(key);
    } catch {
      return undefined;
    }
  }

  #safePaths(keys: string[]): (string | undefined)[] {
    return keys.map((key) => this.#safePath(key));
  }

  #listPrefix(opts?: ListOptions): string | undefined {
    if (!this.#prefix) {
      return opts?.prefix;
    }
    return opts?.prefix
      ? `${this.#prefix}/${opts.prefix.replace(/^\/+/u, "")}`
      : `${this.#prefix}/`;
  }

  #sanitizeOptions(opts: object | undefined): FilesHookOptions | undefined {
    if (!opts) {
      return undefined;
    }
    const { signal: _signal, ...rest } = opts as {
      signal?: AbortSignal;
      [key: string]: unknown;
    };
    const entries = Object.entries(rest).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(entries) as FilesHookOptions;
  }

  #operationOptions(opts: object | undefined): FilesHookOptions | undefined {
    const defaults = this.#sanitizeOptions(this.#defaults);
    const call = this.#sanitizeOptions(opts);
    if (!defaults && !call) {
      return undefined;
    }
    return {
      ...(defaults ?? {}),
      ...(call ?? {}),
    };
  }

  #eventBase(
    ctx: HookContext,
    startedAt: number,
    endedAt: number
  ): FilesHookEventBase {
    return {
      adapter: this.#adapter.name,
      attemptCount: ctx.attemptCount ?? 1,
      bulk: ctx.bulk,
      durationMs: endedAt - startedAt,
      effectivePrefix: ctx.effectivePrefix,
      endedAt,
      from: ctx.from,
      fromPath: ctx.fromPath,
      input: ctx.input,
      key: ctx.key,
      keys: ctx.keys,
      options: ctx.options,
      path: ctx.path,
      paths: ctx.paths,
      requestedPrefix: ctx.requestedPrefix,
      startedAt,
      to: ctx.to,
      toPath: ctx.toPath,
      type: ctx.type,
    };
  }

  async #runHook<Event>(
    hook: ((event: Event) => void | Promise<void>) | undefined,
    event: Event
  ): Promise<void> {
    if (!hook) {
      return;
    }
    try {
      await hook(event);
    } catch {
      // Hook failures are intentionally isolated from the main operation.
    }
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
