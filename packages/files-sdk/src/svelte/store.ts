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

/**
 * `onActiveChange` mirrors Svelte's own start/stop notifier: it is called with
 * `true` when the store gains its first subscriber and `false` when it loses
 * its last (e.g. the `$store` auto-subscription of a destroyed component).
 */
export const writable = <T>(
  initial?: T,
  onActiveChange?: (active: boolean) => void
): WritableStore<T> => {
  // SAFETY: a store created without an initial value is instantiated with a
  // `T` that admits `undefined` (`writable<X | undefined>()`), so the omitted
  // initial is itself a valid `T`.
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
      // A fresh closure per call, so subscribing the same callback twice
      // still yields two independent unsubscribes.
      const subscriber = (next: T) => run(next);
      subscribers.add(subscriber);
      if (subscribers.size === 1) {
        onActiveChange?.(true);
      }
      subscriber(value);
      return () => {
        if (subscribers.delete(subscriber) && subscribers.size === 0) {
          onActiveChange?.(false);
        }
      };
    },
  };
};
