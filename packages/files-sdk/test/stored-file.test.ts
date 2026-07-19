// oxlint-disable max-classes-per-file, unicorn/consistent-function-scoping -- in-test Blob/FileReader mock classes and fixture helpers.
import { afterEach, describe, expect, test } from "bun:test";

import { createStoredFile } from "../src/internal/stored-file.js";

const collectStream = async (
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- sequentially draining a stream reader
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
};

describe("createStoredFile", () => {
  test("buffer kind exposes bytes via text/blob/arrayBuffer", async () => {
    const sf = createStoredFile(
      { key: "a", size: 5, type: "text/plain" },
      { data: new TextEncoder().encode("hello"), kind: "buffer" }
    );
    expect(await sf.text()).toBe("hello");
    const blob = await sf.blob();
    expect(blob.size).toBe(5);
    expect(blob.type).toContain("text/plain");
    const buf = await sf.arrayBuffer();
    expect(new TextDecoder().decode(new Uint8Array(buf))).toBe("hello");
  });

  test("buffer kind: stream() returns the cached bytes when no native stream", async () => {
    const sf = createStoredFile(
      { key: "a", size: 3, type: "text/plain" },
      { data: new TextEncoder().encode("abc"), kind: "buffer" }
    );
    const out = await collectStream(sf.stream());
    expect(new TextDecoder().decode(out)).toBe("abc");
  });

  test("lazy kind invokes factory once and caches across reads", async () => {
    let calls = 0;
    const sf = createStoredFile(
      { key: "k", size: 3, type: "text/plain" },
      {
        factory: () => {
          calls += 1;
          return Promise.resolve(new TextEncoder().encode("abc"));
        },
        kind: "lazy",
      }
    );
    expect(await sf.text()).toBe("abc");
    expect(await sf.text()).toBe("abc");
    const out = await collectStream(sf.stream());
    expect(new TextDecoder().decode(out)).toBe("abc");
    expect(calls).toBe(1);
  });

  test("stream kind: stream() returns the underlying stream on first read", async () => {
    const sf = createStoredFile(
      { key: "k", size: 5, type: "text/plain" },
      {
        factory: () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode("hello"));
              c.close();
            },
          }),
        kind: "stream",
      }
    );
    const out = await collectStream(sf.stream());
    expect(new TextDecoder().decode(out)).toBe("hello");
  });

  test("stream kind: stream() consumes the source; text() afterwards throws", async () => {
    let factoryCalls = 0;
    const sf = createStoredFile(
      { key: "k", size: 5, type: "text/plain" },
      {
        factory: () => {
          factoryCalls += 1;
          return new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode("hello"));
              c.close();
            },
          });
        },
        kind: "stream",
      }
    );
    const userBranch = sf.stream();
    const out = await collectStream(userBranch);
    expect(new TextDecoder().decode(out)).toBe("hello");
    await expect(sf.text()).rejects.toThrow(/already consumed/u);
    expect(factoryCalls).toBe(1);
  });

  test("stream kind: stream() called twice throws", () => {
    let factoryCalls = 0;
    const sf = createStoredFile(
      { key: "k", size: 3, type: "text/plain" },
      {
        factory: () => {
          factoryCalls += 1;
          return new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode("abc"));
              c.close();
            },
          });
        },
        kind: "stream",
      }
    );
    sf.stream();
    expect(() => sf.stream()).toThrow(/already consumed/u);
    expect(factoryCalls).toBe(1);
  });

  test("stream kind: text() drains and caches; subsequent stream() uses cache", async () => {
    const sf = createStoredFile(
      { key: "k", size: 5, type: "text/plain" },
      {
        factory: () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode("ab"));
              c.enqueue(new TextEncoder().encode("cde"));
              c.close();
            },
          }),
        kind: "stream",
      }
    );
    expect(await sf.text()).toBe("abcde");
    const out = await collectStream(sf.stream());
    expect(new TextDecoder().decode(out)).toBe("abcde");
  });

  test("lazy kind: concurrent reads share the in-flight cache promise", async () => {
    let calls = 0;
    const deferred = Promise.withResolvers<Uint8Array>();
    const sf = createStoredFile(
      { key: "k", size: 3, type: "text/plain" },
      {
        factory: () => {
          calls += 1;
          return deferred.promise;
        },
        kind: "lazy",
      }
    );
    // Kick off two reads before the factory resolves — the second should
    // reuse the in-flight `cachePromise` rather than re-invoke the factory.
    const a = sf.text();
    const b = sf.text();
    deferred.resolve(new TextEncoder().encode("abc"));
    expect(await a).toBe("abc");
    expect(await b).toBe("abc");
    expect(calls).toBe(1);
  });

  test("lazy kind: stream() during in-flight load reuses the cache promise", async () => {
    const deferred = Promise.withResolvers<Uint8Array>();
    const sf = createStoredFile(
      { key: "k", size: 3, type: "text/plain" },
      {
        factory: () => deferred.promise,
        kind: "lazy",
      }
    );
    const textPromise = sf.text();
    // stream() is called while the lazy load is mid-flight — should hit
    // the `cachePromise` branch on `stream()` rather than re-load.
    const streamed = collectStream(sf.stream());
    deferred.resolve(new TextEncoder().encode("abc"));
    expect(await textPromise).toBe("abc");
    expect(new TextDecoder().decode(await streamed)).toBe("abc");
  });

  test("metadata fields are surfaced on the StoredFile", () => {
    const sf = createStoredFile(
      {
        etag: "e1",
        key: "name.txt",
        lastModified: 42,
        metadata: { foo: "bar" },
        size: 0,
        type: "text/plain",
      },
      { data: new Uint8Array(), kind: "buffer" }
    );
    expect(sf.key).toBe("name.txt");
    expect(sf.name).toBe("name.txt");
    expect(sf.etag).toBe("e1");
    expect(sf.lastModified).toBe(42);
    expect(sf.metadata).toEqual({ foo: "bar" });
  });
});

