import { describe, expect, test } from "bun:test";

import { dedup } from "../src/dedup/index.js";
import type { DedupOptions } from "../src/dedup/index.js";
import { createFiles, FilesError } from "../src/index.js";
import type {
  Adapter,
  ConditionalFilesOperation,
  Files,
  PluginNext,
} from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";
import type { FakeAdapter } from "./fake-adapter.js";

const withDedup = (
  options: DedupOptions = {},
  adapter: Adapter = fakeAdapter()
): Files => createFiles({ adapter, plugins: [dedup(options)] });

const bodyText = (files: Files, key: string): Promise<string> =>
  files.download(key).then((file) => file.text());

const blobKeys = (adapter: FakeAdapter, prefix = ".dedup"): string[] =>
  [...adapter.raw.keys()].filter((key) => key.startsWith(`${prefix}/`));

const ascii = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

// A fake adapter that records every key it's asked to upload, so a test can
// assert the byte upload was *skipped* for content already in the store.
const countingAdapter = (): {
  adapter: Adapter;
  blobUploads: () => string[];
} => {
  const inner = fakeAdapter();
  const uploaded: string[] = [];
  return {
    adapter: {
      ...inner,
      upload(key, body, opts) {
        uploaded.push(key);
        return inner.upload(key, body, opts);
      },
    },
    blobUploads: () => uploaded.filter((key) => key.startsWith(".dedup/")),
  };
};

describe("dedup plugin — storing and reading", () => {
  test("stores a body once and reads it back", async () => {
    const adapter = fakeAdapter();
    const files = withDedup({}, adapter);
    await files.upload("a.txt", "hello");
    expect(await bodyText(files, "a.txt")).toBe("hello");
    expect(blobKeys(adapter)).toHaveLength(1);
  });

  test("reports the logical size on download", async () => {
    const files = withDedup();
    await files.upload("a.txt", "abcd");
    const file = await files.download("a.txt");
    expect(file.size).toBe(4);
    expect(await file.text()).toBe("abcd");
  });

  test("buffers and de-duplicates a stream body", async () => {
    const files = withDedup();
    await files.upload("s.txt", streamOf(ascii("strea"), ascii("ming")));
    expect(await bodyText(files, "s.txt")).toBe("streaming");
  });
});

describe("dedup plugin — de-duplication", () => {
  test("identical content across keys stores one blob, uploaded once", async () => {
    const { adapter, blobUploads } = countingAdapter();
    const files = createFiles({ adapter, plugins: [dedup()] });
    await files.upload("a.txt", "same");
    await files.upload("b.txt", "same");

    expect(await bodyText(files, "a.txt")).toBe("same");
    expect(await bodyText(files, "b.txt")).toBe("same");
    // The bytes were written to the content store exactly once.
    expect(blobUploads()).toHaveLength(1);
  });

  test("distinct content stores distinct blobs", async () => {
    const adapter = fakeAdapter();
    const files = withDedup({}, adapter);
    await files.upload("a.txt", "x");
    await files.upload("b.txt", "y");
    expect(blobKeys(adapter)).toHaveLength(2);
  });

  test("copy shares the one stored blob", async () => {
    const adapter = fakeAdapter();
    const files = withDedup({}, adapter);
    await files.upload("a.txt", "dup");
    await files.copy("a.txt", "c.txt");

    expect(await bodyText(files, "c.txt")).toBe("dup");
    expect(blobKeys(adapter)).toHaveLength(1);
  });

  test("move relocates the pointer", async () => {
    const adapter = fakeAdapter();
    const files = withDedup({}, adapter);
    await files.upload("from.txt", "moving");
    await files.move("from.txt", "to.txt");

    expect(await files.exists("from.txt")).toBe(false);
    expect(await bodyText(files, "to.txt")).toBe("moving");
    expect(blobKeys(adapter)).toHaveLength(1);
  });
});

