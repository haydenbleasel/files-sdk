// A minimal writable implementing Svelte's store contract, so the binding needs
// no Svelte runtime — and no Svelte *type* either: `ReadableStore` is structural
// (a `subscribe` method), so it's accepted by Svelte's `$store` auto-subscription
// exactly like `Readable`. Bun's bundler can't compile Svelte 5 runes
// (`.svelte.ts` / `$state`), so the reactive layer is stores.

export interface ReadableStore<T> {
  /** Svelte store contract: subscribe, get an unsubscribe back. */
  subscribe: (run: (value: T) => void) => () => void;
}

export interface WritableStore<T> extends ReadableStore<T> {
  set: (value: T) => void;
  get: () => T;
}

export const writable = <T>(initial?: T): WritableStore<T> => {
  let value = initial as T;
  const subscribers = new Set<(value: T) => void>();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const run of subscribers) {
        run(value);
      }
    },
    subscribe(run) {
      subscribers.add(run);
      run(value);
      return () => {
        subscribers.delete(run);
      };
    },
  };
};
