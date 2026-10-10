import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import type {
  AggregateProgress,
  FileUploadState,
  FilesClient,
  FilesClientConfig,
  NativeFileRef,
  UploadBody,
  UploadCallOptions,
  UploadManyCallOptions,
  UploadManyClientItem,
  UploadOutcome,
} from "../client/index.js";
// oxlint-disable-next-line react-doctor/no-barrel-import -- public entrypoint; the client barrel is the documented import surface
import { aggregate, createFilesClient } from "../client/index.js";
import {
  rememberCall,
  rememberIteration,
  signalledFetch,
} from "../client/remember.js";
import { defaultTransport } from "../client/transport.js";
import { createUploadLedger } from "../client/upload-ledger.js";
import type { UploadManyResult } from "../index.js";
import { FilesError } from "../internal/errors.js";
import { isFunction, isString } from "../internal/is.js";
import { mergeSignals } from "../internal/retry.js";
import { createStore, INITIAL_STATE } from "./store.js";

export interface UseFilesOptions extends FilesClientConfig {
  /** External signal merged into every call this hook makes. */
  signal?: AbortSignal;
}

/** `TData`: what the gateway's `onUploadComplete` returns — see `InferUploadData`. */
export interface UseFilesResult<TData = unknown> extends FilesClient<TData> {
  /** `true` while any `upload()` started by this hook is in flight. */
  isUploading: boolean;
  /**
   * One entry per file this hook has uploaded — accumulated across every
   * `upload()` call (keyless, keyed, and each item of a bulk `upload([...])`,
   * concurrent or sequential) until `reset()` clears the finished ones. An
   * entry keeps its position for the file's whole upload and is replaced by a
   * fresh snapshot on each change; its `status` always ends `"success"`,
   * `"error"` (with `error` set), or `"aborted"`.
   */
  uploads: readonly FileUploadState<TData>[];
  /** Aggregate progress over the current `uploads` entries. */
  progress: AggregateProgress;
  /** The last error from any verb (including errors thrown while iterating `listAll`/`search`). */
  error: FilesError | undefined;
  /**
   * Clear the ambient error and the finished `uploads` entries (in-flight ones
   * stay, as does `isUploading`), and re-arm after an `abort`.
   */
  reset: () => void;
  /** Abort every in-flight call this hook started; `cause` becomes the abort reason. */
  abort: (cause?: unknown) => void;
}

