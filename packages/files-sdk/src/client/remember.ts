// Shared by the React/Vue/Svelte `useFiles` bindings, which mirror every
// verb's failure into their ambient `error`. The promise verbs wrap a call in
// try/catch; `listAll`/`search` are async generators whose failures surface
// while the caller iterates, so they need the iteration itself wrapped.
// Internal: not re-exported from `files-sdk/client`.

/**
 * Delegate to `source`, passing any error thrown while it is iterated to
 * `record` before rethrowing it. Early `break`/`return` still closes `source`.
 */
export const rememberIteration = <T>(
  source: AsyncGenerator<T, void>,
  record: (cause: unknown) => void
): AsyncGenerator<T, void> =>
  (async function* iterate() {
    try {
      yield* source;
    } catch (error) {
      record(error);
      throw error;
    }
  })();
