import { describe, expect, test } from "bun:test";

import { createFilesRouter } from "../src/api/index.js";
import { dedup } from "../src/dedup/index.js";
import type { DedupOptions } from "../src/dedup/index.js";
import { failover } from "../src/failover/index.js";
import { createFiles, FilesError, sync, UploadControl } from "../src/index.js";
import type {
  Adapter,
  ConditionalFilesOperation,
  Files,
  PluginNext,
} from "../src/index.js";
import { memory } from "../src/memory/index.js";
import { fakeAdapter, withCapabilities } from "./fake-adapter.js";
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

describe("dedup plugin — head and list metadata", () => {
  test("head() and list() return the content's info without fetching the blob", async () => {
    const inner = fakeAdapter();
    const downloads: string[] = [];
    const adapter: Adapter = {
      ...inner,
      download(key, opts) {
        downloads.push(key);
        return inner.download(key, opts);
      },
    };
    const files = createFiles({ adapter, plugins: [dedup()] });
    await files.upload("a.txt", "hello world", { metadata: { owner: "bob" } });
    const head = await files.head("a.txt");
    expect(Object.keys(head).toSorted()).toEqual([
      "contentType",
      "etag",
      "key",
      "lastModified",
      "metadata",
      "size",
    ]);
    expect(head).toMatchObject({
      contentType: "text/plain; charset=utf-8",
      key: "a.txt",
      metadata: { owner: "bob" },
      size: 11,
    });
    const { items } = await files.list();
    expect(items).toEqual([head]);
    expect(downloads).toEqual([]);
    // Reading the content is an explicit download, which follows the pointer.
    expect(await bodyText(files, "a.txt")).toBe("hello world");
  });

  test("list() items with no metadata pass through as the pointer", async () => {
    // S3 and the S3-compatibles return no metadata from list(), so a pointer
    // can't be recognized there: it reports the pointer's own size and ETag,
    // and a download still follows the pointer.
    const inner = fakeAdapter();
    const adapter: Adapter = {
      ...inner,
      async list(opts) {
        const page = await inner.list(opts);
        return {
          ...page,
          items: page.items.map(({ metadata: _metadata, ...file }) => file),
        };
      },
    };
    const files = createFiles({ adapter, plugins: [dedup()] });
    await files.upload("a.txt", "first");
    await createFiles({ adapter }).upload("b.txt", "plain");
    const { items } = await files.list();
    expect(items.map((file) => [file.key, file.size])).toEqual([
      ["a.txt", 0],
      ["b.txt", 5],
    ]);
    expect(await bodyText(files, "a.txt")).toBe("first");
  });
});

describe("dedup plugin — etag", () => {
  test("reports the content hash, so it tracks content rather than the pointer", async () => {
    // memory() derives ETags from the body, so every (empty) pointer has the
    // same native ETag — the case the content hash has to fix.
    const files = withDedup({}, memory());
    const uploaded = await files.upload("a.txt", "one");
    await files.upload("b.txt", "two");
    await files.upload("c.txt", "one");

    const a = await files.head("a.txt");
    const b = await files.head("b.txt");
    const c = await files.head("c.txt");
    expect(a.etag).toMatch(/^[0-9a-f]{64}$/u);
    expect(b.etag).not.toBe(a.etag);
    expect(c.etag).toBe(a.etag);
    expect(uploaded.etag).toBe(a.etag);
    const downloaded = await files.download("a.txt");
    expect(downloaded.etag).toBe(a.etag);
    const ranged = await files.download("a.txt", {
      range: { end: 1, start: 0 },
    });
    expect(ranged.etag).toBe(a.etag);
    const { items } = await files.list();
    expect(items.map((file) => file.etag)).toEqual([a.etag, b.etag, c.etag]);

    await files.upload("a.txt", "six");
    const edited = await files.head("a.txt");
    expect(edited.etag).not.toBe(a.etag);
  });

  test("sync() between dedup instances copies a same-size edit", async () => {
    const source = withDedup({}, memory());
    const dest = withDedup({}, memory());
    await source.upload("doc.txt", "draft-1");
    const first = await sync(source, dest);
    expect(first.uploaded).toEqual(["doc.txt"]);

    await source.upload("doc.txt", "draft-2");
    const second = await sync(source, dest);
    expect(second.uploaded).toEqual(["doc.txt"]);
    expect(second.skipped).toEqual([]);
    expect(await bodyText(dest, "doc.txt")).toBe("draft-2");

    const third = await sync(source, dest);
    expect(third.skipped).toEqual(["doc.txt"]);
  });
});

