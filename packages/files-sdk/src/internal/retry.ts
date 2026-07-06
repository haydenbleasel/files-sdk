// Signal merging, abort plumbing, and retry math shared by the operation
// runner (`Files.#run`) and the resumable-upload orchestrator
// (`runResumableUpload`). Both need to merge a caller signal with a per-attempt
// timeout, normalize aborts into a {@link FilesError}, and decide whether a
// failure is worth retrying — so the logic lives here once rather than being
// reimplemented (and separately tested) in two places.

import type { RetryOptions } from "../index.js";
import { FilesError } from "./errors.js";

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
      timedOut: true,
    }
  );

/**
 * Combine zero or more abort signals with an optional per-attempt timeout into
 * a single signal. Returns the original signal untouched when there's exactly
 * one and no timeout; otherwise mints a controller that aborts when any input
 * aborts or the timer fires, plus a `cleanup` to detach listeners and clear the
 * timer. Callers must invoke `cleanup` in a `finally`.
 */
export const mergeSignals = (
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

/**
 * Normalize an abort `reason` into a {@link FilesError} flagged `aborted`. A
 * reason that's already a `FilesError` (e.g. a timeout) passes through; an
 * `Error` is wrapped with its message; anything else is stringified.
 */
export const abortError = (reason?: unknown): FilesError => {
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

/**
 * Run `fn`, rejecting early if `signal` aborts before it settles. When no
 * signal is given, just runs `fn`. The abort listener is detached once `fn`
 * settles so a long-lived signal doesn't accumulate listeners.
 */
export const runWithSignal = async <T>(
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
    (async () => {
      try {
        resolve(await fn());
      } catch (error) {
        reject(error);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    })();
  });
};

/**
 * Sleep `ms`, rejecting early (and clearing the timer) if `signal` aborts. A
 * non-positive `ms` resolves immediately.
 */
export const sleep = async (
  ms: number,
  signal?: AbortSignal
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

/**
 * Maximum number of retry attempts for an operation. `0` when not retryable or
 * unset. A bare number is treated as `{ max }`.
 */
export const maxRetries = (
  retries: RetryOptions | undefined,
  retryable: boolean
): number => {
  if (!retryable) {
    return 0;
  }
  const max = typeof retries === "number" ? retries : retries?.max;
  return Math.max(0, Math.floor(max ?? 0));
};

/**
 * Backoff delay in ms before the given (1-based) retry attempt. Uses the
 * caller's `backoff` curve when supplied, otherwise an exponential curve from
 * 100ms, capped at 30s.
 */
export const retryBackoff = (
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

/**
 * Whether a failed attempt should be retried: under the attempt cap, a
 * transient `Provider` error, not an abort (aborts and timeouts are
 * deliberate and never retried), and not flagged `permanent` (a
 * deterministic failure re-issuing the request can't fix).
 */
export const canRetry = (
  error: FilesError,
  attempt: number,
  maxAttempts: number
): boolean =>
  attempt < maxAttempts &&
  error.code === "Provider" &&
  !(error.aborted || error.permanent);
