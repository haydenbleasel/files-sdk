// Reactive read stores — the Svelte twin of the React/Vue query hooks. Each
// returns Svelte stores (`$data`, `$isLoading`, …). Inputs are plain (Svelte's
// reactivity lives at the component level): re-run on demand with `refetch()`,
// e.g. from a `$:` block when a dependency changes.

import type {
  FilesClient,
  ListCallOptions,
  SearchCallOptions,
} from "../client/index.js";
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
  refetch(): void;
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
  const data = writable<T | undefined>();
  const errorStore = writable<FilesError | undefined>();
  const isFetching = writable(false);
  const isLoading = writable(false);
  let controller: AbortController | undefined;

  const load = () => {
    controller?.abort();
    if (!enabled) {
      isFetching.set(false);
      isLoading.set(false);
      return;
    }
    const current = new AbortController();
    controller = current;
    isFetching.set(true);
    isLoading.set(data.get() === undefined);
    errorStore.set(undefined);
    void (async () => {
      try {
        const result = await run(current.signal);
        if (!current.signal.aborted) {
          data.set(result);
          isFetching.set(false);
          isLoading.set(false);
        }
      } catch (error) {
        if (!current.signal.aborted) {
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