/* oxlint-disable react/refs, react/memo-dependencies, react/exhaustive-effect-dependencies, react-doctor/react-compiler-no-manual-memoization -- ships to consumers who are mostly NOT on the React Compiler; the manual useMemo and the lazy ref-init pattern (`if (ref.current === null) ref.current = …`) are required correctness, not dead weight */
export const useFiles = <TData = unknown>(
  opts: UseFilesOptions = {}
): UseFilesResult<TData> => {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // The root controller is created on first use and re-armed (replaced) after
  // an abort, so every closure reads it live through `root()` rather than
  // capturing one instance.
  const rootRef = useRef<AbortController | null>(null);
  const root = (): AbortController => {
    if (rootRef.current === null) {
      rootRef.current = new AbortController();
    }
    return rootRef.current;
  };

  const storeRef = useRef<ReturnType<typeof createStore> | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createStore();
  }
  const store = storeRef.current;
  const ledgerRef = useRef<ReturnType<typeof createUploadLedger> | null>(null);
  if (ledgerRef.current === null) {
    ledgerRef.current = createUploadLedger();
  }
  const ledger = ledgerRef.current;

  // Reads the root controller and the live options through refs, so every
  // closure that captured it still merges the current signals.
  const mergedSignals = (extra?: AbortSignal): AbortSignal => {
    const signals = [root().signal];
    if (optsRef.current.signal) {
      signals.push(optsRef.current.signal);
    }
    if (extra) {
      signals.push(extra);
    }
    // SAFETY: `mergeSignals` omits `signal` only for an empty list, and
    // `signals` always starts with the root controller's.
    return mergeSignals(signals).signal as AbortSignal;
  };
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
    return createFilesClient({
      concurrency,
      endpoint,
      fetchImpl: signalledFetch(baseFetch, mergedSignals),
      headers: async () => {
        const { headers } = optsRef.current;
        return isFunction(headers) ? await headers() : (headers ?? {});
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
      root().abort();
      // The ref survives a StrictMode (or any) remount, so leaving it aborted
      // here would make every call after the remount fail with "signal is
      // aborted without reason". Re-arm with a fresh controller — all cleanups
      // run before the remount's effects, so the next mount sees a live signal.
      // An explicit user `abort()` is untouched and still requires `reset()`.
      rootRef.current = new AbortController();
    },
    []
  );

  const result = useMemo<UseFilesResult>(() => {
    const recordError = (cause: unknown): void => {
      store.patch({ error: FilesError.wrap(cause) });
    };
    const remember = <T>(run: () => Promise<T>): Promise<T> =>
      rememberCall(run, recordError);

    // Folds every report into the ledger (so `uploads` accumulates across
    // calls), and hands the client the merged signal so a hook `abort()`
    // settles the file as "aborted" rather than "error".
    const trackProgress = (
      base?: UploadCallOptions & UploadManyCallOptions
    ): UploadCallOptions & UploadManyCallOptions => ({
      ...base,
      onProgress: (progress, perFile) => {
        store.setUploads(ledger.report(perFile));
        base?.onProgress?.(progress, perFile);
      },
      signal: mergedSignals(base?.signal),
    });

    // Mirrors the client's three `upload` overloads, dispatching on the same
    // argument shapes so progress tracking can be threaded into each.
    const upload = async (
      a: Blob | NativeFileRef | string | UploadManyClientItem[],
      b?: UploadBody | UploadCallOptions | UploadManyCallOptions,
      c?: UploadCallOptions
    ): Promise<UploadOutcome | UploadManyResult> => {
      store.patch({
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = error field unset; null would change the store shape
        error: undefined,
        inFlight: store.getState().inFlight + 1,
      });
      try {
        if (Array.isArray(a)) {
          // SAFETY: the bulk overload pairs an item array with `UploadManyCallOptions`.
          const bulkOpts = b as UploadManyCallOptions | undefined;
          return await client.upload(a, trackProgress(bulkOpts));
        }
        if (isString(a)) {
          // SAFETY: the keyed overload pairs a key with its `UploadBody`.
          return await client.upload(a, b as UploadBody, trackProgress(c));
        }
        // SAFETY: the keyless overload pairs a file with `UploadCallOptions`.
        const callOpts = b as UploadCallOptions | undefined;
        return await client.upload(a, trackProgress(callOpts));
      } catch (error) {
        const wrapped = FilesError.wrap(error);
        store.patch({ error: wrapped });
        throw wrapped;
      } finally {
        store.patch({ inFlight: Math.max(0, store.getState().inFlight - 1) });
      }
    };

    // SAFETY: `delete` / `download` / `exists` / `head` are overloaded (single
    // vs. bulk) and each shim forwards its arguments to the client's matching
    // overload untouched; `upload` re-implements the client's overload set on
    // the same argument shapes. The casts restore the overload signatures the
    // client declares.
    return {
      ...client,
      abort: (cause?: unknown) => {
        root().abort(cause);
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
      listAll: (o) => rememberIteration(client.listAll(o), recordError),
      move: (from, to, o) => remember(() => client.move(from, to, o)),
      progress: aggregate(state.uploads),
      purge: (k, o) => remember(() => client.purge(k, o)),
      reset: () => {
        if (root().signal.aborted) {
          rootRef.current = new AbortController();
        }
        // Keeps `inFlight` (and the entries of uploads still running): their
        // own settlement decrements it and reports their terminal status.
        store.patch({
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = error field unset; null would change the store shape
          error: undefined,
          uploads: ledger.clearFinished(),
        });
      },
      restoreTrashed: (k, o) => remember(() => client.restoreTrashed(k, o)),
      restoreVersion: (k, v, o) =>
        remember(() => client.restoreVersion(k, v, o)),
      search: (pattern, o) =>
        rememberIteration(client.search(pattern, o), recordError),
      signedUploadUrl: (k, o) => remember(() => client.signedUploadUrl(k, o)),
      trashed: (o) => remember(() => client.trashed(o)),
      upload: upload as FilesClient["upload"],
      uploads: state.uploads,
      url: (k, o) => remember(() => client.url(k, o)),
      versions: (k, o) => remember(() => client.versions(k, o)),
    };
  }, [client, store, ledger, state]);
  // SAFETY: `TData` only types the `data` each upload relays from the gateway's
  // `onUploadComplete` (see `createFilesClient`); the hook passes that value
  // through untouched, so the result built against `unknown` holds for `TData`.
  return result as UseFilesResult<TData>;
};
/* oxlint-enable react/refs, react/memo-dependencies, react/exhaustive-effect-dependencies, react-doctor/react-compiler-no-manual-memoization */
