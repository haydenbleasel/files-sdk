// Reactive read composables — the Vue twin of the React query hooks. Inputs are
// `MaybeRefOrGetter`, so `useList(() => prefix.value)` re-runs when the source
// changes. Each composable owns a query that aborts its in-flight request on
// dependency change or scope dispose. `data` belongs to one input: a new one
// starts empty and loading, a disabled query has none, and only a `refetch()`
// of the same input keeps its data while it reloads. Dependency-light: no
// global cache.

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
// oxlint-disable-next-line react-doctor/no-barrel-import -- public entrypoint; the client barrel is the documented import surface
import { createFilesClient } from "../client/index.js";
import { followSignal } from "../client/remember.js";
import type { FileInfo, ListResult } from "../index.js";
import { FilesError } from "../internal/errors.js";
import type { UseFilesOptions } from "./use-files.js";

export type QueryConfig = UseFilesOptions & { enabled?: boolean };

export interface QueryReturn<T> {
  data: Ref<T | undefined>;
  error: Ref<FilesError | undefined>;
  isLoading: Ref<boolean>;
  isFetching: Ref<boolean>;
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
  deps: () => string | undefined,
  enabled: () => boolean,
  run: (signal: AbortSignal) => Promise<T>,
  external: AbortSignal | undefined
): QueryReturn<T> => {
  const data = shallowRef<T | undefined>();
  const errorRef = shallowRef<FilesError | undefined>();
  const isFetching = ref(false);
  const isLoading = computed(
    () => isFetching.value && data.value === undefined
  );
  const tick = ref(0);
  // The input `data` was loaded for, and how to cancel the run in flight.
  let loadedFor: string | undefined;
  let stop: (() => void) | undefined;

  const load = () => {
    stop?.();
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = error field unset; null would change the ref's shape
    errorRef.value = undefined;
    if (!enabled()) {
      // Nothing to show while disabled: drop what an earlier input loaded.
      isFetching.value = false;
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = no data; null would change the ref's shape
      data.value = undefined;
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = nothing loaded
      loadedFor = undefined;
      return;
    }
    const input = deps();
    if (input !== loadedFor) {
      // A new input never shows the previous one's data; a refetch keeps its own.
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = no data; null would change the ref's shape
      data.value = undefined;
      loadedFor = input;
    }
    const controller = new AbortController();
    // The composable-level `signal` cancels this request too; unlike a
    // superseding run or scope dispose, that settles the query (with an
    // `aborted` error).
    const detach = followSignal(controller, external);
    let live = true;
    stop = () => {
      live = false;
      detach();
      controller.abort();
    };
    isFetching.value = true;
    void (async () => {
      try {
        const result = await run(controller.signal);
        if (live) {
          data.value = result;
          isFetching.value = false;
        }
      } catch (error) {
        if (live) {
          errorRef.value = FilesError.wrap(error);
          isFetching.value = false;
        }
      } finally {
        detach();
      }
    })();
  };

  watch([deps, enabled, () => tick.value], load, { immediate: true });
  if (getCurrentScope()) {
    onScopeDispose(() => stop?.());
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
    (signal) => client.list({ ...toValue(opts), signal }),
    config?.signal
  );
};

export const useFile = (
  key: MaybeRefOrGetter<string | undefined>,
  config?: QueryConfig
): QueryReturn<FileInfo> => {
  const client = makeClient(config);
  // SAFETY: `enabled` is false whenever the key resolves to undefined, and
  // `useQuery` never invokes `run` while disabled.
  return useQuery(
    () => toValue(key),
    () => (config?.enabled ?? true) && toValue(key) !== undefined,
    (signal) => client.head(toValue(key) as string, { signal }),
    config?.signal
  );
};

export const useSearch = (
  pattern: MaybeRefOrGetter<string | RegExp | undefined>,
  opts: MaybeRefOrGetter<SearchCallOptions> = {},
  config?: QueryConfig
): QueryReturn<FileInfo[]> => {
  const client = makeClient(config);
  // SAFETY: `enabled` is false whenever the pattern resolves to undefined, and
  // `useQuery` never invokes `run` while disabled.
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
      const out: FileInfo[] = [];
      for await (const file of client.search(
        toValue(pattern) as string | RegExp,
        { ...toValue(opts), signal }
      )) {
        out.push(file);
      }
      return out;
    },
    config?.signal
  );
};