// React Native's Blob rejects ArrayBuffer/TypedArray parts, so blob() falls
// back to the source's native Blob (a Response.blob()) when one is provided.
describe("createStoredFile on a byte-rejecting Blob runtime", () => {
  const RealBlob = globalThis.Blob;
  const realFileReader = (globalThis as { FileReader?: unknown }).FileReader;
  afterEach(() => {
    globalThis.Blob = RealBlob;
    (globalThis as { FileReader?: unknown }).FileReader = realFileReader;
  });

  const installByteRejectingBlob = () => {
    globalThis.Blob = class extends RealBlob {
      constructor(parts?: BlobPart[], opts?: BlobPropertyBag) {
        if (
          parts?.some((p) => p instanceof ArrayBuffer || ArrayBuffer.isView(p))
        ) {
          throw new Error(
            "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported"
          );
        }
        super(parts, opts);
      }
    };
  };

  const lazySource = (text: string) => ({
    factory: () => Promise.resolve(new TextEncoder().encode(text)),
    kind: "lazy" as const,
  });

  test("blob() consumes the native Blob; byte accessors read back through it", async () => {
    installByteRejectingBlob();
    let calls = 0;
    const native = new RealBlob(["hello"], { type: "text/plain" });
    const sf = createStoredFile(
      { key: "k", size: 5, type: "text/plain" },
      lazySource("unused"),
      () => {
        calls += 1;
        return Promise.resolve(native);
      }
    );
    expect(await sf.blob()).toBe(native);
    // Second call reuses the consumed Blob instead of re-reading the source.
    expect(await sf.blob()).toBe(native);
    expect(calls).toBe(1);
    // Bytes are derived from the Blob, not the (already-consumed) source.
    expect(await sf.text()).toBe("hello");
    const buf = await sf.arrayBuffer();
    expect(new TextDecoder().decode(new Uint8Array(buf))).toBe("hello");
  });

  test("stream() after a native blob() drains the Blob's bytes", async () => {
    installByteRejectingBlob();
    const sf = createStoredFile(
      { key: "k", size: 5, type: "text/plain" },
      lazySource("unused"),
      () => Promise.resolve(new RealBlob(["hello"], { type: "text/plain" }))
    );
    await sf.blob();
    const reader = sf.stream().getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- sequential drain
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
    expect(new TextDecoder().decode(chunks[0])).toBe("hello");
  });

  test("blob() without a native source throws a clear FilesError", async () => {
    installByteRejectingBlob();
    const sf = createStoredFile(
      { key: "k", size: 3, type: "text/plain" },
      lazySource("abc")
    );
    await expect(sf.blob()).rejects.toThrow(/cannot wrap bytes/u);
  });

  test("blob() after a byte accessor throws a clear FilesError", async () => {
    installByteRejectingBlob();
    const sf = createStoredFile(
      { key: "k", size: 3, type: "text/plain" },
      lazySource("abc"),
      () => Promise.resolve(new RealBlob(["abc"]))
    );
    expect(await sf.text()).toBe("abc");
    await expect(sf.blob()).rejects.toThrow(/blob\(\) before/u);
  });

  test("Blobs without arrayBuffer() are read via FileReader", async () => {
    installByteRejectingBlob();
    const bytes = new TextEncoder().encode("hi");
    class FakeReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error: Error | null = null;
      result: ArrayBuffer | null = null;
      readAsArrayBuffer(_blob: unknown) {
        this.result = bytes.buffer as ArrayBuffer;
        queueMicrotask(() => this.onload?.());
      }
    }
    (globalThis as { FileReader?: unknown }).FileReader = FakeReader;
    const sf = createStoredFile(
      { key: "k", size: 2, type: "text/plain" },
      lazySource("unused"),
      () => Promise.resolve({ size: 2, type: "text/plain" } as Blob)
    );
    await sf.blob();
    expect(await sf.text()).toBe("hi");
  });

  test("FileReader failures reject the byte read", async () => {
    installByteRejectingBlob();
    class FailingReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error: Error | null = null;
      result: ArrayBuffer | null = null;
      readAsArrayBuffer(_blob: unknown) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    (globalThis as { FileReader?: unknown }).FileReader = FailingReader;
    const sf = createStoredFile(
      { key: "k", size: 2, type: "text/plain" },
      lazySource("unused"),
      () => Promise.resolve({ size: 2, type: "text/plain" } as Blob)
    );
    await sf.blob();
    await expect(sf.text()).rejects.toThrow(/FileReader failed/u);
  });
});
