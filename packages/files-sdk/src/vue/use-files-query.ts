// Reactive read composables — the Vue twin of the React query hooks. Inputs are
// `MaybeRefOrGetter`, so `useList(() => prefix.value)` re-runs when the source
// changes. Each composable owns a query that aborts its in-flight request on
// dependency change or scope dispose. Dependency-light: no global cache.

import type { MaybeRefOrGetter, Ref } from "vue";
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  ref,
  shallowRef,
  toValue,
  watch,
} from "vue";

import type {
  FilesClient,
  ListCallOptions,
  SearchCallOptions,
} from "../client/index.js";
import { createFilesClient } from "../client/index.js";
import type { ListResult, StoredFile } from "../index.js";
import { FilesError } from "../internal/errors.js";
import type { UseFilesOptions } from "./use-files.js";

export type QueryConfig = UseFilesOptions & { enabled?: boolean };

export interface QueryReturn<T> {
  data: Ref<T | undefined>;
  error: Ref<FilesError | undefined>;
  isLoading: Ref<boolean>;
  isFetching: Ref<boolean>;
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
  deps: () => unknown,
  enabled: () => boolean,
  run: (signal: AbortSignal) => Promise<T>
): QueryReturn<T> => {
  const data = shallowRef<T | undefined>();
  const errorRef = shallowRef<FilesError | undefined>();
  const isFetching = ref(false);
  const isLoading = computed(
    () => isFetching.value && data.value === undefined
  );
  const tick = ref(0);
  let controller: AbortController | undefined;

  const load = () => {
    controller?.abort();
    if (!enabled()) {
      isFetching.value = false;
      return;
    }
    const current = new AbortController();
    controller = current;
    isFetching.value = true;
    errorRef.value = undefined;
    void (async () => {
      try {
        const result = await run(current.signal);
        if (!current.signal.aborted) {
          data.value = result;
          isFetching.value = false;
        }
      } catch (error) {
        if (!current.signal.aborted) {
          errorRef.value = FilesError.wrap(error);
          isFetching.value = false;
        }
      }
    })();
  };

  watch([deps, enabled, () => tick.value], load, { immediate: true });
  if (getCurrentScope()) {
    onScopeDispose(() => controller?.abort());
  }

  return {
    data,
    error: errorRef,
    isFetching,
    isLoading,
    refetch: () => {
      tick.value += 1;
    },
  };
};

export const useList = (
  opts: MaybeRefOrGetter<ListCallOptions> = {},
  config?: QueryConfig
): QueryReturn<ListResult> => {
  const client = makeClient(config);
  return useQuery(
    () => JSON.stringify(toValue(opts)),
    () => config?.enabled ?? true,
    (signal) => client.list({ ...toValue(opts), signal })
  );
};

export const useFile = (
  key: MaybeRefOrGetter<string | undefined>,
  config?: QueryConfig
): QueryReturn<StoredFile> => {
  const client = makeClient(config);
  return useQuery(
    () => toValue(key),
    () => (config?.enabled ?? true) && toValue(key) !== undefined,
    (signal) => client.head(toValue(key) as string, { signal })
  );
};

export const useSearch = (
  pattern: MaybeRefOrGetter<string | RegExp | undefined>,
  opts: MaybeRefOrGetter<SearchCallOptions> = {},
  config?: QueryConfig
): QueryReturn<StoredFile[]> => {
  const client = makeClient(config);
  return useQuery(
    () => {
      const value = toValue(pattern);
      return JSON.stringify([
        value instanceof RegExp ? `re:${value.source}:${value.flags}` : value,
        toValue(opts),
      ]);
    },
    () => (config?.enabled ?? true) && toValue(pattern) !== undefined,
    async (signal) => {
      const out: StoredFile[] = [];
      for await (const file of client.search(
        toValue(pattern) as string | RegExp,
        { ...toValue(opts), signal }
      )) {
        out.push(file);
      }
      return out;
    }
  );
};
