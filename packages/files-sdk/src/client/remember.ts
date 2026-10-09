// Shared by the React/Vue/Svelte `useFiles` bindings, which mirror every
// verb's failure into their ambient `error`. The promise verbs wrap a call in
// try/catch; `listAll`/`search` are async generators whose failures surface
// while the caller iterates, so they need the iteration itself wrapped.
// Internal: not re-exported from `files-sdk/client`.

/**
 * Delegate to `source`, passing any error thrown while it is iterated to
 * `record` before rethrowing it, and resolving to `source`'s own return value.
 * Early `break`/`return` still closes `source`.
 */
export const rememberIteration = <T, R>(
  source: AsyncGenerator<T, R>,
  record: (cause: unknown) => void
): AsyncGenerator<T, R> =>
  (async function* iterate() {
    try {
      // The source's return value (`search`'s `{ truncated }`) passes through.
      return yield* source;
    } catch (error) {
      record(error);
      throw error;
    }
  })();
