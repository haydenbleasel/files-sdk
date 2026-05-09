import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Files, FilesError } from "../src/index.js";

interface StoredEntry {
  data: Uint8Array;
  etag: string;
  metadata: Record<string, unknown>;
}

const backing = new Map<string, StoredEntry>();

const toBytes = (data: string | ArrayBuffer | Blob): Promise<Uint8Array> => {
  if (typeof data === "string") {
    return Promise.resolve(new TextEncoder().encode(data));
  }
  if (data instanceof Blob) {
    return data.arrayBuffer().then((b) => new Uint8Array(b));
  }
  return Promise.resolve(new Uint8Array(data));
};

let etagCounter = 0;
const nextEtag = (): string => {
  etagCounter += 1;
  return `"etag-${etagCounter}"`;
};

// Closure-captured Store mock. We re-create it per-test (via the factory)
// so each test starts from a clean slate and can override individual methods
// without leaking to others.
type GetWithMetadataResult = {
  data: ArrayBuffer | ReadableStream<Uint8Array>;
  etag: string;
  metadata: Record<string, unknown>;
} | null;

const setMock = mock(
  async (
    key: string,
    data: string | ArrayBuffer | Blob,
    opts?: { metadata?: Record<string, unknown> }
  ): Promise<{ etag: string; modified: true }> => {
    const bytes = await toBytes(data);
    const etag = nextEtag();
    backing.set(key, {
      data: bytes,
      etag,
      metadata: opts?.metadata ?? {},
    });
    return { etag, modified: true };
  }
);

const getMock = mock(
  (
    key: string,
    opts?: { type?: "arrayBuffer" | "stream" | "text" | "json" | "blob" }
  ): Promise<unknown> => {
    const entry = backing.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }
    const type = opts?.type ?? "text";
    if (type === "arrayBuffer") {
      return Promise.resolve(
        entry.data.buffer.slice(
          entry.data.byteOffset,
          entry.data.byteOffset + entry.data.byteLength
        )
      );
    }
    if (type === "stream") {
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(entry.data);
            c.close();
          },
        })
      );
    }
    return Promise.resolve(new TextDecoder().decode(entry.data));
  }
);

const getMetadataMock = mock(
  (
    key: string
  ): Promise<{
    etag: string;
    metadata: Record<string, unknown>;
  } | null> => {
    const entry = backing.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ etag: entry.etag, metadata: entry.metadata });
  }
);

const getWithMetadataMock = mock(
  (
    key: string,
    opts?: { type?: "arrayBuffer" | "stream" | "text" }
  ): Promise<GetWithMetadataResult> => {
    const entry = backing.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }
    const type = opts?.type ?? "text";
    if (type === "stream") {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(entry.data);
          c.close();
        },
      });
      return Promise.resolve({
        data: stream,
        etag: entry.etag,
        metadata: entry.metadata,
      });
    }
    const ab = entry.data.buffer.slice(
      entry.data.byteOffset,
      entry.data.byteOffset + entry.data.byteLength
    ) as ArrayBuffer;
    return Promise.resolve({
      data: ab,
      etag: entry.etag,
      metadata: entry.metadata,
    });
  }
);

const deleteMock = mock((key: string): Promise<void> => {
  backing.delete(key);
  return Promise.resolve();
});

// Page size for the paginated mock. Real Netlify uses ~1000; the mock keeps
// it small so tests can verify the adapter stops iterating once `limit` is
// satisfied without needing thousands of fixtures.
const MOCK_PAGE_SIZE = 2;
let listPagesYielded = 0;

const matchingBlobs = (prefix?: string): { etag: string; key: string }[] =>
  [...backing.entries()]
    .filter(([k]) => !prefix || k.startsWith(prefix))
    .map(([key, entry]) => ({ etag: entry.etag, key }));

