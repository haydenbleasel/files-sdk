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

// `setTimeout` takes a signed 32-bit delay; anything larger (or `Infinity`)
// is silently clamped to 1ms by Node/Bun, which would time every op out
// immediately. Values past this cap are clamped; non-finite ones mean "never".
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Normalize a caller-supplied per-attempt timeout into a usable delay: `undefined`
 * for unset, non-positive, or non-finite values (`Infinity` / `NaN` read as
 * "no timeout"), otherwise the value clamped to the 32-bit `setTimeout` max.
 */
export const timeoutMs = (timeout?: number): number | undefined => {
  if (timeout === undefined || !Number.isFinite(timeout) || timeout <= 0) {
    return;
  }
  return Math.min(timeout, MAX_TIMEOUT_MS);
};

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
 * `AbortSignal.any` for runtimes without it (Node < 20): a controller that
 * follows the first of `signals` to abort. Listeners are detached once it
 * aborts; until then they stay attached, since the result must keep tracking
 * its sources for as long as it lives.
 */
export const manualAnySignal = (signals: AbortSignal[]): AbortSignal => {
  const controller = new AbortController();
  const listeners: (() => void)[] = [];
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
      for (const detach of listeners) {
        detach();
      }
    }
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal.reason);
      break;
    }
    const onAbort = () => abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    listeners.push(() => signal.removeEventListener("abort", onAbort));
  }
  return controller.signal;
};

const anySignal: (signals: AbortSignal[]) => AbortSignal =
  typeof AbortSignal.any === "function"
    ? (signals) => AbortSignal.any(signals)
    : manualAnySignal;

/**
 * Fold zero or more signals into one that aborts when any of them does, with
 * **no** teardown: the result stays wired to its sources for as long as it
 * lives, so a caller's `signal` keeps reaching a lazily-consumed body after
 * the operation call itself has resolved. Uses `AbortSignal.any` where the
 * runtime has it (the platform manages listener lifetimes), else
 * {@link manualAnySignal}.
 */
export const combineSignals = (
  signals: AbortSignal[]
): AbortSignal | undefined => {
  if (signals.length === 0) {
    return;
  }
  if (signals.length === 1) {
    return signals[0];
  }
  return anySignal(signals);
};

/**
 * Combine zero or more abort signals with an optional per-attempt timeout into
 * a single signal. The caller signals are folded with {@link combineSignals}
 * and stay attached for the life of the result; only the timeout is disposable
 * — `cleanup` clears its timer so a per-attempt timeout can't fire into a
 * body that's still streaming after the call resolved. Callers must invoke
 * `cleanup` in a `finally`.
 */
export const mergeSignals = (
  signals: AbortSignal[],
  timeout?: number
): { signal?: AbortSignal; cleanup?: () => void } => {
  const delay = timeoutMs(timeout);
  if (delay === undefined) {
    return { signal: combineSignals(signals) };
  }

  const timer = new AbortController();
  const handle = setTimeout(() => {
    timer.abort(timeoutError(delay));
  }, delay);
  return {
    cleanup: () => clearTimeout(handle),
    signal: combineSignals([...signals, timer.signal]),
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
