// Shared building blocks for adapter authors.
//
// Adapters duplicate a small set of helpers — body normalization, URL
// joining, expiry defaults, the public-vs-sign precedence rule, and the
// error-mapping scaffold. Centralizing them here cuts ~50 lines per new
// adapter and codifies the security-relevant invariants (notably "asking
// for `responseContentDisposition` forces signing") in one place.

import type {
  Body,
  BulkError,
  BulkOptions,
  DeleteManyError,
  DeleteManyOptions,
  DeleteManyResult,
  MultipartOptions,
} from "../index.js";
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

/**
 * Drain a `ReadableStream<Uint8Array>` into a single concatenated `Uint8Array`.
 * Used by adapters whose SDK lacks a streaming upload form and by
 * {@link createStoredFile} when a stream body is read into a buffering
 * accessor.
 */
export const collectStream = async (
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/**
 * Synchronously determine a body's byte length when it's cheap to know.
 * Returns `undefined` for a `ReadableStream`, whose length is unknown until
 * drained. Used to surface a `total` in upload-progress reports without
 * consuming the body.
 */
export const byteLengthOf = (body: Body): number | undefined => {
  if (typeof body === "string") {
    return new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  if (body instanceof Blob) {
    return body.size;
  }
  return undefined;
};

/**
 * Wrap a byte stream so it reports cumulative progress as it's consumed. The
 * returned stream yields the same chunks in the same order; `onChunk` is
 * called with the running byte total after each chunk is forwarded. Pulls
 * lazily, so the total tracks what the downstream reader (the adapter) has
 * actually drained — which approximates upload progress for streaming
 * adapters. Used to drive `onProgress` for `ReadableStream` bodies without
 * buffering them.
 */
export const countingStream = (
  stream: ReadableStream<Uint8Array>,
  onChunk: (loaded: number) => void
): ReadableStream<Uint8Array> => {
  const reader = stream.getReader();
  let loaded = 0;
  return new ReadableStream<Uint8Array>({
    cancel(reason) {
      return reader.cancel(reason);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) {
        loaded += value.byteLength;
        controller.enqueue(value);
        onChunk(loaded);
      }
    },
  });
};

/**
 * Whether an upload caller opted into multipart — a truthy boolean or a
 * {@link MultipartOptions} object. Shared by the adapters that branch on it.
 */
export const isMultipartRequested = (
  multipart: boolean | MultipartOptions | undefined
): boolean => multipart !== undefined && multipart !== false;

const GCS_RESUMABLE_CHUNK_MULTIPLE = 256 * 1024;

/**
 * Round a multipart `partSize` to a chunk size valid for `@google-cloud/storage`
 * resumable uploads — a multiple of 256 KiB, never below one unit. Shared by the
 * GCS and Firebase Storage adapters. Returns `undefined` when no `partSize` was
 * supplied (or `multipart` was a bare boolean) so the SDK default applies.
 */
export const resumableChunkSize = (
  multipart: boolean | MultipartOptions | undefined
): number | undefined => {
  const partSize =
    typeof multipart === "object" ? multipart.partSize : undefined;
  if (partSize === undefined) {
    return;
  }
  const rounded =
    Math.floor(partSize / GCS_RESUMABLE_CHUNK_MULTIPLE) *
    GCS_RESUMABLE_CHUNK_MULTIPLE;
  return Math.max(rounded, GCS_RESUMABLE_CHUNK_MULTIPLE);
};

export const deleteManyWithFallback = async (
  keys: string[],
  remove: (key: string) => Promise<void>,
  opts?: DeleteManyOptions,
  mapError: (error: unknown) => FilesError = FilesError.wrap
): Promise<DeleteManyResult> => {
  const deleted: string[] = [];
  const errors: DeleteManyError[] = [];

  if (keys.length === 0) {
    return { deleted };
  }

  if (opts?.stopOnError) {
    for (const key of keys) {
      try {
        await remove(key);
        deleted.push(key);
      } catch (error) {
        errors.push({ error: mapError(error), key });
        return { deleted, errors };
      }
    }
    return { deleted };
  }

  const concurrency =
    Number.isInteger(opts?.concurrency) && (opts?.concurrency ?? 0) > 0
      ? (opts?.concurrency as number)
      : 8;
  const success = Array.from<boolean>({ length: keys.length }).fill(false);
  const failed = Array.from<DeleteManyError | undefined>({
    length: keys.length,
  });
  let index = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
      while (index < keys.length) {
        const current = index;
        index += 1;
        const key = keys[current];
        if (key === undefined) {
          return;
        }
        try {
          await remove(key);
          success[current] = true;
        } catch (error) {
          failed[current] = { error: mapError(error), key };
        }
      }
    })
  );

  for (const [current, key] of keys.entries()) {
    if (success[current]) {
      deleted.push(key);
      continue;
    }
    if (failed[current]) {
      errors.push(failed[current]);
    }
  }

  if (errors.length === 0) {
    return { deleted };
  }

  return { deleted, errors };
};

/**
 * Run an operation over many items with bounded concurrency, collecting typed
 * successes and per-key failures in input order — the generic engine behind
 * the array form of `upload` / `download` / `head` / `exists`. No provider
 * exposes a native batch primitive for those, so every adapter fans out here.
 *
 * Mirrors {@link deleteManyWithFallback}: `stopOnError` runs sequentially and
 * returns at the first failure; otherwise a worker pool of `concurrency`
 * (default 8) drains the list, recording each outcome at its input index so
 * the returned `results` and `errors` stay in the order the caller supplied.
 * A separate `success` flag guards against an `Out` value that is itself
 * falsy.
 */
export const mapMany = async <Item, Out>(
  items: Item[],
  keyOf: (item: Item) => string,
  run: (item: Item) => Promise<Out>,
  opts?: BulkOptions,
  mapError: (error: unknown) => FilesError = FilesError.wrap
): Promise<{ results: Out[]; errors: BulkError[] }> => {
  const results: Out[] = [];
  const errors: BulkError[] = [];

  if (items.length === 0) {
    return { errors, results };
  }

  if (opts?.stopOnError) {
    for (const item of items) {
      try {
        results.push(await run(item));
      } catch (error) {
        errors.push({ error: mapError(error), key: keyOf(item) });
        return { errors, results };
      }
    }
    return { errors, results };
  }

  const concurrency =
    Number.isInteger(opts?.concurrency) && (opts?.concurrency ?? 0) > 0
      ? (opts?.concurrency as number)
      : 8;
  const success = Array.from<boolean>({ length: items.length }).fill(false);
  const succeeded = Array.from<Out | undefined>({ length: items.length });
  const failed = Array.from<BulkError | undefined>({ length: items.length });
  let index = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        const item = items[current];
        if (item === undefined) {
          return;
        }
        try {
          succeeded[current] = await run(item);
          success[current] = true;
        } catch (error) {
          failed[current] = { error: mapError(error), key: keyOf(item) };
        }
      }
    })
  );

  for (const [current] of items.entries()) {
    if (success[current]) {
      results.push(succeeded[current] as Out);
      continue;
    }
    const failure = failed[current];
    if (failure) {
      errors.push(failure);
    }
  }

  return { errors, results };
};