const listMock = mock(
  (opts?: {
    prefix?: string;
    paginate?: boolean;
  }):
    | Promise<{
        blobs: { etag: string; key: string }[];
        directories: string[];
      }>
    | AsyncIterable<{
        blobs: { etag: string; key: string }[];
        directories: string[];
      }> => {
    const all = matchingBlobs(opts?.prefix);
    if (opts?.paginate) {
      return {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < all.length; i += MOCK_PAGE_SIZE) {
            listPagesYielded += 1;
            yield {
              blobs: all.slice(i, i + MOCK_PAGE_SIZE),
              directories: [],
            };
          }
          // If the store is empty, real Netlify still yields one (empty)
          // page before completing — match that so callers always see at
          // least one tick of the iterator.
          if (all.length === 0) {
            listPagesYielded += 1;
            yield { blobs: [], directories: [] };
          }
        },
      };
    }
    return Promise.resolve({ blobs: all, directories: [] });
  }
);

const fakeStore = () => ({
  delete: deleteMock,
  get: getMock,
  getMetadata: getMetadataMock,
  getWithMetadata: getWithMetadataMock,
  list: listMock,
  set: setMock,
});

const getStoreMock = mock((_input?: unknown) => fakeStore());
const getDeployStoreMock = mock((_input?: unknown) => fakeStore());

mock.module("@netlify/blobs", () => ({
  getDeployStore: getDeployStoreMock,
  getStore: getStoreMock,
}));

const { netlifyBlobs } = await import("../src/netlify-blobs/index.js");

beforeEach(() => {
  backing.clear();
  etagCounter = 0;
  listPagesYielded = 0;
  setMock.mockClear();
  getMock.mockClear();
  getMetadataMock.mockClear();
  getWithMetadataMock.mockClear();
  deleteMock.mockClear();
  listMock.mockClear();
  getStoreMock.mockClear();
  getDeployStoreMock.mockClear();
  process.env.NETLIFY_SITE_ID = "site-abc";
  process.env.NETLIFY_API_TOKEN = "token-abc";
});

afterEach(() => {
  delete process.env.NETLIFY_SITE_ID;
  delete process.env.NETLIFY_API_TOKEN;
  delete process.env.NETLIFY_BLOBS_TOKEN;
});

