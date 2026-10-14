import type { FileInfo, StoredFile } from "../index.js";
import { collectStream } from "./core.js";
import { FilesError } from "./errors.js";
import { isFunction } from "./is.js";
import { abortError, runWithSignal } from "./retry.js";

export type BodySource =
  | { kind: "buffer"; data: Uint8Array }
  | { kind: "stream"; factory: () => ReadableStream<Uint8Array> }
  | { kind: "lazy"; factory: () => Promise<Uint8Array> };

const streamFromBytes = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const streamFromPromise = (
  bytesPromise: Promise<Uint8Array>
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      const bytes = await bytesPromise;
      controller.enqueue(bytes);
      controller.close();
    },
  });

/**
 * A StoredFile's buffering accessors, each taking a `signal`. Not on the
 * public `StoredFile` type: the Effect bridge reads through them so an
 * interrupted `text`/`arrayBuffer`/`blob` cancels the body read underneath.
 */
export interface BufferedReads {
  arrayBuffer: (signal?: AbortSignal) => Promise<ArrayBuffer>;
  blob: (signal?: AbortSignal) => Promise<Blob>;
  text: (signal?: AbortSignal) => Promise<string>;
}

/**
 * Where {@link createStoredFile} keeps its {@link BufferedReads}. A registry
 * symbol so it survives the core and a binding loading from different
 * bundles, and stays off the public surface. Object spread copies it, so the
 * `Files` prefix rewrap keeps it too.
 */
const BUFFERED_READS: unique symbol = Symbol.for("files-sdk.bufferedReads");

type WithBufferedReads = StoredFile & { [BUFFERED_READS]: BufferedReads };

// Only `createStoredFile` (and wrappers built with `withBufferedReads`) set
// the symbol, always to a `BufferedReads`.
const hasBufferedReads = (file: StoredFile): file is WithBufferedReads =>
  BUFFERED_READS in file;

/**
 * `file`'s signal-aware buffering accessors. A StoredFile built some other way
 * (a hand-rolled adapter's) has none, so its plain accessors stand in and the
 * signal only stops the caller waiting.
 */
export const bufferedReads = (file: StoredFile): BufferedReads =>
  hasBufferedReads(file)
    ? file[BUFFERED_READS]
    : {
        arrayBuffer: () => file.arrayBuffer(),
        blob: () => file.blob(),
        text: () => file.text(),
      };

/**
 * Attach `reads` to a StoredFile wrapper, so a wrapper (the `usage()` meter)
 * keeps the body read cancellable.
 */
export const withBufferedReads = (
  file: StoredFile,
  reads: BufferedReads
): StoredFile => {
  const wrapped: WithBufferedReads = { ...file, [BUFFERED_READS]: reads };
  return wrapped;
};

const consumedError = (): FilesError =>
  new FilesError(
    "Invalid",
    "StoredFile body was already consumed via stream(). For multi-format access, call text()/arrayBuffer()/blob() before stream() — those drain into a cache."
  );

/** Whether this runtime's `Blob` accepts byte parts (React Native's does not). */
const supportsByteBlobs = (): boolean => {
  try {
    return new Blob([new Uint8Array(0)]).size === 0;
  } catch {
    return false;
  }
};

/** Read a Blob's bytes — via `arrayBuffer()`, or `FileReader` where it's absent (React Native). */
const blobBytes = async (blob: Blob): Promise<Uint8Array> => {
  if (isFunction(blob.arrayBuffer)) {
    return new Uint8Array(await blob.arrayBuffer());
  }
  // oxlint-disable-next-line promise/avoid-new -- FileReader is callback-only; there is no promise API to return
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    // SAFETY: `readAsArrayBuffer` populates `result` with an `ArrayBuffer`
    // by the time `load` fires; the `string | null` arms belong to the other
    // read modes and the not-yet-loaded state.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- single handler on a throwaway reader; RN's FileReader guarantees the on* properties
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- see above
    reader.onerror = () =>
      reject(reader.error ?? new Error("FileReader failed"));
    // oxlint-disable-next-line unicorn/prefer-blob-reading-methods -- this branch only runs when Blob#arrayBuffer() does not exist (React Native)
    reader.readAsArrayBuffer(blob);
  });
};

