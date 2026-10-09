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
    directories?: boolean;
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

// Mirrors the real `BlobsInternalError` shape: when the response has an
// `x-nf-error` header, the message carries that header's text instead of
// "<status> status code", and `.status` is the only structured signal.
const internalError = (status: number, details: string): Error =>
  Object.assign(
    new Error(
      `Netlify Blobs has generated an internal error (${details}, ID: 01H)`
    ),
    { name: "BlobsInternalError", responseBody: undefined, status }
  );

// One delimiter-mode page: two files and two folders interleaved in key order.
const folderPage = () => ({
  async *[Symbol.asyncIterator]() {
    yield {
      blobs: [
        { etag: '"1"', key: "p/a.txt" },
        { etag: '"2"', key: "p/c.txt" },
      ],
      directories: ["p/b/", "p/d/"],
    };
  },
});

// Seeds the mock store in key order (the `set` mock records insertion order,
// which the paginated list mock replays).
const seedKeys = async (keys: string[]): Promise<void> => {
  await Promise.all(keys.map((k) => setMock(k, k)));
};

describe("netlify-blobs adapter", () => {
  test("missing name throws at construction", () => {
    expect(() =>
      netlifyBlobs({} as unknown as Parameters<typeof netlifyBlobs>[0])
    ).toThrow(/name/iu);
    expect(() =>
      netlifyBlobs({} as unknown as Parameters<typeof netlifyBlobs>[0])
    ).toThrow(expect.objectContaining({ code: "Invalid" }));
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

  test("region threads through to site and deploy stores, and is omitted by default", () => {
    netlifyBlobs({ name: "my-store", region: "eu-central-1" });
    netlifyBlobs({ deployScoped: true, name: "my-store", region: "us-east-2" });
    netlifyBlobs({ name: "my-store" });
    const [site, unset] = getStoreMock.mock.calls.map(
      (args) => args[0] as { region?: string }
    );
    const deploy = getDeployStoreMock.mock.calls[0]?.[0] as {
      region?: string;
    };
    expect(site?.region).toBe("eu-central-1");
    expect(deploy.region).toBe("us-east-2");
    expect(unset).toBeDefined();
    expect(unset).not.toHaveProperty("region");
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
    // No explicit contentType in opts — the Blob's own type is recorded.
    expect(entry.metadata.__contentType).toBe("image/png");
  });

  test("upload infers content types like the other adapters", async () => {
    const adapter = netlifyBlobs({ name: "s" });
    const text = await adapter.upload("a.txt", "hello");
    expect(text.contentType).toBe("text/plain; charset=utf-8");
    expect(backing.get("a.txt")?.metadata.__contentType).toBe(
      "text/plain; charset=utf-8"
    );
    const untyped = await adapter.upload(
      "b.bin",
      new Blob([new Uint8Array([1])])
    );
    expect(untyped.contentType).toBe("application/octet-stream");
    const bytes = await adapter.upload("c.bin", new Uint8Array([1]));
    expect(bytes.contentType).toBe("application/octet-stream");
    // An explicit contentType still wins over the Blob's own type.
    const override = await adapter.upload(
      "d.png",
      new Blob([new Uint8Array([1])], { type: "image/png" }),
      { contentType: "image/webp" }
    );
    expect(override.contentType).toBe("image/webp");
    const stored = await adapter.download("d.png");
    expect(stored.type).toBe("image/webp");
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
      // eslint-disable-next-line no-await-in-loop -- stream reader pulls are inherently sequential
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
    expect(info.contentType).toBe("text/plain");
    expect(info.etag).toBe('"etag-1"');
    expect(info.metadata?.uploadedBy).toBe("alice");
    expect(info).not.toHaveProperty("text");
    expect(getMock).not.toHaveBeenCalled();
    expect(getWithMetadataMock).not.toHaveBeenCalled();
    expect(getMetadataMock).toHaveBeenCalledTimes(1);
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

  test("exists returns true for present keys and false for missing keys", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await files.upload("a.txt", "hello", { contentType: "text/plain" });
    await expect(files.exists("a.txt")).resolves.toBe(true);
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("exists swallows a NotFound thrown by getMetadata", async () => {
    // The happy path returns null for misses, but Netlify's getMetadata can
    // *throw* a 404 in some configurations — exists() should still report
    // false instead of bubbling.
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
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("exists rethrows non-NotFound errors from getMetadata", async () => {
    getMetadataMock.mockImplementationOnce(() =>
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
      await files.exists("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).not.toBe("NotFound");
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

  test("list returns metadata-only items with key + etag", async () => {
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
    expect(first.contentType).toBe("application/octet-stream");
    expect(first.etag).toBe('"etag-1"');
    expect(first).not.toHaveProperty("text");
  });

  test("list with a delimiter requests directories and dedupes them", async () => {
    listMock.mockImplementationOnce((opts) => {
      expect(opts?.directories).toBe(true);
      return {
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          yield {
            blobs: [{ etag: '"e"', key: "a/1.txt" }],
            directories: ["a/b/"],
          };
          // Directories repeat across pages; the adapter must dedupe.
          yield { blobs: [], directories: ["a/b/", "a/c/"] };
        },
      };
    });
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    const out = await files.list({ delimiter: "/", prefix: "a/" });
    expect(out.items.map((i) => i.key)).toEqual(["a/1.txt"]);
    expect(out.prefixes?.toSorted()).toEqual(["a/b/", "a/c/"]);
  });

  test("netlify-blobs only supports the / delimiter", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await expect(files.list({ delimiter: "|" })).rejects.toMatchObject({
      code: "Unsupported",
    });
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
    await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((k) => files.upload(k, k))
    );
    listPagesYielded = 0;
    const out = await files.list({ limit: 3 });
    expect(out.items).toHaveLength(3);
    expect(listPagesYielded).toBe(2);
  });

  test("list without a limit drains all pages", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await Promise.all(["a", "b", "c", "d", "e"].map((k) => files.upload(k, k)));
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

  test("list returns no cursor when nothing is left to fetch", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await seedKeys(["a", "b"]);
    const all = await files.list();
    expect(all.cursor).toBeUndefined();
    // Exactly `limit` entries: no phantom next page.
    const exact = await files.list({ limit: 2 });
    expect(exact.cursor).toBeUndefined();
  });

  test("list with a limit returns a cursor that resumes after the last key", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await seedKeys(["a", "b", "c", "d", "e"]);
    const first = await files.list({ limit: 2 });
    expect(first.items.map((i) => i.key)).toEqual(["a", "b"]);
    expect(first.cursor).toBe("b");
    const second = await files.list({ cursor: first.cursor, limit: 2 });
    expect(second.items.map((i) => i.key)).toEqual(["c", "d"]);
    expect(second.cursor).toBe("d");
    const third = await files.list({ cursor: second.cursor, limit: 2 });
    expect(third.items.map((i) => i.key)).toEqual(["e"]);
    expect(third.cursor).toBeUndefined();
    // A cursor with no limit returns everything after it.
    const rest = await files.list({ cursor: "b" });
    expect(rest.items.map((i) => i.key)).toEqual(["c", "d", "e"]);
    expect(rest.cursor).toBeUndefined();
  });

  test("listAll with a limit walks every page instead of stopping after one", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    const keys = ["a", "b", "c", "d", "e", "f", "g"];
    await seedKeys(keys);
    const seen: string[] = [];
    for await (const item of files.listAll({ limit: 3 })) {
      seen.push(item.key);
    }
    expect(seen).toEqual(keys);
  });

  test("list resumes correctly when the cursor key was deleted between pages", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    await seedKeys(["a", "b", "c", "d"]);
    const first = await files.list({ limit: 2 });
    await Promise.all(first.items.map((item) => files.delete(item.key)));
    const second = await files.list({ cursor: first.cursor, limit: 2 });
    expect(second.items.map((i) => i.key)).toEqual(["c", "d"]);
    expect(second.cursor).toBeUndefined();
  });

  test("list drains and sorts locally when keys arrive out of order", async () => {
    // The local `netlify dev` server walks the filesystem, so its order is
    // not guaranteed. Stopping early would drop or repeat entries.
    const unordered = () => ({
      async *[Symbol.asyncIterator]() {
        listPagesYielded += 1;
        yield {
          blobs: [
            { etag: '"c"', key: "c" },
            { etag: '"a"', key: "a" },
          ],
          directories: [],
        };
        listPagesYielded += 1;
        yield {
          blobs: [
            { etag: '"d"', key: "d" },
            { etag: '"b"', key: "b" },
          ],
          directories: [],
        };
      },
    });
    listMock.mockImplementationOnce(unordered);
    listMock.mockImplementationOnce(unordered);
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    const first = await files.list({ limit: 1 });
    expect(first.items.map((i) => [i.key, i.etag])).toEqual([["a", '"a"']]);
    expect(first.cursor).toBe("a");
    expect(listPagesYielded).toBe(2);
    const second = await files.list({ cursor: first.cursor, limit: 2 });
    expect(second.items.map((i) => i.key)).toEqual(["b", "c"]);
    expect(second.cursor).toBe("c");
  });

  test("list with a delimiter counts folders against the limit and pages through them", async () => {
    listMock.mockImplementationOnce(folderPage);
    listMock.mockImplementationOnce(folderPage);
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    const first = await files.list({ delimiter: "/", limit: 2, prefix: "p/" });
    expect(first.items.map((i) => i.key)).toEqual(["p/a.txt"]);
    expect(first.prefixes).toEqual(["p/b/"]);
    expect(first.cursor).toBe("p/b/");
    const second = await files.list({
      cursor: first.cursor,
      delimiter: "/",
      limit: 2,
      prefix: "p/",
    });
    expect(second.items.map((i) => i.key)).toEqual(["p/c.txt"]);
    expect(second.prefixes).toEqual(["p/d/"]);
    expect(second.cursor).toBeUndefined();
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

  test("url() throws Unsupported with a netlify-specific message", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.url("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Unsupported");
      expect((error as FilesError).message).toMatch(/url\(\)|public URL/u);
    }
  });

  test("capabilities declare slash folding, metadata, and no signing", () => {
    const { capabilities } = new Files({
      adapter: netlifyBlobs({ name: "s" }),
    });
    expect(capabilities).toMatchObject({
      cacheControl: true,
      delimiter: "slash",
      metadata: true,
      rangeRead: false,
      serverSideCopy: false,
      signedUpload: { contentType: false, maxSize: false, supported: false },
      signedUrl: { expiry: "none", supported: false },
      uploadProgress: false,
    });
  });

  test("signedUploadUrl throws Unsupported", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });
    try {
      await files.signedUploadUrl("a.txt", { expiresIn: 60 });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Unsupported");
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

  test("error: BlobsInternalError.status wins when x-nf-error replaces the status in the message", async () => {
    const files = new Files({ adapter: netlifyBlobs({ name: "s" }) });

    getMetadataMock.mockImplementationOnce(() =>
      Promise.reject(internalError(404, "blob missing"))
    );
    await expect(files.head("a.txt")).rejects.toMatchObject({
      code: "NotFound",
    });

    getMetadataMock.mockImplementationOnce(() =>
      Promise.reject(internalError(404, "blob missing"))
    );
    expect(await files.exists("a.txt")).toBe(false);

    setMock.mockImplementationOnce(() =>
      Promise.reject(internalError(403, "store is read-only"))
    );
    await expect(files.upload("a.txt", "x")).rejects.toMatchObject({
      code: "Unauthorized",
    });

    setMock.mockImplementationOnce(() =>
      Promise.reject(internalError(412, "etag mismatch"))
    );
    await expect(files.upload("a.txt", "x")).rejects.toMatchObject({
      code: "Conflict",
    });

    // A structured status beats a misleading message.
    setMock.mockImplementationOnce(() =>
      Promise.reject(internalError(503, "404 status code"))
    );
    await expect(files.upload("a.txt", "x")).rejects.toMatchObject({
      code: "Provider",
    });
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
    expect(info.contentType).toBe("application/octet-stream");
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
    expect(info.contentType).toBe("application/octet-stream");
  });
});