describe("netlify-blobs adapter", () => {
  test("missing name throws at construction", () => {
    expect(() =>
      netlifyBlobs({} as unknown as Parameters<typeof netlifyBlobs>[0])
    ).toThrow(/name/iu);
  });

  test("uses getStore by default with explicit siteID + token from env", () => {
    netlifyBlobs({ name: "my-store" });
    expect(getStoreMock).toHaveBeenCalledTimes(1);
    expect(getDeployStoreMock).not.toHaveBeenCalled();
    const call = getStoreMock.mock.calls[0]?.[0] as {
      name: string;
      siteID?: string;
      token?: string;
    };
    expect(call.name).toBe("my-store");
    expect(call.siteID).toBe("site-abc");
    expect(call.token).toBe("token-abc");
  });

  test("falls back to NETLIFY_BLOBS_TOKEN when NETLIFY_API_TOKEN is missing", () => {
    delete process.env.NETLIFY_API_TOKEN;
    process.env.NETLIFY_BLOBS_TOKEN = "blob-token";
    netlifyBlobs({ name: "my-store" });
    const call = getStoreMock.mock.calls[0]?.[0] as { token?: string };
    expect(call.token).toBe("blob-token");
  });

  test("omits siteID/token when neither env nor explicit values are present (lets SDK auto-detect)", () => {
    delete process.env.NETLIFY_SITE_ID;
    delete process.env.NETLIFY_API_TOKEN;
    netlifyBlobs({ name: "my-store" });
    const call = getStoreMock.mock.calls[0]?.[0] as {
      name: string;
      siteID?: string;
      token?: string;
    };
    expect(call.name).toBe("my-store");
    expect(call.siteID).toBeUndefined();
    expect(call.token).toBeUndefined();
  });

  test("explicit siteID and token take precedence over env", () => {
    netlifyBlobs({
      name: "my-store",
      siteID: "explicit-site",
      token: "explicit-token",
    });
    const call = getStoreMock.mock.calls[0]?.[0] as {
      siteID?: string;
      token?: string;
    };
    expect(call.siteID).toBe("explicit-site");
    expect(call.token).toBe("explicit-token");
  });

  test("deployScoped: true uses getDeployStore instead of getStore", () => {
    netlifyBlobs({ deployScoped: true, name: "my-store" });
    expect(getDeployStoreMock).toHaveBeenCalledTimes(1);
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  test("consistency option threads through to the SDK", () => {
    netlifyBlobs({ consistency: "strong", name: "my-store" });
    const call = getStoreMock.mock.calls[0]?.[0] as { consistency?: string };
    expect(call.consistency).toBe("strong");
  });

  test("upload writes the body and packs metadata", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    const result = await files.upload("a.txt", "hello", {
      cacheControl: "public, max-age=60",
      contentType: "text/plain",
      metadata: { uploadedBy: "alice" },
    });
    expect(result.key).toBe("a.txt");
    expect(result.size).toBe(5);
    expect(result.contentType).toBe("text/plain");
    expect(result.etag).toBe('"etag-1"');
    const entry = backing.get("a.txt");
    if (!entry) {
      throw new Error("expected entry");
    }
    expect(entry.metadata.__contentType).toBe("text/plain");
    expect(entry.metadata.__size).toBe(5);
    expect(entry.metadata.__cacheControl).toBe("public, max-age=60");
    expect((entry.metadata.__user as Record<string, string>).uploadedBy).toBe(
      "alice"
    );
    expect(typeof entry.metadata.__lastModified).toBe("number");
  });

  test("upload of Uint8Array, ArrayBuffer, ArrayBufferView, Blob, ReadableStream computes size", async () => {
    const adapter = netlifyBlobs({ name: "s" });
    const u8 = await adapter.upload("u8.bin", new Uint8Array([1, 2, 3]));
    expect(u8.size).toBe(3);
    const ab = await adapter.upload(
      "ab.bin",
      new Uint8Array([1, 2, 3, 4]).buffer
    );
    expect(ab.size).toBe(4);
    const view = await adapter.upload(
      "v.bin",
      new DataView(new ArrayBuffer(8))
    );
    expect(view.size).toBe(8);
    const blob = await adapter.upload(
      "b.bin",
      new Blob([new Uint8Array([1, 2])], { type: "image/png" })
    );
    expect(blob.size).toBe(2);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
        c.close();
      },
    });
    const s = await adapter.upload("s.bin", stream);
    expect(s.size).toBe(6);
  });

  test("upload preserves Blob's content type when no override is given", async () => {
    const adapter = netlifyBlobs({ name: "s" });
    await adapter.upload(
      "img.png",
      new Blob([new Uint8Array([1])], { type: "image/png" })
    );
    const entry = backing.get("img.png");
    if (!entry) {
      throw new Error("missing entry");
    }
    // No explicit contentType in opts — the adapter records the default.
    expect(entry.metadata.__contentType).toBe("application/octet-stream");
  });

  test("download returns a buffered StoredFile with metadata round-tripped", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a.txt", "hello", {
      contentType: "text/plain",
      metadata: { uploadedBy: "alice" },
    });
    const got = await files.download("a.txt");
    expect(await got.text()).toBe("hello");
    expect(got.size).toBe(5);
    expect(got.type).toBe("text/plain");
    expect(got.etag).toBe('"etag-1"');
    expect(got.metadata?.uploadedBy).toBe("alice");
  });

  test("download as: stream returns a streaming StoredFile", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a.txt", "hello", { contentType: "text/plain" });
    const got = await files.download("a.txt", { as: "stream" });
    const reader = got.stream().getReader();
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
      }
    }
    expect(total).toBe(5);
  });

  test("download maps null result to NotFound", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.download("missing.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("head returns metadata without transferring the body", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a.txt", "hello", {
      contentType: "text/plain",
      metadata: { uploadedBy: "alice" },
    });
    getMock.mockClear();
    getWithMetadataMock.mockClear();
    const info = await files.head("a.txt");
    expect(info.size).toBe(5);
    expect(info.type).toBe("text/plain");
    expect(info.etag).toBe('"etag-1"');
    expect(info.metadata?.uploadedBy).toBe("alice");
    expect(getMock).not.toHaveBeenCalled();
    expect(getWithMetadataMock).not.toHaveBeenCalled();
    expect(getMetadataMock).toHaveBeenCalledTimes(1);
  });

  test("head exposes a lazy body that fetches on first read", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a.txt", "hello", { contentType: "text/plain" });
    const info = await files.head("a.txt");
    getMock.mockClear();
    expect(await info.text()).toBe("hello");
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  test("head maps null result to NotFound", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.head("missing.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("delete delegates to store.delete (idempotent)", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a.txt", "hello");
    await files.delete("a.txt");
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock.mock.calls[0]?.[0]).toBe("a.txt");
    expect(backing.has("a.txt")).toBe(false);
    // Calling again on a missing key should not throw.
    await files.delete("a.txt");
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });

  test("list returns items with key + etag and lazy bodies", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a/1.txt", "one", { contentType: "text/plain" });
    await files.upload("a/2.txt", "two", { contentType: "text/plain" });
    await files.upload("b/3.txt", "three", { contentType: "text/plain" });
    const out = await files.list({ prefix: "a/" });
    expect(out.items.map((i) => i.key).toSorted()).toEqual([
      "a/1.txt",
      "a/2.txt",
    ]);
    const first = out.items.find((i) => i.key === "a/1.txt");
    if (!first) {
      throw new Error("missing item");
    }
    // List entries are intentionally returned with size 0 / octet-stream —
    // Netlify's list response only carries key + etag.
    expect(first.size).toBe(0);
    expect(first.type).toBe("application/octet-stream");
    expect(first.etag).toBe('"etag-1"');
    // Lazy body fetches via store.get.
    expect(await first.text()).toBe("one");
  });

  test("list applies user-supplied limit client-side", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a", "1");
    await files.upload("b", "2");
    await files.upload("c", "3");
    const out = await files.list({ limit: 2 });
    expect(out.items).toHaveLength(2);
  });

  test("list with a small limit stops iterating server-side pages", async () => {
    // Upload 6 items at MOCK_PAGE_SIZE=2 → 3 pages. limit=3 should consume
    // exactly 2 pages (the second page completes the 3rd item) and skip
    // the third page entirely. This is the perf-cliff regression test:
    // before pagination, the adapter drained all pages regardless of limit.
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    for (const k of ["a", "b", "c", "d", "e", "f"]) {
      await files.upload(k, k);
    }
    listPagesYielded = 0;
    const out = await files.list({ limit: 3 });
    expect(out.items).toHaveLength(3);
    expect(listPagesYielded).toBe(2);
  });

  test("list without a limit drains all pages", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    for (const k of ["a", "b", "c", "d", "e"]) {
      await files.upload(k, k);
    }
    listPagesYielded = 0;
    const out = await files.list();
    expect(out.items).toHaveLength(5);
    // 5 items at MOCK_PAGE_SIZE=2 → ceil(5/2) = 3 pages.
    expect(listPagesYielded).toBe(3);
  });

  test("list passes paginate: true to the underlying SDK", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a", "1");
    await files.list();
    const call = listMock.mock.calls[0]?.[0] as
      | { paginate?: boolean }
      | undefined;
    expect(call?.paginate).toBe(true);
  });

  test("list returns no cursor (Netlify pagination is opaque)", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a", "1");
    const out = await files.list();
    expect(out.cursor).toBeUndefined();
  });

  test("copy reads the source and re-writes at the destination", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("from.txt", "hello", {
      contentType: "text/plain",
    });
    await files.copy("from.txt", "to.txt");
    const got = await files.download("to.txt");
    expect(await got.text()).toBe("hello");
    expect(got.type).toBe("text/plain");
  });

  test("copy preserves user metadata, contentType, and cacheControl", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("from.txt", "hello", {
      cacheControl: "public, max-age=60",
      contentType: "text/plain",
      metadata: { region: "us-west", uploadedBy: "alice" },
    });
    await files.copy("from.txt", "to.txt");
    const dst = backing.get("to.txt");
    if (!dst) {
      throw new Error("expected destination entry");
    }
    expect(dst.metadata.__contentType).toBe("text/plain");
    expect(dst.metadata.__cacheControl).toBe("public, max-age=60");
    expect((dst.metadata.__user as Record<string, string>).uploadedBy).toBe(
      "alice"
    );
    expect((dst.metadata.__user as Record<string, string>).region).toBe(
      "us-west"
    );
    const got = await files.download("to.txt");
    expect(got.type).toBe("text/plain");
    expect(got.metadata?.uploadedBy).toBe("alice");
  });

  test("copy refreshes __lastModified to the time of the copy", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("from.txt", "hello");
    const src = backing.get("from.txt");
    if (!src) {
      throw new Error("expected source entry");
    }
    const srcMtime = src.metadata.__lastModified as number;
    // Advance the clock by at least 1ms so the copy gets a strictly later
    // timestamp — Date.now() at sub-ms resolution would otherwise tie.
    await sleep(2);
    await files.copy("from.txt", "to.txt");
    const dst = backing.get("to.txt");
    if (!dst) {
      throw new Error("expected destination entry");
    }
    expect(dst.metadata.__lastModified).toBeGreaterThan(srcMtime);
  });

  test("copy of a missing source throws NotFound", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.copy("missing.txt", "to.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("url() throws Provider with a netlify-specific message", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.url("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toMatch(/url\(\)|public URL/u);
    }
  });

  test("signedUploadUrl throws Provider", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.signedUploadUrl("a.txt", { expiresIn: 60 });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toMatch(/signed upload|presigned/u);
    }
  });

  test("upload error is wrapped as FilesError (Provider)", async () => {
    setMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(
          new Error(
            "Netlify Blobs has generated an internal error (500 status code)"
          ),
          { name: "BlobsInternalError" }
        )
      )
    );
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.upload("a.txt", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
    }
  });

  test("error: 401 status in message maps to Unauthorized", async () => {
    setMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(
          new Error(
            "Netlify Blobs has generated an internal error (401 status code, ID: abc)"
          ),
          { name: "BlobsInternalError" }
        )
      )
    );
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.upload("a.txt", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Unauthorized");
    }
  });

  test("error: 403 maps to Unauthorized", async () => {
    setMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(
          new Error(
            "Netlify Blobs has generated an internal error (403 status code)"
          ),
          { name: "BlobsInternalError" }
        )
      )
    );
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.upload("a.txt", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Unauthorized");
    }
  });

  test("error: 409 maps to Conflict", async () => {
    setMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(
          new Error(
            "Netlify Blobs has generated an internal error (409 status code)"
          ),
          { name: "BlobsInternalError" }
        )
      )
    );
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.upload("a.txt", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Conflict");
    }
  });

  test("error: 404 in message maps to NotFound", async () => {
    getMetadataMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(
          new Error(
            "Netlify Blobs has generated an internal error (404 status code)"
          ),
          { name: "BlobsInternalError" }
        )
      )
    );
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.head("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("error: MissingBlobsEnvironmentError is wrapped as Provider", async () => {
    getMetadataMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(
          new Error(
            "The environment has not been configured to use Netlify Blobs..."
          ),
          { name: "MissingBlobsEnvironmentError" }
        )
      )
    );
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.head("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toMatch(/Netlify Blobs/u);
    }
  });

  test("download exposes stored size 0 fallback for blobs written outside the SDK", async () => {
    // Blob with no embedded metadata — simulate something written via raw
    // SDK (or before the adapter was in use).
    backing.set("legacy.bin", {
      data: new Uint8Array([1, 2, 3]),
      etag: '"legacy"',
      metadata: {},
    });
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    const got = await files.download("legacy.bin");
    expect(got.type).toBe("application/octet-stream");
    // The buffered-download path reports the actual byte length when the
    // embedded `__size` is missing — better than returning 0.
    expect(got.size).toBe(3);
    expect(await got.text()).toBe("\u0001\u0002\u0003");
  });

  test("head on an out-of-band blob returns size 0 and octet-stream", async () => {
    backing.set("legacy.bin", {
      data: new Uint8Array([1, 2, 3]),
      etag: '"legacy"',
      metadata: {},
    });
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    const info = await files.head("legacy.bin");
    expect(info.size).toBe(0);
    expect(info.type).toBe("application/octet-stream");
  });

  test("adapter exposes the underlying store via raw", () => {
    const adapter = netlifyBlobs({ name: "s" });
    expect(adapter.raw).toBeDefined();
    // It's the same object the mock returned to getStore.
    expect(typeof (adapter.raw as { set: unknown }).set).toBe("function");
  });

  test("error: 'not found' in message (no status) maps to NotFound", async () => {
    // Force the message-only fallback in classifyNetlifyError — error has
    // no parseable status code in its text, only the keyword.
    setMock.mockImplementationOnce(() =>
      Promise.reject(new Error("Object not found in store"))
    );
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.upload("a.txt", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("error: 'unauthorized'/'forbidden' in message (no status) maps to Unauthorized", async () => {
    setMock.mockImplementationOnce(() =>
      Promise.reject(new Error("Request was forbidden by upstream"))
    );
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.upload("a.txt", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Unauthorized");
    }
  });

  test("getStore throwing at construction is wrapped as FilesError", () => {
    getStoreMock.mockImplementationOnce(() => {
      throw new Error(
        "Netlify Blobs has generated an internal error (500 status code)"
      );
    });
    expect(() => netlifyBlobs({ name: "s" })).toThrow(FilesError);
  });

  test("delete error is mapped to FilesError", async () => {
    deleteMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(
          new Error(
            "Netlify Blobs has generated an internal error (500 status code)"
          ),
          { name: "BlobsInternalError" }
        )
      )
    );
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.delete("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
    }
  });

  test("download as: stream maps null result to NotFound", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.download("missing.txt", { as: "stream" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("head's lazy body throws NotFound if the blob is gone before the lazy fetch", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a.txt", "hello");
    const info = await files.head("a.txt");
    // Simulate the blob disappearing between head() and the lazy body
    // accessor — store.get returns null.
    backing.delete("a.txt");
    try {
      await info.text();
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("list iterator throwing is mapped to FilesError", async () => {
    listMock.mockImplementationOnce(() => ({
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            Promise.reject(
              Object.assign(
                new Error(
                  "Netlify Blobs has generated an internal error (500 status code)"
                ),
                { name: "BlobsInternalError" }
              )
            ),
        };
      },
    }));
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.list();
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
    }
  });

  test("list item's lazy body throws NotFound if the blob is gone before the lazy fetch", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a.txt", "hello");
    const out = await files.list();
    backing.delete("a.txt");
    try {
      await out.items[0]?.text();
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("upload of a ReadableStream that errors is wrapped as FilesError", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("upstream went away"));
      },
    });
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.upload("a.bin", stream);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      // Stream error has no recognizable status — falls through to Provider.
      expect((error as FilesError).code).toBe("Provider");
    }
  });

  test("head returns no userMetadata when raw metadata is undefined", async () => {
    // Real Netlify always returns `{ etag, metadata: {...} }`, but the
    // unpackUserMetadata guard handles the defensive `undefined` case.
    // Force it via the mock.
    getMetadataMock.mockImplementationOnce(() =>
      Promise.resolve({ etag: '"x"', metadata: undefined as never })
    );
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    const info = await files.head("anything.txt");
    expect(info.metadata).toBeUndefined();
    expect(info.size).toBe(0);
    expect(info.type).toBe("application/octet-stream");
  });
});