describe("dedup plugin — head and metadata", () => {
  test("head reports the logical size and strips internal fields", async () => {
    const files = withDedup();
    await files.upload("a.txt", "abcd", { metadata: { owner: "me" } });
    const file = await files.head("a.txt");
    expect(file.size).toBe(4);
    expect(file.metadata).toEqual({ owner: "me" });
  });

  test("head leaves no metadata object when only internal fields exist", async () => {
    const files = withDedup();
    await files.upload("a.txt", "abcd");
    const file = await files.head("a.txt");
    expect(file.size).toBe(4);
    expect(file.metadata).toBeUndefined();
  });

  test("head passes a foreign object straight through", async () => {
    const adapter = fakeAdapter();
    const files = createFiles({ adapter, plugins: [dedup()] });
    await adapter.upload("plain.txt", "hello");
    const file = await files.head("plain.txt");
    expect(file.size).toBe(5);
  });

  test("falls back to the stored size for a pointer with no recorded size", async () => {
    const adapter = fakeAdapter();
    const files = createFiles({ adapter, plugins: [dedup()] });
    // A hand-rolled, malformed pointer: marked as ours but missing the size.
    await adapter.upload("ghost.txt", "0123", {
      metadata: { fsdedup_ref: "deadbeef" },
    });
    const file = await files.head("ghost.txt");
    expect(file.size).toBe(4);
    expect(file.metadata).toBeUndefined();
  });
});

describe("dedup plugin — ranged downloads", () => {
  test("reads a byte range from the verbatim blob", async () => {
    const adapter = fakeAdapter({ supportsRange: true });
    const files = createFiles({ adapter, plugins: [dedup()] });
    await files.upload("a.txt", "0123456789");
    const file = await files.download("a.txt", { range: { end: 5, start: 2 } });
    expect(await file.text()).toBe("2345");
    expect(file.size).toBe(4);
  });

  test("a ranged read of a foreign object passes through", async () => {
    const adapter = fakeAdapter({ supportsRange: true });
    const files = createFiles({ adapter, plugins: [dedup()] });
    await adapter.upload("foreign.txt", "0123456789");
    const file = await files.download("foreign.txt", {
      range: { end: 2, start: 0 },
    });
    expect(await file.text()).toBe("012");
  });
});

describe("dedup plugin — foreign objects", () => {
  test("downloads an object it didn't write unchanged", async () => {
    const adapter = fakeAdapter();
    const files = createFiles({ adapter, plugins: [dedup()] });
    await adapter.upload("foreign.txt", "raw");
    expect(await bodyText(files, "foreign.txt")).toBe("raw");
  });
});

describe("dedup plugin — listing", () => {
  test("hides the blob store and reports logical sizes", async () => {
    const files = withDedup();
    await files.upload("a.txt", "abcd");
    await files.upload("b.txt", "ef");
    const { items } = await files.list();
    expect(items.map((file) => file.key)).toEqual(["a.txt", "b.txt"]);
    expect(items.map((file) => file.size)).toEqual([4, 2]);
  });

  test("shows blobs when listing within the store prefix", async () => {
    const files = withDedup();
    await files.upload("a.txt", "abcd");
    const { items } = await files.list({ prefix: ".dedup" });
    expect(items).toHaveLength(1);
    expect(items[0]?.key.startsWith(".dedup/")).toBe(true);
  });

  test("preserves the cursor across pages", async () => {
    const files = withDedup();
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    const page = await files.list({ limit: 1 });
    expect(page.cursor).toBeDefined();
  });

  test("strips the blob folder from delimiter prefixes", async () => {
    const files = withDedup({}, fakeAdapter({ supportsDelimiter: true }));
    await files.upload("photos/x.jpg", "1");
    const result = await files.list({ delimiter: "/" });
    expect(result.prefixes ?? []).toContain("photos/");
    expect(result.prefixes ?? []).not.toContain(".dedup/");
  });
});

describe("dedup plugin — delete leaves blobs", () => {
  test("drops the pointer but keeps the addressed content", async () => {
    const adapter = fakeAdapter();
    const files = withDedup({}, adapter);
    await files.upload("a.txt", "bye");
    await files.delete("a.txt");

    expect(await files.exists("a.txt")).toBe(false);
    // The blob is content-addressed and reused if the bytes reappear.
    expect(blobKeys(adapter)).toHaveLength(1);
  });
});

describe("dedup plugin — store prefix is inert", () => {
  test("writes and reads under the store prefix pass through verbatim", async () => {
    const adapter = fakeAdapter();
    const files = withDedup({}, adapter);
    await files.upload(".dedup/manual", "raw-bytes");

    expect(await bodyText(files, ".dedup/manual")).toBe("raw-bytes");
    // No pointer, no hashing — exactly the one verbatim object.
    expect(blobKeys(adapter)).toEqual([".dedup/manual"]);
  });
});

