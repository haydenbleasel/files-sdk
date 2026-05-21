import { deleteManyWithFallback } from "./internal/core.js";
import { FilesError } from "./internal/errors.js";

export { FilesError, type FilesErrorCode } from "./internal/errors.js";
export type { BodySource, StoredFileMeta } from "./internal/stored-file.js";
export { createStoredFile } from "./internal/stored-file.js";

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
  const normalized = prefix.replaceAll(/^\/+|\/+$/gu, "");
  assertValidKey(normalized, "prefix");
  return normalized;
};

export class Files<A extends Adapter = Adapter> {
  readonly #adapter: A;
  readonly #defaults: OperationOptions;
  readonly #prefix: string;

  constructor(opts: FilesOptions<A>) {
    const { adapter, prefix, ...defaults } = opts;
    this.#adapter = adapter;
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

  upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult> {
    const path = this.#path(key);
    return this.#run(
      opts,
      async (attemptOpts) =>
        this.#uploadResult(await this.#adapter.upload(path, body, attemptOpts)),
      !(body instanceof ReadableStream)
    );
  }

  download(key: string, opts?: DownloadOptions): Promise<StoredFile> {
    const path = this.#path(key);
    return this.#run(opts, async (attemptOpts) =>
      this.#storedFile(await this.#adapter.download(path, attemptOpts))
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
    const path = this.#path(key);
    return this.#run(opts, async (attemptOpts) =>
      this.#storedFile(await this.#adapter.head(path, attemptOpts))
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
    const path = this.#path(key);
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.exists(path, attemptOpts)
    );
  }

  delete(key: string, opts?: OperationOptions): Promise<void> {
    const path = this.#path(key);
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.delete(path, attemptOpts)
    );
  }

  /**
   * Delete many keys in one call, returning a structured result rather than
   * throwing on partial failure. Uses the adapter's native bulk primitive
   * when available, otherwise fans out to `delete()` with bounded
   * concurrency. Invalid keys are reported in `errors` alongside provider
   * failures; with `stopOnError`, the first invalid key short-circuits
   * before any delete is attempted.
   */
  async deleteMany(
    keys: string[],
    opts?: DeleteManyOptions
  ): Promise<DeleteManyResult> {
    if (!Array.isArray(keys)) {
      throw new FilesError("Provider", "keys must be an array");
    }

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
    const fromPath = this.#path(from, "copy source");
    const toPath = this.#path(to, "copy destination");
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.copy(fromPath, toPath, attemptOpts)
    );
  }

  list(opts?: ListOptions): Promise<ListResult> {
    if (!this.#prefix) {
      return this.#run(opts, (attemptOpts) => this.#adapter.list(attemptOpts));
    }
    const prefix = opts?.prefix
      ? `${this.#prefix}/${opts.prefix.replace(/^\/+/u, "")}`
      : `${this.#prefix}/`;
    return this.#run(opts, async (attemptOpts) => {
      const result = await this.#adapter.list({ ...attemptOpts, prefix });
      return {
        ...result,
        items: result.items.map((item) => this.#storedFile(item)),
      };
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
    const path = this.#path(key);
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.url(path, attemptOpts)
    );
  }

  signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload> {
    const path = this.#path(key);
    return this.#run(opts, (attemptOpts) =>
      this.#adapter.signedUploadUrl(path, attemptOpts as SignUploadOptions)
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
