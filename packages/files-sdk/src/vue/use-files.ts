import type { Ref } from "vue";
import { computed, getCurrentScope, onScopeDispose, shallowRef } from "vue";

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
  /** Abort every in-flight call started here. */
  abort: (reason?: unknown) => void;
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

  const upload = async (
    a: Blob | string | unknown[],
    b?: unknown,
    c?: unknown
  ): Promise<unknown> => {
    inFlight.value += 1;
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = error field unset; null would change the ref's shape
    errorRef.value = undefined;
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
      errorRef.value = wrapped;
      throw wrapped;
    } finally {
      inFlight.value = Math.max(0, inFlight.value - 1);
    }
  };

  if (getCurrentScope()) {
    onScopeDispose(() => root.abort());
  }

  return {
    ...client,
    abort: (reason?: unknown) => root.abort(reason),
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
