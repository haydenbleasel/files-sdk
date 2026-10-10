// Optional reactive read hooks layered on the imperative client — the
// declarative data/loading/error/refetch shape React devs expect for a file
// browser. Deliberately dependency-light: no global cache, each hook owns a
// `useState`-backed query that aborts its in-flight request on dep-change or
// unmount. `data` belongs to one input: a new key (or endpoint) starts empty
// and loading, a disabled query has none, and only a `refetch()` of the same
// input keeps showing its data while it reloads. For real caching, bring React
// Query: call `useFiles()` at the component's top level and call one of its
// methods inside `queryFn`.

import { useEffect, useMemo, useRef, useState } from "react";

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
import { isFunction } from "../internal/is.js";
import type { UseFilesOptions } from "./use-files.js";

export type QueryConfig = UseFilesOptions & { enabled?: boolean };

export interface QueryResult<T> {
  data: T | undefined;
  error: FilesError | undefined;
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
}

/* oxlint-disable react/refs, react/memo-dependencies, react/exhaustive-effect-dependencies, react/set-state-in-effect, react-doctor/react-compiler-no-manual-memoization -- ships to consumers who are mostly NOT on the React Compiler; the manual useMemo, the live `ref.current = …` config sync, and the effect's setState (aborting the in-flight query on dep-change) are required correctness, not dead weight */
const useClient = (config?: QueryConfig): FilesClient => {
  const ref = useRef(config);
  ref.current = config;
  const endpoint = config?.endpoint;
  // Only the endpoint rebinds the client — the query effect keys on the client
  // so an endpoint switch (`?bucket=`) refetches. `fetchImpl` is read live
  // through the ref like `headers`: an inline function would otherwise rebuild
  // the client every render and refetch forever; a swap applies to the next
  // request. `transport` only serves uploads, which these read hooks never do.
  return useMemo(() => {
    // SAFETY: the client only ever calls `fetchImpl(input, init)`; the runtime
    // `typeof fetch` also declares static helpers (Bun's `preconnect`) that no
    // client code path reads.
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      (ref.current?.fetchImpl ?? fetch)(input, init)) as typeof fetch;
    return createFilesClient({
      endpoint,
      fetchImpl,
      headers: async () => {
        const headers = ref.current?.headers;
        return isFunction(headers) ? await headers() : (headers ?? {});
      },
    });
  }, [endpoint]);
};

/** What one query has loaded, tagged with the input (`id`) it belongs to. */
interface QueryState<T> {
  id?: string;
  data?: T;
  error?: FilesError;
  isFetching: boolean;
}

const useQuery = <T>(
  key: string,
  run: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
  client: FilesClient,
  config: QueryConfig | undefined
): QueryResult<T> => {
  // The endpoint is part of the input: a `?bucket=` switch is other data.
  const id = JSON.stringify([config?.endpoint, key]);
  const [state, setState] = useState<QueryState<T>>({ isFetching: false });
  const [tick, setTick] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  // Read when a request starts, like `headers`: an inline signal must not
  // refetch on every render.
  const signalRef = useRef(config?.signal);
  signalRef.current = config?.signal;

  useEffect(() => {
    if (!enabled) {
      // Nothing to show while disabled: drop what an earlier input loaded.
      setState((prev) =>
        prev.id === undefined ? prev : { isFetching: false }
      );
      return;
    }
    const controller = new AbortController();
    // The hook-level `signal` cancels this request too; unlike the cleanup's
    // abort, that settles the query (with an `aborted` error).
    const detach = followSignal(controller, signalRef.current);
    let live = true;
    // A refetch keeps its own input's data while it reloads; a new input
    // never shows the previous one's.
    setState((prev) =>
      prev.id === id
        ? { data: prev.data, id, isFetching: true }
        : { id, isFetching: true }
    );
    const load = async () => {
      try {
        const data = await runRef.current(controller.signal);
        if (live) {
          setState({ data, id, isFetching: false });
        }
      } catch (error) {
        if (live) {
          setState((prev) => ({
            data: prev.data,
            error: FilesError.wrap(error),
            id,
            isFetching: false,
          }));
        }
      } finally {
        detach();
      }
    };
    void load();
    return () => {
      live = false;
      detach();
      controller.abort();
    };
    // `client` is rebuilt when the endpoint changes (a `?bucket=` switch,
    // say), and that must refetch even though `key` is unchanged.
  }, [id, tick, enabled, client]);

  // Derived at render, so the render that switches input (before the effect
  // above runs) already shows it empty and loading, never the old data.
  const current = enabled && state.id === id;
  const data = current ? state.data : undefined;
  const isFetching = enabled && (!current || state.isFetching);
  return {
    data,
    error: current ? state.error : undefined,
    isFetching,
    isLoading: isFetching && data === undefined,
    refetch: () => setTick((t) => t + 1),
  };
};
/* oxlint-enable react/refs, react/memo-dependencies, react/exhaustive-effect-dependencies, react/set-state-in-effect, react-doctor/react-compiler-no-manual-memoization */

export const useList = (
  opts: ListCallOptions = {},
  config?: QueryConfig
): QueryResult<ListResult> => {
  const client = useClient(config);
  const enabled = config?.enabled ?? true;
  // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined strips the non-serializable signal from the cache key
  const key = JSON.stringify({ kind: "list", ...opts, signal: undefined });
  return useQuery(
    key,
    (signal) => client.list({ ...opts, signal }),
    enabled,
    client,
    config
  );
};

export const useFile = (
  key: string | undefined,
  config?: QueryConfig
): QueryResult<FileInfo> => {
  const client = useClient(config);
  const enabled = (config?.enabled ?? true) && key !== undefined;
  // SAFETY: `enabled` is false whenever `key` is undefined, and `useQuery`
  // never invokes `run` while disabled.
  return useQuery(
    JSON.stringify({ key, kind: "file" }),
    (signal) => client.head(key as string, { signal }),
    enabled,
    client,
    config
  );
};

export const useSearch = (
  pattern: string | RegExp | undefined,
  opts: SearchCallOptions = {},
  config?: QueryConfig
): QueryResult<FileInfo[]> => {
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
  // SAFETY: `enabled` is false whenever `pattern` is undefined, and `useQuery`
  // never invokes `run` while disabled.
  return useQuery(
    key,
    async (signal) => {
      const out: FileInfo[] = [];
      for await (const file of client.search(pattern as string | RegExp, {
        ...opts,
        signal,
      })) {
        out.push(file);
      }
      return out;
    },
    enabled,
    client,
    config
  );
};
