import type { StoredFile } from "../index.js";
import { collectStream } from "./core.js";
import { FilesError } from "./errors.js";

export interface StoredFileMeta {
  key: string;
  size: number;
  type: string;
  lastModified?: number;
  etag?: string;
  metadata?: Record<string, string>;
}

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

const consumedError = (): FilesError =>
  new FilesError(
    "Provider",
    "StoredFile body was already consumed via stream(). For multi-format access, call text()/arrayBuffer()/blob() before stream() — those drain into a cache."
  );

/** Whether this runtime's `Blob` accepts byte parts (React Native's does not). */
const supportsByteBlobs = (): boolean => {
  try {
    return new Blob([new Uint8Array(0) as BlobPart]).size === 0;
  } catch {
    return false;
  }
};

/** Read a Blob's bytes — via `arrayBuffer()`, or `FileReader` where it's absent (React Native). */
const blobBytes = async (blob: Blob): Promise<Uint8Array> => {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  // oxlint-disable-next-line promise/avoid-new -- FileReader is callback-only; there is no promise API to return
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
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
  meta: StoredFileMeta,
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
  let cached: Uint8Array | undefined;
  let cachePromise: Promise<Uint8Array> | undefined;
  let streamConsumed = false;
  let nativeBlobPromise: Promise<Blob> | undefined;

  const cacheFrom = async (
    source: () => Promise<Uint8Array>
  ): Promise<Uint8Array> => {
    const bytes = await source();
    cached = bytes;
    return bytes;
  };

  const toBytes = (): Promise<Uint8Array> => {
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
    cachePromise = cacheFrom(() => collectStream(stream));
    return cachePromise;
  };

  return {
    async arrayBuffer() {
      const bytes = await toBytes();
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
    },
    async blob() {
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
      const bytes = await toBytes();
      try {
        return new Blob([bytes as BlobPart], { type: meta.type });
      } catch (error) {
        // React Native, after the bytes were already materialized (a byte
        // accessor ran first, or the source has no native Blob form).
        throw new FilesError(
          "Provider",
          "this runtime's Blob cannot wrap bytes (React Native). Call blob() before text()/arrayBuffer(), or read the download with arrayBuffer() instead.",
          error
        );
      }
    },
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
        return streamFromPromise(cachePromise);
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
    async text() {
      const bytes = await toBytes();
      return new TextDecoder().decode(bytes);
    },
    type: meta.type,
  };
};
