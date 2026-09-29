// Reactive read stores — the Svelte twin of the React/Vue query hooks. Each
// returns Svelte stores (`$data`, `$isLoading`, …). Inputs are plain (Svelte's
// reactivity lives at the component level): to follow a changing input,
// re-create the query reactively (`$: ({ data } = useList({ prefix }))`), or
// re-run it on demand with `refetch()`.
//
// Lifecycle rides the store contract instead of a Svelte runtime import: when
// the last subscriber leaves (the component using `$data` is destroyed, or a
// `$:` block swapped in a new query), the in-flight request is aborted, just as
// React/Vue abort on unmount. A synchronous peek (`get(store)`) doesn't count —
// only a subscription that outlives the tick it was made in arms the abort —
// and a query aborted this way re-runs when it is subscribed to again.

import type {
  FilesClient,
  ListCallOptions,
  SearchCallOptions,
} from "../client/index.js";
// oxlint-disable-next-line react-doctor/no-barrel-import -- public entrypoint; the client barrel is the documented import surface
import { createFilesClient } from "../client/index.js";
import type { ListResult, StoredFile } from "../index.js";
import { FilesError } from "../internal/errors.js";
import type { ReadableStore } from "./store.js";
import { writable } from "./store.js";
import type { UseFilesOptions } from "./use-files.js";

export type QueryConfig = UseFilesOptions & { enabled?: boolean };

export interface QueryReturn<T> {
  data: ReadableStore<T | undefined>;
  error: ReadableStore<FilesError | undefined>;
  isLoading: ReadableStore<boolean>;
  isFetching: ReadableStore<boolean>;
  refetch: () => void;
}

const makeClient = (config?: QueryConfig): FilesClient =>
  createFilesClient({
    endpoint: config?.endpoint,
    fetchImpl: config?.fetchImpl,
    headers: config?.headers,
    transport: config?.transport,
  });

const useQuery = <T>(
  enabled: boolean,
  run: (signal: AbortSignal) => Promise<T>
): QueryReturn<T> => {
  let controller: AbortController | undefined;
  let pending = false;
  // Stores with at least one subscriber; `armed` once one has held on past
  // the tick it subscribed in; `idled` when a run was aborted for want of any.
  let active = 0;
  let armed = false;
  let idled = false;
  // The stores' watcher re-runs `load`, which writes the stores: each only
  // calls the other after construction (nothing subscribes until `useQuery`
  // has returned).
  const watch = (nowActive: boolean): void => {
    if (nowActive) {
      active += 1;
      if (idled) {
        // oxlint-disable-next-line no-use-before-define -- only called once a subscriber exists, after `load` is defined
        load();
      }
      queueMicrotask(() => {
        armed ||= active > 0;
      });
      return;
    }
    active -= 1;
    if (active === 0 && armed) {
      armed = false;
      if (pending) {
        idled = true;
        controller?.abort();
      }
    }
  };

  const data = writable<T | undefined>(undefined, watch);
  const errorStore = writable<FilesError | undefined>(undefined, watch);
  const isFetching = writable(false, watch);
  const isLoading = writable(false, watch);

  const load = () => {
    controller?.abort();
    idled = false;
    if (!enabled) {
      pending = false;
      isFetching.set(false);
      isLoading.set(false);
      return;
    }
    const current = new AbortController();
    controller = current;
    pending = true;
    isFetching.set(true);
    isLoading.set(data.get() === undefined);
    errorStore.set(undefined);
    void (async () => {
      try {
        const result = await run(current.signal);
        if (!current.signal.aborted) {
          pending = false;
          data.set(result);
          isFetching.set(false);
          isLoading.set(false);
        }
      } catch (error) {
        if (!current.signal.aborted) {
          pending = false;
          errorStore.set(FilesError.wrap(error));
          isFetching.set(false);
          isLoading.set(false);
        }
      }
    })();
  };

  load();
  return { data, error: errorStore, isFetching, isLoading, refetch: load };
};

export const useList = (
  opts: ListCallOptions = {},
  config?: QueryConfig
): QueryReturn<ListResult> => {
  const client = makeClient(config);
  return useQuery(config?.enabled ?? true, (signal) =>
    client.list({ ...opts, signal })
  );
};

export const useFile = (
  key: string | undefined,
  config?: QueryConfig
): QueryReturn<StoredFile> => {
  const client = makeClient(config);
  // SAFETY: `enabled` is false whenever `key` is undefined, and `useQuery`
  // never invokes `run` while disabled.
  return useQuery((config?.enabled ?? true) && key !== undefined, (signal) =>
    client.head(key as string, { signal })
  );
};

export const useSearch = (
  pattern: string | RegExp | undefined,
  opts: SearchCallOptions = {},
  config?: QueryConfig
): QueryReturn<StoredFile[]> => {
  const client = makeClient(config);
  // SAFETY: `enabled` is false whenever `pattern` is undefined, and `useQuery`
  // never invokes `run` while disabled.
  return useQuery(
    (config?.enabled ?? true) && pattern !== undefined,
    async (signal) => {
      const out: StoredFile[] = [];
      for await (const file of client.search(pattern as string | RegExp, {
        ...opts,
        signal,
      })) {
        out.push(file);
      }
      return out;
    }
  );
};