describe("dedup plugin — resumable uploads", () => {
  test("a control drives the blob write only, never the pointer", async () => {
    const adapter = memory();
    const files = withDedup({}, adapter);
    const control = new UploadControl();
    const result = await files.upload("a.txt", "resumable body", { control });
    expect(result.size).toBe(14);
    expect(control.status).toBe("completed");
    expect(await bodyText(files, "a.txt")).toBe("resumable body");

    // Content already stored: no bytes move, and the pointer write doesn't
    // touch the (fresh) control either.
    await files.upload("b.txt", "resumable body", {
      control: new UploadControl(),
      multipart: true,
    });
    expect(await bodyText(files, "b.txt")).toBe("resumable body");
  });
});

describe("dedup plugin — capabilities", () => {
  test("advertises no presigned URLs or conditional ops, and keeps ranges", () => {
    const adapter: Adapter = withCapabilities(
      fakeAdapter({ supportsRange: true }),
      { signedUrl: { maxExpiresIn: 3600, supported: true } }
    );
    const caps = withDedup({}, adapter).capabilities;
    expect(caps.signedUrl).toEqual({
      disposition: false,
      expiry: "none",
      supported: false,
    });
    expect(caps.rangeRead).toBe(true);
    expect(caps.metadata).toBe(true);
    expect(caps.conditional).toEqual({
      copy: {
        atomicSourceDestination: false,
        destinationCreate: false,
        destinationReplace: false,
        sourceEtag: false,
      },
      create: false,
      delete: false,
      exactRead: false,
      multipart: { create: false, replace: false },
      replace: false,
    });
  });

  test("a gateway over a signing adapter proxies downloads through the plugin", async () => {
    const adapter: Adapter = withCapabilities(memory(), {
      signedUrl: { supported: true },
    });
    const files = withDedup({}, adapter);
    await files.upload("a.txt", "0123456789");
    const router = createFilesRouter({
      files,
      operations: ["download"],
      secret: "test-secret",
    });
    const endpoint = "https://app.test/api/files?op=download&key=a.txt";

    const full = await router.handle(new Request(endpoint));
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("0123456789");

    const ranged = await router.handle(
      new Request(endpoint, { headers: { range: "bytes=2-5" } })
    );
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("2345");
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

describe("dedup plugin — store prefix is write-protected", () => {
  test("reads and deletes under the store prefix pass through verbatim", async () => {
    const adapter = fakeAdapter();
    const files = withDedup({}, adapter);
    await files.upload("a.txt", "raw-bytes");
    const [blobKey = ""] = blobKeys(adapter);

    expect(await bodyText(files, blobKey)).toBe("raw-bytes");
    const blob = await files.head(blobKey);
    expect(blob.size).toBe(9);
    expect(await files.exists(blobKey)).toBe(true);
    // A sweep can reclaim a blob; its pointers then read as NotFound.
    await files.delete(blobKey);
    expect(blobKeys(adapter)).toEqual([]);
    await expect(files.download("a.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("an upload can't overwrite a blob and change every pointer to it", async () => {
    const adapter = fakeAdapter();
    const files = withDedup({}, adapter);
    await files.upload("alice/contract.txt", "I agree");
    const [blobKey = ""] = blobKeys(adapter);

    await expect(files.upload(blobKey, "I do NOT agree")).rejects.toMatchObject(
      { code: "Invalid", permanent: true }
    );
    await expect(files.upload(blobKey, "x")).rejects.toThrow(
      /upload into the content store/u
    );
    expect(await bodyText(files, "alice/contract.txt")).toBe("I agree");
  });

  test("refuses the store however the key is spelled", async () => {
    const files = withDedup();
    for (const key of [
      ".dedup",
      ".dedup/abc",
      "/.dedup/abc",
      ".dedup//abc",
      "./.dedup/abc",
      "a/../.dedup/abc",
      "../.dedup/abc",
      ".DEDUP/abc",
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each key is asserted independently
      await expect(files.upload(key, "x")).rejects.toThrow(/content store/u);
    }
    // Look-alikes outside the store are ordinary keys.
    for (const key of [".dedupe/abc", "x/.dedup/abc", "dedup/abc"]) {
      // eslint-disable-next-line no-await-in-loop -- each key is asserted independently
      await files.upload(key, "fine");
      // eslint-disable-next-line no-await-in-loop -- each key is asserted independently
      expect(await bodyText(files, key)).toBe("fine");
    }
  });

  test("refuses bulk uploads, presigned uploads, and copy/move into the store", async () => {
    const adapter = fakeAdapter();
    const files = withDedup({}, adapter);
    await files.upload("a.txt", "keep");
    const [blobKey = ""] = blobKeys(adapter);

    const bulk = await files.upload([
      { body: "ok", key: "b.txt" },
      { body: "poison", key: blobKey },
    ]);
    expect(bulk.results.map((item) => item.key)).toEqual(["b.txt"]);
    expect(bulk.errors?.[0]?.key).toBe(blobKey);

    await expect(
      files.signedUploadUrl(blobKey, { expiresIn: 60 })
    ).rejects.toThrow(/signedUploadUrl into the content store/u);
    await expect(files.copy("b.txt", blobKey)).rejects.toThrow(
      /copy into the content store/u
    );
    await expect(files.move("b.txt", blobKey)).rejects.toThrow(
      /move into the content store/u
    );
    expect(await bodyText(files, "a.txt")).toBe("keep");
    expect(await files.exists("b.txt")).toBe(true);
  });

  test("guards a custom multi-segment store prefix", async () => {
    const files = withDedup({ prefix: "cas/Blobs" });
    await expect(files.upload("cas/blobs/abc", "x")).rejects.toThrow(
      /content store/u
    );
    await files.upload("cas/other", "fine");
    expect(await bodyText(files, "cas/other")).toBe("fine");
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
    expect(result.results).toHaveLength(2);

    const downloaded = await files.download(["x.txt", "y.txt"]);
    const bodies = await Promise.all(
      downloaded.results.map((file) => file.text())
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
    ).rejects.toMatchObject({ code: "Unsupported", permanent: true });
    const survived = await files.download("k.txt");
    expect(await survived.text()).toBe("second");
  });
});

describe("dedup plugin — refusals are permanent", () => {
  test("an outer failover() doesn't re-send a refused call to a plugin-less secondary", async () => {
    const secondary = fakeAdapter();
    await createFiles({ adapter: secondary }).upload("a.txt", "replica");
    const files = createFiles({
      adapter: fakeAdapter(),
      plugins: [failover({ secondaries: secondary }), dedup()],
    });
    await files.upload("a.txt", "hello");
    const refusals = [
      () => files.url("a.txt"),
      () => files.signedUploadUrl("a.txt", { expiresIn: 60 }),
    ];
    for (const refused of refusals) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is inspected on its own
      const failure = await refused().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FilesError);
      expect((failure as FilesError).permanent).toBe(true);
      expect((failure as FilesError).message).toMatch(/^dedup: /u);
    }
  });
});
