import { FilesError } from "./internal/errors.js";

export { FilesError, type FilesErrorCode } from "./internal/errors.js";
export { createStoredFile } from "./internal/stored-file.js";
export type { StoredFileMeta, BodySource } from "./internal/stored-file.js";

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
   * Per-attempt timeout in milliseconds. `0` or a negative value disables
   * timeout handling.
   */
  timeout?: number;
  /**
   * Retry provider failures. A number is treated as `{ max: number }`.
   */
  retries?: RetryOptions;
}

export interface UploadOptions extends OperationOptions {
  contentType?: string;
  cacheControl?: string;
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
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface ListResult {
  items: StoredFile[];
  cursor?: string;
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
  expiresIn: number;
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
  const backoff =
    typeof retries === "object" && retries.backoff
      ? retries.backoff({ attempt, error })
      : DEFAULT_RETRY_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.max(0, backoff);
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

export class Files<A extends Adapter = Adapter> {
  readonly #adapter: A;
  readonly #defaults: OperationOptions;

  constructor(opts: FilesOptions<A>) {
    const { adapter, ...defaults } = opts;
    this.#adapter = adapter;
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

  upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult> {
    assertValidKey(key);
    return this.#run(
      opts,
      (attemptOpts) => this.#adapter.upload(key, body, attemptOpts),
      !(body instanceof ReadableStream)
    );
  }

  download(key: string, opts?: DownloadOptions): Promise<StoredFile> {
    assertValidKey(key);
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.download(key, attemptOpts)
    );
  }

  /**
   * Fetch metadata only — does not transfer the body.
   *
   * **Note:** the returned `StoredFile` still exposes `text()` /
   * `arrayBuffer()` / `blob()` / `stream()`, but those accessors lazily
   * issue a full GET on first use. If you only want metadata, don't call
   * the body accessors. They are not free.
   */
  head(key: string, opts?: OperationOptions): Promise<StoredFile> {
    assertValidKey(key);
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.head(key, attemptOpts)
    );
  }

  /**
   * Check whether `key` exists without fetching its body.
   *
   * Returns `true` when the object exists and `false` when the adapter
   * reports `NotFound`. Other failures still propagate so callers do not
   * accidentally treat auth or transport errors as "missing file".
   */
  exists(key: string, opts?: OperationOptions): Promise<boolean> {
    assertValidKey(key);
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.exists(key, attemptOpts)
    );
  }

  delete(key: string, opts?: OperationOptions): Promise<void> {
    assertValidKey(key);
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.delete(key, attemptOpts)
    );
  }

  copy(from: string, to: string, opts?: OperationOptions): Promise<void> {
    assertValidKey(from, "copy source");
    assertValidKey(to, "copy destination");
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.copy(from, to, attemptOpts)
    );
  }

  list(opts?: ListOptions): Promise<ListResult> {
    return this.#run(opts, (attemptOpts) => this.#adapter.list(attemptOpts));
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
    assertValidKey(key);
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.url(key, attemptOpts)
    );
  }

  signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload> {
    assertValidKey(key);
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.signedUploadUrl(key, attemptOpts as SignUploadOptions)
    );
  }

  async #run<O extends OperationOptions, T>(
    opts: O | undefined,
    fn: (opts: O | undefined) => Promise<T>,
    retryable = true
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
        const wait = mergeSignals(signals);
        try {
          await sleep(
            retryBackoff(retryOptions, attempt + 1, wrapped),
            wait.signal
          );
        } finally {
          wait.cleanup?.();
        }
      } finally {
        runtime.cleanup?.();
      }
    }
  }
}
