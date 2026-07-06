// Optional reactive read hooks layered on the imperative client — the
// declarative data/loading/error/refetch shape React devs expect for a file
// browser. Deliberately dependency-light: no global cache, each hook owns a
// `useState`-backed query that aborts its in-flight request on dep-change or
// unmount. For real caching, bring React Query and call `useFiles()` in `queryFn`.

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  FilesClient,
  ListCallOptions,
  SearchCallOptions,
} from "../client/index.js";
// oxlint-disable-next-line react-doctor/no-barrel-import -- public entrypoint; the client barrel is the documented import surface
import { createFilesClient } from "../client/index.js";
import type { ListResult, StoredFile } from "../index.js";
import { FilesError } from "../internal/errors.js";
import type { UseFilesOptions } from "./use-files.js";

export type QueryConfig = UseFilesOptions & { enabled?: boolean };

export interface QueryResult<T> {
  data: T | undefined;
  error: FilesError | undefined;
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
}

/* oxlint-disable react/react-compiler, react-doctor/react-compiler-no-manual-memoization -- ships to consumers who are mostly NOT on the React Compiler; the manual useMemo, the live `ref.current = …` config sync, and the effect's setState (aborting the in-flight query on dep-change) are required correctness, not dead weight */
const useClient = (config?: QueryConfig): FilesClient => {
  const ref = useRef(config);
  ref.current = config;
  return useMemo(
    () =>
      createFilesClient({
        endpoint: config?.endpoint,
        fetchImpl: config?.fetchImpl,
        headers: async () => {
          const headers = ref.current?.headers;
          return typeof headers === "function"
            ? await headers()
            : (headers ?? {});
        },
        transport: config?.transport,
      }),
    [config?.endpoint, config?.fetchImpl, config?.transport]
  );
};

const useQuery = <T>(
  key: string,
  run: (signal: AbortSignal) => Promise<T>,
  enabled: boolean
): QueryResult<T> => {
  const [state, setState] = useState<{
    data?: T;
    error?: FilesError;
    isFetching: boolean;
  }>({ isFetching: enabled });
  const [tick, setTick] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) {
      setState((prev) => ({ ...prev, isFetching: false }));
      return;
    }
    const controller = new AbortController();
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = error field unset; null would change the state shape
    setState((prev) => ({ ...prev, error: undefined, isFetching: true }));
    const load = async () => {
      try {
        const data = await runRef.current(controller.signal);
        if (!controller.signal.aborted) {
          setState({ data, isFetching: false });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setState((prev) => ({
            ...prev,
            error: FilesError.wrap(error),
            isFetching: false,
          }));
        }
      }
    };
    void load();
    return () => {
      controller.abort();
    };
  }, [key, tick, enabled]);

  return {
    data: state.data,
    error: state.error,
    isFetching: state.isFetching,
    isLoading: state.isFetching && state.data === undefined,
    refetch: () => setTick((t) => t + 1),
  };
};
/* oxlint-enable react/react-compiler, react-doctor/react-compiler-no-manual-memoization */

export const useList = (
  opts: ListCallOptions = {},
  config?: QueryConfig
): QueryResult<ListResult> => {
  const client = useClient(config);
  const enabled = config?.enabled ?? true;
  // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined strips the non-serializable signal from the cache key
  const key = JSON.stringify({ kind: "list", ...opts, signal: undefined });
  return useQuery(key, (signal) => client.list({ ...opts, signal }), enabled);
};

export const useFile = (
  key: string | undefined,
  config?: QueryConfig
): QueryResult<StoredFile> => {
  const client = useClient(config);
  const enabled = (config?.enabled ?? true) && key !== undefined;
  return useQuery(
    JSON.stringify({ key, kind: "file" }),
    (signal) => client.head(key as string, { signal }),
    enabled
  );
};

export const useSearch = (
  pattern: string | RegExp | undefined,
  opts: SearchCallOptions = {},
  config?: QueryConfig
): QueryResult<StoredFile[]> => {
  const client = useClient(config);
  const enabled = (config?.enabled ?? true) && pattern !== undefined;
  const key = JSON.stringify({
    kind: "search",
    pattern:
      pattern instanceof RegExp
        ? `re:${pattern.source}:${pattern.flags}`
        : pattern,
    ...opts,
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined strips the non-serializable signal from the cache key
    signal: undefined,
  });
  return useQuery(
    key,
    async (signal) => {
      const out: StoredFile[] = [];
      for await (const file of client.search(pattern as string | RegExp, {
        ...opts,
        signal,
      })) {
        out.push(file);
      }
      return out;
    },
    enabled
  );
};