describe("dedup plugin — presigned URLs fail closed", () => {
  test("url throws", async () => {
    const files = withDedup();
    await expect(files.url("a.png")).rejects.toThrow(
      /url\(\) would return a link to the pointer/u
    );
  });

  test("signedUploadUrl throws", async () => {
    const files = withDedup();
    await expect(
      files.signedUploadUrl("a.png", { expiresIn: 60 })
    ).rejects.toThrow(/bypasses content-addressing/u);
  });
});

describe("dedup plugin — bulk operations", () => {
  test("de-duplicates and reads back bulk uploads", async () => {
    const files = withDedup();
    const result = await files.upload([
      { body: "one", key: "x.txt" },
      { body: "two", key: "y.txt" },
    ]);
    expect(result.uploaded).toHaveLength(2);

    const downloaded = await files.download(["x.txt", "y.txt"]);
    const bodies = await Promise.all(
      downloaded.downloaded.map((file) => file.text())
    );
    expect(bodies).toEqual(["one", "two"]);
  });

  test("a bulk item skips the byte upload for content already stored", async () => {
    // The `exists` probe is re-routed cross-kind; it now works on the bulk
    // path too, so re-uploading stored content in a batch still skips.
    const { adapter, blobUploads } = countingAdapter();
    const files = createFiles({ adapter, plugins: [dedup()] });
    await files.upload("seed.txt", "shared");
    await files.upload([
      { body: "shared", key: "a.txt" },
      { body: "fresh", key: "b.txt" },
    ]);
    // "shared" was already stored (one blob upload); only "fresh" is new.
    expect(blobUploads()).toHaveLength(2);
  });
});

describe("dedup plugin — exists", () => {
  test("reports presence by the pointer", async () => {
    const files = withDedup();
    await files.upload("a.txt", "x");
    expect(await files.exists("a.txt")).toBe(true);
    expect(await files.exists("missing.txt")).toBe(false);
  });
});

describe("dedup plugin — options", () => {
  test("honors a custom prefix", async () => {
    const adapter = fakeAdapter();
    const files = withDedup({ prefix: "cas/" }, adapter);
    await files.upload("a.txt", "x");
    expect(blobKeys(adapter, "cas")).toHaveLength(1);
    const { items } = await files.list();
    expect(items.map((file) => file.key)).toEqual(["a.txt"]);
  });

  test("rejects an empty prefix", () => {
    expect(() => dedup({ prefix: "///" })).toThrow(/must not be empty/u);
  });
});

describe("dedup plugin — conditional policy", () => {
  test("rejects every conditional mode before pointer or blob I/O", async () => {
    const plugin = dedup();
    const { wrap } = plugin;
    if (!wrap) {
      throw new Error("dedup wrap missing");
    }
    let nextCalls = 0;
    const next = (() => {
      nextCalls += 1;
      return Promise.resolve();
    }) as PluginNext;
    // Uploads and exact reads span pointer + blob; delete and copy touch only
    // the pointer, but a pointer's ETag is the hash of an always-empty body —
    // identical for every key and unchanged when the pointer is rewritten to
    // a new blob — so a compare-and-set against it could never fail and would
    // silently drop or duplicate content that had moved on.
    const operations: ConditionalFilesOperation[] = [
      { body: "content", key: "a.txt", kind: "upload", mode: "create" },
      {
        etag: "etag-1",
        key: "a.txt",
        kind: "download",
        mode: "exact",
      },
      { etag: "etag-1", key: "a.txt", kind: "delete", mode: "match" },
      {
        destination: { type: "create" },
        from: "a.txt",
        kind: "copy",
        mode: "conditional",
        source: { etag: "etag-1" },
        to: "b.txt",
      },
    ];

    for (const operation of operations) {
      // eslint-disable-next-line no-await-in-loop -- each rejected operation must be inspected independently
      const failure = await wrap(operation, next).catch(
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(FilesError);
      expect((failure as FilesError).permanent).toBe(true);
      expect((failure as Error).message).toMatch(/native compare-and-set/u);
    }
    expect(nextCalls).toBe(0);
  });

  test("a CAS delete through the Files instance is refused and the content survives", async () => {
    const files = createFiles({ adapter: fakeAdapter(), plugins: [dedup()] });
    await files.upload("k.txt", "first");
    const { etag } = await files.head("k.txt");
    await files.upload("k.txt", "second");
    await expect(
      files.delete("k.txt", { condition: { etag: etag as string } })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    const survived = await files.download("k.txt");
    expect(await survived.text()).toBe("second");
  });
});
