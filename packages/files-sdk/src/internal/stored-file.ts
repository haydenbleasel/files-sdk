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

export const createStoredFile = (
  meta: StoredFileMeta,
  body: BodySource
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

  const consumedError = (): FilesError =>
    new FilesError(
      "Provider",
      "StoredFile body was already consumed via stream(). For multi-format access, call text()/arrayBuffer()/blob() before stream() — those drain into a cache."
    );

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
      const bytes = await toBytes();
      return new Blob([bytes as BlobPart], { type: meta.type });
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
