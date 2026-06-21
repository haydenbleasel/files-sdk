import type {
  AggregateProgress,
  FileUploadState,
  FilesClient,
  FilesClientConfig,
  UploadBody,
  UploadCallOptions,
} from "../client/index.js";
import { aggregate, createFilesClient } from "../client/index.js";
import { defaultTransport } from "../client/transport.js";
import { FilesError } from "../internal/errors.js";
import { mergeSignals } from "../internal/retry.js";
import type { ReadableStore } from "./store.js";
import { writable } from "./store.js";

export interface UseFilesOptions extends FilesClientConfig {
  /** External signal merged into every call this binding makes. */
  signal?: AbortSignal;
}

export interface UseFilesReturn extends FilesClient {
  /** `true` while any `upload()` started here is in flight. */
  isUploading: ReadableStore<boolean>;
  /** Per-file live state of the most recent upload. */
  uploads: ReadableStore<readonly FileUploadState[]>;
  /** Aggregate progress across in-flight uploads. */
  progress: ReadableStore<AggregateProgress>;
  /** The last error from any verb. */
  error: ReadableStore<FilesError | undefined>;
  /** Clear the ambient error + upload state (and re-arm after an `abort`). */
  reset(): void;
  /** Abort every in-flight call started here (call from `onDestroy`). */
  abort(reason?: unknown): void;
}

export const useFiles = (opts: UseFilesOptions = {}): UseFilesReturn => {
  let root = new AbortController();
  let inFlight = 0;
  const errorStore = writable<FilesError | undefined>();
  const uploads = writable<readonly FileUploadState[]>([]);
  const isUploading = writable(false);
  const progress = writable<AggregateProgress>(aggregate([]));

  const setUploads = (next: readonly FileUploadState[]) => {
    uploads.set(next);
    progress.set(aggregate(next));
  };
  const setInFlight = (next: number) => {
    inFlight = Math.max(0, next);
    isUploading.set(inFlight > 0);
  };

  const baseFetch = opts.fetchImpl ?? fetch;
  const mergedSignal = (extra?: AbortSignal): AbortSignal => {
    const signals = [root.signal];
    if (opts.signal) {
      signals.push(opts.signal);
    }
    if (extra) {
      signals.push(extra);
    }
    return mergeSignals(signals).signal as AbortSignal;
  };

  const client = createFilesClient({
    concurrency: opts.concurrency,
    endpoint: opts.endpoint,
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
      baseFetch(input, {
        ...init,
        signal: mergedSignal(init?.signal ?? undefined),
      })) as typeof fetch,
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
      errorStore.set(FilesError.wrap(error));
      throw error;
    }
  };

  const trackProgress = (base?: UploadCallOptions): UploadCallOptions => ({
    ...base,
    onProgress: (p, perFile) => {
      setUploads([...perFile]);
      base?.onProgress?.(p, perFile);
    },
  });

  const upload = async (
    a: Blob | string | unknown[],
    b?: unknown,
    c?: unknown
  ): Promise<unknown> => {
    setInFlight(inFlight + 1);
    errorStore.set(undefined);
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
      errorStore.set(wrapped);
      throw wrapped;
    } finally {
      setInFlight(inFlight - 1);
    }
  };

  return {
    ...client,
    abort: (reason?: unknown) => root.abort(reason),
    capabilities: (o) => remember(() => client.capabilities(o)),
    copy: (from, to, o) => remember(() => client.copy(from, to, o)),
    delete: ((k: never, o: never) =>
      remember(() => client.delete(k, o))) as FilesClient["delete"],
    download: ((k: never, o: never) =>
      remember(() => client.download(k, o))) as FilesClient["download"],
    error: errorStore,
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
      errorStore.set(undefined);
      setUploads([]);
    },
    signedUploadUrl: (k, o) => remember(() => client.signedUploadUrl(k, o)),
    upload: upload as FilesClient["upload"],
    uploads,
    url: (k, o) => remember(() => client.url(k, o)),
  };
};