export const createStoredFile = (
  meta: FileInfo,
  body: BodySource,
  // A native Blob source (e.g. `Response.blob()`) for runtimes whose Blob
  // cannot wrap raw bytes — React Native. Used by blob() only when the bytes
  // path is impossible; byte accessors afterwards read back through the Blob.
  nativeBlob?: () => Promise<Blob>
): StoredFile => {
  // For `stream` kind, the underlying source is consumed at most once. The
  // first accessor wins:
  //  - stream() returns the source stream directly (no buffering)
  //  - text()/arrayBuffer()/blob() drains the stream into `cached` so
  //    subsequent reads are cheap
  // Calling stream() and then a buffering accessor (or vice-versa) throws,
  // because we no longer secretly tee+buffer the whole object — that defeated
  // the point of asking for a stream and was a real OOM hazard for large
  // downloads.
  //
  // A signalled read (see `BufferedReads`) stops waiting when its signal
  // aborts, and once every signalled reader of a stream drain has left that
  // way, the drain is cancelled so the body stops downloading. A plain read
  // (or `stream()`) joining the drain holds it, so a caller without a signal
  // never has its read cut short by someone else's abort.
  let cached: Uint8Array | undefined;
  let cachePromise: Promise<Uint8Array> | undefined;
  let streamConsumed = false;
  let nativeBlobPromise: Promise<Blob> | undefined;
  let drain:
    | { controller: AbortController; held: boolean; waiting: number }
    | undefined;

  const cacheFrom = async (
    source: () => Promise<Uint8Array>
  ): Promise<Uint8Array> => {
    const bytes = await source();
    cached = bytes;
    return bytes;
  };

  const load = (): Promise<Uint8Array> => {
    if (cached) {
      return Promise.resolve(cached);
    }
    if (cachePromise) {
      return cachePromise;
    }
    if (nativeBlobPromise) {
      // blob() already consumed the source as a native Blob — read the bytes
      // back through it rather than re-consuming the source.
      const pending = nativeBlobPromise;
      cachePromise = cacheFrom(async () => blobBytes(await pending));
      return cachePromise;
    }
    if (body.kind === "buffer") {
      cached = body.data;
      return Promise.resolve(cached);
    }
    if (body.kind === "lazy") {
      cachePromise = cacheFrom(body.factory);
      return cachePromise;
    }
    if (streamConsumed) {
      return Promise.reject(consumedError());
    }
    const stream = body.factory();
    const controller = new AbortController();
    drain = { controller, held: false, waiting: 0 };
    cachePromise = cacheFrom(async () => {
      try {
        return await collectStream(stream, controller.signal);
      } catch (error) {
        throw controller.signal.aborted
          ? new FilesError(
              "Provider",
              "StoredFile body read was cancelled before it finished. Download the object again to read it.",
              error,
              { aborted: true }
            )
          : error;
      } finally {
        drain = undefined;
      }
    });
    return cachePromise;
  };

  const toBytes = async (signal?: AbortSignal): Promise<Uint8Array> => {
    if (!signal) {
      const pending = load();
      if (drain) {
        drain.held = true;
      }
      return await pending;
    }
    if (signal.aborted) {
      throw abortError(signal.reason);
    }
    const pending = load();
    const current = drain;
    if (!current) {
      return await runWithSignal(signal, () => pending);
    }
    current.waiting += 1;
    const leave = () => {
      current.waiting -= 1;
      if (current.waiting === 0 && !current.held) {
        current.controller.abort(signal.reason);
      }
    };
    signal.addEventListener("abort", leave, { once: true });
    try {
      return await runWithSignal(signal, () => pending);
    } finally {
      signal.removeEventListener("abort", leave);
    }
  };

  const reads: BufferedReads = {
    async arrayBuffer(signal) {
      const bytes = await toBytes(signal);
      // SAFETY: download bytes come from `collectStream`, `Response#arrayBuffer`
      // or an adapter SDK buffer — never a `SharedArrayBuffer` — and `slice`
      // preserves the backing kind, so the copy is a plain `ArrayBuffer`.
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
    },
    async blob(signal) {
      if (nativeBlobPromise) {
        return await nativeBlobPromise;
      }
      if (
        nativeBlob &&
        cached === undefined &&
        cachePromise === undefined &&
        !supportsByteBlobs()
      ) {
        // React Native: Blob can't wrap bytes, but the source (a Response)
        // can produce a native Blob directly — consume it as one.
        nativeBlobPromise = nativeBlob();
        return await nativeBlobPromise;
      }
      const bytes = await toBytes(signal);
      try {
        // SAFETY: `BlobPart` pins the view to `ArrayBuffer` backing; see
        // `arrayBuffer()` above — download bytes never share memory.
        return new Blob([bytes as BlobPart], { type: meta.contentType });
      } catch (error) {
        // React Native, after the bytes were already materialized (a byte
        // accessor ran first, or the source has no native Blob form).
        throw new FilesError(
          "Unsupported",
          "this runtime's Blob cannot wrap bytes (React Native). Call blob() before text()/arrayBuffer(), or read the download with arrayBuffer() instead.",
          error
        );
      }
    },
    async text(signal) {
      const bytes = await toBytes(signal);
      return new TextDecoder().decode(bytes);
    },
  };

  const file: WithBufferedReads = {
    [BUFFERED_READS]: reads,
    arrayBuffer: () => reads.arrayBuffer(),
    blob: () => reads.blob(),
    contentType: meta.contentType,
    etag: meta.etag,
    key: meta.key,
    lastModified: meta.lastModified,
    metadata: meta.metadata,
    name: meta.key,
    size: meta.size,
    stream() {
      if (cached) {
        return streamFromBytes(cached);
      }
      if (cachePromise) {
        return streamFromPromise(toBytes());
      }
      if (body.kind === "stream") {
        if (streamConsumed) {
          throw consumedError();
        }
        streamConsumed = true;
        return body.factory();
      }
      return streamFromPromise(toBytes());
    },
    text: () => reads.text(),
    type: meta.contentType,
  };
  return file;
};
