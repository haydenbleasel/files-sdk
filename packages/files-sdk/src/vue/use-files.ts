import type { Ref } from "vue";
import { computed, getCurrentScope, onScopeDispose, shallowRef } from "vue";

import type {
  AggregateProgress,
  BulkCallOptions,
  FileUploadState,
  FilesClient,
  FilesClientConfig,
  NativeFileRef,
  UploadBody,
  UploadCallOptions,
  UploadManyClientItem,
  UploadOutcome,
} from "../client/index.js";
// oxlint-disable-next-line react-doctor/no-barrel-import -- public entrypoint; the client barrel is the documented import surface
import { aggregate, createFilesClient } from "../client/index.js";
import { defaultTransport } from "../client/transport.js";
import type { UploadManyResult } from "../index.js";
import { FilesError } from "../internal/errors.js";
import { isString } from "../internal/is.js";
import { mergeSignals } from "../internal/retry.js";

export interface UseFilesOptions extends FilesClientConfig {
  /** External signal merged into every call this composable makes. */
  signal?: AbortSignal;
}

export interface UseFilesReturn extends FilesClient {
  /** `true` while any `upload()` started here is in flight. */
  isUploading: Ref<boolean>;
  /** Per-file live state of the most recent upload. */
  uploads: Ref<readonly FileUploadState[]>;
  /** Aggregate progress across in-flight uploads. */
  progress: Ref<AggregateProgress>;
  /** The last error from any verb. */
  error: Ref<FilesError | undefined>;
  /** Clear the ambient error + upload state (and re-arm after an `abort`). */
  reset: () => void;
  /** Abort every in-flight call started here; `cause` becomes the abort reason. */
  abort: (cause?: unknown) => void;
}

export const useFiles = (opts: UseFilesOptions = {}): UseFilesReturn => {
  let root = new AbortController();
  const errorRef = shallowRef<FilesError | undefined>();
  const uploads = shallowRef<readonly FileUploadState[]>([]);
  const inFlight = shallowRef(0);
  const isUploading = computed(() => inFlight.value > 0);
  const progress = computed(() => aggregate(uploads.value));

  const baseFetch = opts.fetchImpl ?? fetch;
  const mergedSignal = (extra?: AbortSignal): AbortSignal => {
    const signals = [root.signal];
    if (opts.signal) {
      signals.push(opts.signal);
    }
    if (extra) {
      signals.push(extra);
    }
    // SAFETY: `mergeSignals` omits `signal` only for an empty list, and
    // `signals` always starts with the root controller's.
    return mergeSignals(signals).signal as AbortSignal;
  };

  // SAFETY: the client only ever calls `fetchImpl(input, init)`; the runtime
  // `typeof fetch` also declares static helpers (Bun's `preconnect`) that no
  // client code path reads.
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    baseFetch(input, {
      ...init,
      signal: mergedSignal(init?.signal ?? undefined),
    })) as typeof fetch;
  const client = createFilesClient({
    concurrency: opts.concurrency,
    endpoint: opts.endpoint,
    fetchImpl,
    headers: opts.headers,
    transport: (req) =>
      (opts.transport ?? defaultTransport(baseFetch))({
        ...req,
        signal: mergedSignal(req.signal),
      }),
  });

  const remember = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      errorRef.value = FilesError.wrap(error);
      throw error;
    }
  };

  const trackProgress = (base?: UploadCallOptions): UploadCallOptions => ({
    ...base,
    onProgress: (p, perFile) => {
      uploads.value = [...perFile];
      base?.onProgress?.(p, perFile);
    },
  });

  // Mirrors the client's three `upload` overloads, dispatching on the same
  // argument shapes so progress tracking can be threaded into each.
  const upload = async (
    a: Blob | NativeFileRef | string | UploadManyClientItem[],
    b?: UploadBody | UploadCallOptions | BulkCallOptions,
    c?: UploadCallOptions
  ): Promise<UploadOutcome | UploadManyResult> => {
    inFlight.value += 1;
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = error field unset; null would change the ref's shape
    errorRef.value = undefined;
    try {
      if (Array.isArray(a)) {
        // SAFETY: the bulk overload pairs an item array with `BulkCallOptions`.
        return await client.upload(a, b as BulkCallOptions | undefined);
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
      errorRef.value = wrapped;
      throw wrapped;
    } finally {
      inFlight.value = Math.max(0, inFlight.value - 1);
    }
  };

  if (getCurrentScope()) {
    onScopeDispose(() => root.abort());
  }

  // SAFETY: `delete` / `download` / `exists` / `head` are overloaded (single
  // vs. bulk) and each shim forwards its arguments to the client's matching
  // overload untouched; `upload` re-implements the client's overload set on the
  // same argument shapes. The casts restore the overload signatures the client
  // declares.
  return {
    ...client,
    abort: (cause?: unknown) => root.abort(cause),
    capabilities: (o) => remember(() => client.capabilities(o)),
    copy: (from, to, o) => remember(() => client.copy(from, to, o)),
    delete: ((k: never, o: never) =>
      remember(() => client.delete(k, o))) as FilesClient["delete"],
    download: ((k: never, o: never) =>
      remember(() => client.download(k, o))) as FilesClient["download"],
    error: errorRef,
    exists: ((k: never, o: never) =>
      remember(() => client.exists(k, o))) as FilesClient["exists"],
    head: ((k: never, o: never) =>
      remember(() => client.head(k, o))) as FilesClient["head"],
    isUploading,
    list: (o) => remember(() => client.list(o)),
    move: (from, to, o) => remember(() => client.move(from, to, o)),
    progress,
    reset: () => {
      if (root.signal.aborted) {
        root = new AbortController();
      }
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = error field unset; null would change the ref's shape
      errorRef.value = undefined;
      uploads.value = [];
    },
    signedUploadUrl: (k, o) => remember(() => client.signedUploadUrl(k, o)),
    upload: upload as FilesClient["upload"],
    uploads,
    url: (k, o) => remember(() => client.url(k, o)),
  };
};
