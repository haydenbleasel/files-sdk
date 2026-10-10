// Shared by the React/Vue/Svelte bindings. `useFiles` mirrors every verb's
// failure into its ambient `error`: the promise verbs go through
// `rememberCall`; `listAll`/`search` are async generators whose failures
// surface while the caller iterates, so they need the iteration itself
// wrapped. `signalledFetch` and `followSignal` carry the bindings' own abort
// signals into each request. Internal: not re-exported from `files-sdk/client`.

import { FilesError } from "../internal/errors.js";
import { abortError } from "../internal/retry.js";

/**
 * Run `run`, passing a failure to `record` as a {@link FilesError} and
 * rethrowing that same normalized error, so the caller's `catch` and the
 * ambient `error` see one value.
 */
export const rememberCall = async <T>(
  run: () => Promise<T>,
  record: (error: FilesError) => void
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    const failure = FilesError.wrap(error);
    record(failure);
    throw failure;
  }
};

/**
 * Delegate to `source`, passing any error thrown while it is iterated to
 * `record` (normalized to a {@link FilesError}) before rethrowing it, and
 * resolving to `source`'s own return value. Early `break`/`return` still
 * closes `source`.
 */
export const rememberIteration = <T, R>(
  source: AsyncGenerator<T, R>,
  record: (error: FilesError) => void
): AsyncGenerator<T, R> =>
  (async function* iterate() {
    try {
      // The source's return value (`search`'s `{ truncated }`) passes through.
      return yield* source;
    } catch (error) {
      const failure = FilesError.wrap(error);
      record(failure);
      throw failure;
    }
  })();

/**
 * `baseFetch` with every request run under `signalFor(init.signal)` — the
 * binding's controller merged with the caller's signals. A request that merged
 * signal cancelled rejects with an `aborted` {@link FilesError} rather than
 * the runtime's raw `AbortError` (or bare abort reason), which the client
 * could not otherwise tell apart from a network failure.
 */
export const signalledFetch = (
  baseFetch: typeof fetch,
  signalFor: (extra?: AbortSignal) => AbortSignal
): typeof fetch => {
  const run = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const signal = signalFor(init?.signal ?? undefined);
    try {
      return await baseFetch(input, { ...init, signal });
    } catch (error) {
      throw signal.aborted ? abortError(signal.reason) : error;
    }
  };
  // SAFETY: the client only ever calls `fetchImpl(input, init)`; the runtime
  // `typeof fetch` also declares static helpers (Bun's `preconnect`) that no
  // client code path reads.
  return run as typeof fetch;
};

const nothingToDetach = (): void => {
  // No listener was attached.
};

/**
 * Abort `controller` (with the same reason) when `external` aborts — at once
 * if it already has. Returns the detach, so a query run can drop its listener
 * from a long-lived signal once it settles or is replaced.
 */
export const followSignal = (
  controller: AbortController,
  external: AbortSignal | undefined
): (() => void) => {
  if (external?.aborted) {
    controller.abort(external.reason);
  }
  if (!external || external.aborted) {
    return nothingToDetach;
  }
  const onAbort = () => controller.abort(external.reason);
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
};
