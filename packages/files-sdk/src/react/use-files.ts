import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import type {
  AggregateProgress,
  FileUploadState,
  FilesClient,
  FilesClientConfig,
  UploadBody,
  UploadCallOptions,
} from "../client/index.js";
// oxlint-disable-next-line react-doctor/no-barrel-import -- public entrypoint; the client barrel is the documented import surface
import { aggregate, createFilesClient } from "../client/index.js";
import { defaultTransport } from "../client/transport.js";
import { FilesError } from "../internal/errors.js";
import { mergeSignals } from "../internal/retry.js";
import { createStore, INITIAL_STATE } from "./store.js";

export interface UseFilesOptions extends FilesClientConfig {
  /** External signal merged into every call this hook makes. */
  signal?: AbortSignal;
}

export interface UseFilesResult extends FilesClient {
  /** `true` while any `upload()` started by this hook is in flight. */
  isUploading: boolean;
  /** Per-file live state of the most recent upload. */
  uploads: readonly FileUploadState[];
  /** Aggregate progress across in-flight uploads. */
  progress: AggregateProgress;
  /** The last error from any verb. */
  error: FilesError | undefined;
  /** Clear the ambient error + upload state (and re-arm after an `abort`). */
  reset: () => void;
  /** Abort every in-flight call this hook started. */
  abort: (reason?: unknown) => void;
}

/* oxlint-disable react/react-compiler, react-doctor/react-compiler-no-manual-memoization -- ships to consumers who are mostly NOT on the React Compiler; the manual useMemo and the lazy ref-init pattern (`if (ref.current === null) ref.current = …`) are required correctness, not dead weight */
export const useFiles = (opts: UseFilesOptions = {}): UseFilesResult => {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const rootRef = useRef<AbortController>(null as unknown as AbortController);
  if (rootRef.current === null) {
    rootRef.current = new AbortController();
  }

  const storeRef = useRef<ReturnType<typeof createStore>>(
    null as unknown as ReturnType<typeof createStore>
  );
  if (storeRef.current === null) {
    storeRef.current = createStore();
  }
  const store = storeRef.current;
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    () => INITIAL_STATE
  );

  const {
    concurrency,
    endpoint,
    fetchImpl: baseFetchImpl,
    transport: baseTransport,
  } = opts;

  const client = useMemo<FilesClient>(() => {
    const baseFetch = baseFetchImpl ?? fetch;
    const mergedSignals = (extra?: AbortSignal): AbortSignal => {
      const signals = [rootRef.current.signal];
      if (optsRef.current.signal) {
        signals.push(optsRef.current.signal);
      }
      if (extra) {
        signals.push(extra);
      }
      return mergeSignals(signals).signal as AbortSignal;
    };
    return createFilesClient({
      concurrency,
      endpoint,
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
        baseFetch(input, {
          ...init,
          signal: mergedSignals(init?.signal ?? undefined),
        })) as typeof fetch,
      headers: async () => {
        const { headers } = optsRef.current;
        return typeof headers === "function"
          ? await headers()
          : (headers ?? {});
      },
      transport: (req) => {
        const base = baseTransport ?? defaultTransport(baseFetch);
        return base({ ...req, signal: mergedSignals(req.signal) });
      },
    });
    // optsRef carries the live headers/signal; only the structural config rebinds the client.
  }, [endpoint, concurrency, baseFetchImpl, baseTransport]);

  useEffect(
    () => () => {
      rootRef.current.abort();
      // The ref survives a StrictMode (or any) remount, so leaving it aborted
      // here would make every call after the remount fail with "signal is
      // aborted without reason". Re-arm with a fresh controller — all cleanups
      // run before the remount's effects, so the next mount sees a live signal.
      // An explicit user `abort()` is untouched and still requires `reset()`.
      rootRef.current = new AbortController();
    },
    []
  );

  return useMemo<UseFilesResult>(() => {
    const remember = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        store.patch({ error: FilesError.wrap(error) });
        throw error;
      }
    };

    const trackProgress = (base?: UploadCallOptions): UploadCallOptions => ({
      ...base,
      onProgress: (progress, perFile) => {
        store.setUploads([...perFile]);
        base?.onProgress?.(progress, perFile);
      },
    });

    const upload = async (
      a: Blob | string | unknown[],
      b?: unknown,
      c?: unknown
    ): Promise<unknown> => {
      store.patch({
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = error field unset; null would change the store shape
        error: undefined,
        inFlight: store.getState().inFlight + 1,
      });
      try {
        if (Array.isArray(a)) {
          return await (
            client.upload as (...args: unknown[]) => Promise<unknown>
          )(a, b);
        }
        if (typeof a === "string") {
          return await client.upload(
            a,
            b as UploadBody,
            trackProgress(c as UploadCallOptions)
          );
        }
        return await client.upload(a, trackProgress(b as UploadCallOptions));
      } catch (error) {
        const wrapped = FilesError.wrap(error);
        store.patch({ error: wrapped });
        throw wrapped;
      } finally {
        store.patch({ inFlight: Math.max(0, store.getState().inFlight - 1) });
      }
    };

    return {
      ...client,
      abort: (reason?: unknown) => {
        rootRef.current.abort(reason);
      },
      capabilities: (o) => remember(() => client.capabilities(o)),
      copy: (from, to, o) => remember(() => client.copy(from, to, o)),
      delete: ((k: never, o: never) =>
        remember(() => client.delete(k, o))) as FilesClient["delete"],
      download: ((k: never, o: never) =>
        remember(() => client.download(k, o))) as FilesClient["download"],
      error: state.error,
      exists: ((k: never, o: never) =>
        remember(() => client.exists(k, o))) as FilesClient["exists"],
      head: ((k: never, o: never) =>
        remember(() => client.head(k, o))) as FilesClient["head"],
      isUploading: state.inFlight > 0,
      list: (o) => remember(() => client.list(o)),
      move: (from, to, o) => remember(() => client.move(from, to, o)),
      progress: aggregate(state.uploads),
      purge: (k, o) => remember(() => client.purge(k, o)),
      reset: () => {
        if (rootRef.current.signal.aborted) {
          rootRef.current = new AbortController();
        }
        store.reset();
      },
      restoreTrashed: (k, o) => remember(() => client.restoreTrashed(k, o)),
      restoreVersion: (k, v, o) =>
        remember(() => client.restoreVersion(k, v, o)),
      signedUploadUrl: (k, o) => remember(() => client.signedUploadUrl(k, o)),
      trashed: (o) => remember(() => client.trashed(o)),
      upload: upload as FilesClient["upload"],
      uploads: state.uploads,
      url: (k, o) => remember(() => client.url(k, o)),
      versions: (k, o) => remember(() => client.versions(k, o)),
    };
  }, [client, store, state]);
};
/* oxlint-enable react/react-compiler, react-doctor/react-compiler-no-manual-memoization */
