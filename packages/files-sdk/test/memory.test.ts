import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";

import { Files, FilesError, UploadControl } from "../src/index.js";
import type { ResumableUploadSession } from "../src/index.js";
import { memory } from "../src/memory/index.js";

type Adapter = ReturnType<typeof memory>;

const drainStream = async (
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

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

// Helpers that break the download+accessor chain into two statements, so we
// never access a member directly off an `await` expression.
const textOf = async (adapter: Adapter, key: string): Promise<string> => {
  const file = await adapter.download(key);
  return file.text();
};

const bytesOf = async (adapter: Adapter, key: string): Promise<Uint8Array> => {
  const file = await adapter.download(key);
  return new Uint8Array(await file.arrayBuffer());
};

const seedKeys = async (adapter: Adapter, keys: string[]): Promise<void> => {
  await Promise.all(keys.map((key) => adapter.upload(key, key)));
};

describe("memory adapter", () => {
  describe("construction", () => {
    test("exposes name and the backing Map as raw", () => {
      const adapter = memory();
      expect(adapter.name).toBe("memory");
      expect(adapter.raw).toBeInstanceOf(Map);
      expect(adapter.raw.size).toBe(0);
    });

    test("starts empty with no options", async () => {
      const adapter = memory();
      const { items } = await adapter.list();
      expect(items).toEqual([]);
    });

    describe("initial seed", () => {
      test("seeds string and byte bodies", async () => {
        const adapter = memory({
          initial: {
            "bytes.bin": new Uint8Array([1, 2, 3]),
            "text.txt": "hi",
          },
        });
        expect(adapter.raw.size).toBe(2);
        const text = await adapter.download("text.txt");
        expect(await text.text()).toBe("hi");
        expect(text.type).toBe("text/plain; charset=utf-8");
        const bin = await adapter.download("bytes.bin");
        expect(await bytesOf(adapter, "bytes.bin")).toEqual(
          new Uint8Array([1, 2, 3])
        );
        expect(bin.type).toBe("application/octet-stream");
      });

      test("seeds ArrayBuffer and ArrayBufferView bodies", async () => {
        // A view that is not a Uint8Array exercises the else-branch.
        const { buffer } = new Uint8Array([9, 8, 7]);
        const view = new Int8Array([1, 2]);
        const adapter = memory({
          initial: { "buf.bin": buffer, "view.bin": view },
        });
        expect(await bytesOf(adapter, "buf.bin")).toEqual(
          new Uint8Array([9, 8, 7])
        );
        expect(await bytesOf(adapter, "view.bin")).toEqual(
          new Uint8Array([1, 2])
        );
      });

      test("seeds the object form with contentType / metadata / cacheControl", async () => {
        const adapter = memory({
          initial: {
            "report.csv": {
              body: "a,b\n1,2",
              cacheControl: "max-age=60",
              contentType: "text/csv",
              metadata: { owner: "alice" },
            },
          },
        });
        const head = await adapter.head("report.csv");
        expect(head.type).toBe("text/csv");
        expect(head.metadata).toEqual({ owner: "alice" });
        expect(adapter.raw.get("report.csv")?.cacheControl).toBe("max-age=60");
      });

      test("copies seed bytes in (later mutation does not leak)", async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const adapter = memory({ initial: { "k.bin": bytes } });
        bytes[0] = 99;
        expect(await bytesOf(adapter, "k.bin")).toEqual(
          new Uint8Array([1, 2, 3])
        );
      });
    });
  });

  describe("upload", () => {
    test("string body infers text/plain and round-trips", async () => {
      const adapter = memory();
      const res = await adapter.upload("a.txt", "hello");
      expect(res.key).toBe("a.txt");
      expect(res.size).toBe(5);
      expect(res.contentType).toBe("text/plain; charset=utf-8");
      expect(res.etag).toMatch(/^"[0-9a-f]{8}"$/u);
      expect(await textOf(adapter, "a.txt")).toBe("hello");
    });

    test("explicit contentType wins over inference", async () => {
      const adapter = memory();
      const res = await adapter.upload("a.json", "{}", {
        contentType: "application/json",
      });
      expect(res.contentType).toBe("application/json");
    });

    test("Uint8Array body falls back to octet-stream", async () => {
      const adapter = memory();
      const res = await adapter.upload("a.bin", new Uint8Array([1, 2, 3, 4]));
      expect(res.size).toBe(4);
      expect(res.contentType).toBe("application/octet-stream");
    });

    test("ArrayBuffer body", async () => {
      const adapter = memory();
      const { buffer } = new Uint8Array([5, 6]);
      await adapter.upload("a.bin", buffer);
      expect(await bytesOf(adapter, "a.bin")).toEqual(new Uint8Array([5, 6]));
    });

    test("ArrayBufferView (non-Uint8Array) body", async () => {
      const adapter = memory();
      await adapter.upload("a.bin", new Int16Array([1, 2]));
      const stored = await bytesOf(adapter, "a.bin");
      expect(new Int16Array(stored.buffer)).toEqual(new Int16Array([1, 2]));
    });

    test("Blob body infers its type", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", new Blob(["hey"], { type: "text/x-test" }));
      const head = await adapter.head("a.txt");
      expect(head.type).toBe("text/x-test");
      expect(head.size).toBe(3);
    });

    test("typeless Blob falls back to octet-stream", async () => {
      const adapter = memory();
      await adapter.upload("a.bin", new Blob(["x"]));
      const head = await adapter.head("a.bin");
      expect(head.type).toBe("application/octet-stream");
    });

    test("ReadableStream body is drained", async () => {
      const adapter = memory();
      await adapter.upload("a.bin", streamOf(new Uint8Array([1, 2, 3])));
      expect(await bytesOf(adapter, "a.bin")).toEqual(
        new Uint8Array([1, 2, 3])
      );
    });

    test("stores metadata and cacheControl", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "x", {
        cacheControl: "no-cache",
        metadata: { k: "v" },
      });
      const head = await adapter.head("a.txt");
      expect(head.metadata).toEqual({ k: "v" });
      expect(adapter.raw.get("a.txt")?.cacheControl).toBe("no-cache");
    });

    test("copies the body in (later mutation does not leak)", async () => {
      const adapter = memory();
      const bytes = new Uint8Array([1, 2, 3]);
      await adapter.upload("a.bin", bytes);
      bytes[0] = 42;
      expect(await bytesOf(adapter, "a.bin")).toEqual(
        new Uint8Array([1, 2, 3])
      );
    });

    test("overwrites an existing key", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "one");
      await adapter.upload("a.txt", "two");
      expect(await textOf(adapter, "a.txt")).toBe("two");
      expect(adapter.raw.size).toBe(1);
    });
  });

  describe("etag", () => {
    test("identical content yields the same etag", async () => {
      const adapter = memory();
      const a = await adapter.upload("a", "same");
      const b = await adapter.upload("b", "same");
      expect(a.etag).toBe(b.etag);
    });

    test("different content yields a different etag", async () => {
      const adapter = memory();
      const a = await adapter.upload("a", "one");
      const b = await adapter.upload("b", "two");
      expect(a.etag).not.toBe(b.etag);
    });
  });

  describe("download", () => {
    test("missing key throws NotFound", async () => {
      const adapter = memory();
      await expect(adapter.download("nope")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("as: stream still works (buffer-backed)", async () => {
      const adapter = memory();
      await adapter.upload("a.bin", new Uint8Array([7, 8, 9]));
      const file = await adapter.download("a.bin", { as: "stream" });
      expect(await drainStream(file.stream())).toEqual(
        new Uint8Array([7, 8, 9])
      );
    });

    test("exposes blob()", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "blobby", { contentType: "text/plain" });
      const file = await adapter.download("a.txt");
      const blob = await file.blob();
      expect(await blob.text()).toBe("blobby");
      expect(blob.type).toContain("text/plain");
    });

    test("range returns an inclusive slice with the slice length as size", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "0123456789");
      const file = await adapter.download("a.txt", {
        range: { end: 4, start: 2 },
      });
      expect(await file.text()).toBe("234");
      expect(file.size).toBe(3);
      // Object identity (etag) is the full object's, like an HTTP 206.
      const full = await adapter.head("a.txt");
      expect(file.etag).toBe(full.etag);
    });

    test("open-ended range reads from start to EOF", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "0123456789");
      const file = await adapter.download("a.txt", { range: { start: 8 } });
      expect(await file.text()).toBe("89");
      expect(file.size).toBe(2);
    });
  });

  describe("head", () => {
    test("returns metadata without consuming the body", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "hello");
      const head = await adapter.head("a.txt");
      expect(head.key).toBe("a.txt");
      expect(head.size).toBe(5);
      expect(head.etag).toMatch(/^"[0-9a-f]{8}"$/u);
    });

    test("missing key throws NotFound", async () => {
      const adapter = memory();
      await expect(adapter.head("nope")).rejects.toMatchObject({
        code: "NotFound",
      });
    });
  });

  describe("exists", () => {
    test("true when present, false when absent", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "x");
      expect(await adapter.exists("a.txt")).toBe(true);
      expect(await adapter.exists("nope")).toBe(false);
    });
  });

  describe("delete", () => {
    test("removes a key", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "x");
      await adapter.delete("a.txt");
      expect(await adapter.exists("a.txt")).toBe(false);
    });

    test("is idempotent for a missing key", async () => {
      const adapter = memory();
      await expect(adapter.delete("nope")).resolves.toBeUndefined();
    });
  });

  describe("copy", () => {
    test("duplicates content, contentType, and metadata", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "hello", {
        contentType: "text/plain",
        metadata: { k: "v" },
      });
      await adapter.copy("a.txt", "b.txt");
      const copy = await adapter.head("b.txt");
      expect(await textOf(adapter, "b.txt")).toBe("hello");
      expect(copy.type).toBe("text/plain");
      expect(copy.metadata).toEqual({ k: "v" });
      // Source still present.
      expect(await adapter.exists("a.txt")).toBe(true);
    });

    test("content-derived etag matches the source", async () => {
      const adapter = memory();
      const src = await adapter.upload("a.txt", "hello");
      await adapter.copy("a.txt", "b.txt");
      const copy = await adapter.head("b.txt");
      expect(copy.etag).toBe(src.etag);
    });

    test("missing source throws NotFound", async () => {
      const adapter = memory();
      await expect(adapter.copy("nope", "b.txt")).rejects.toMatchObject({
        code: "NotFound",
      });
    });
  });

  describe("metadata isolation", () => {
    test("upload copies the caller's metadata object in", async () => {
      const adapter = memory();
      const meta = { k: "v" };
      await adapter.upload("a.txt", "hello", { metadata: meta });
      // Mutating the object the caller handed us must not reach the store.
      meta.k = "mutated";
      const head = await adapter.head("a.txt");
      expect(head.metadata).toEqual({ k: "v" });
    });

    test("head returns a metadata copy that cannot mutate the store", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "hello", { metadata: { k: "v" } });
      const head = await adapter.head("a.txt");
      if (head.metadata) {
        head.metadata.k = "mutated";
      }
      const again = await adapter.head("a.txt");
      expect(again.metadata).toEqual({ k: "v" });
    });

    test("copy gives the destination an independent metadata object", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "hello", { metadata: { k: "v" } });
      await adapter.copy("a.txt", "b.txt");
      const source = adapter.raw.get("a.txt");
      const dest = adapter.raw.get("b.txt");
      // Distinct objects with equal contents — mutating one can't reach the other.
      expect(dest?.metadata).not.toBe(source?.metadata);
      if (dest?.metadata) {
        dest.metadata.k = "changed";
      }
      expect(source?.metadata).toEqual({ k: "v" });
    });

    test("initial seed copies the metadata object in", async () => {
      const meta = { owner: "alice" };
      const adapter = memory({
        initial: { "a.txt": { body: "hi", metadata: meta } },
      });
      meta.owner = "bob";
      const head = await adapter.head("a.txt");
      expect(head.metadata).toEqual({ owner: "alice" });
    });
  });

  describe("move", () => {
    test("re-keys, removing the source and preserving lastModified", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "hello");
      const before = adapter.raw.get("a.txt")?.lastModified;
      await adapter.move("a.txt", "b.txt");
      expect(await adapter.exists("a.txt")).toBe(false);
      expect(await textOf(adapter, "b.txt")).toBe("hello");
      expect(adapter.raw.get("b.txt")?.lastModified).toBe(before);
    });

    test("missing source throws NotFound", async () => {
      const adapter = memory();
      await expect(adapter.move("nope", "b.txt")).rejects.toMatchObject({
        code: "NotFound",
      });
    });
  });

  describe("list", () => {
    test("returns all keys sorted, no cursor when complete", async () => {
      const adapter = memory();
      await seedKeys(adapter, ["a", "b", "c", "d", "e"]);
      const { items, cursor } = await adapter.list();
      expect(items.map((i) => i.key)).toEqual(["a", "b", "c", "d", "e"]);
      expect(cursor).toBeUndefined();
    });

    test("filters by prefix", async () => {
      const adapter = memory();
      await adapter.upload("docs/1", "1");
      await adapter.upload("docs/2", "2");
      await adapter.upload("img/1", "x");
      const { items } = await adapter.list({ prefix: "docs/" });
      expect(items.map((i) => i.key)).toEqual(["docs/1", "docs/2"]);
    });

    test("paginates with limit and cursor", async () => {
      const adapter = memory();
      await seedKeys(adapter, ["a", "b", "c", "d", "e"]);
      const page1 = await adapter.list({ limit: 2 });
      expect(page1.items.map((i) => i.key)).toEqual(["a", "b"]);
      expect(page1.cursor).toBe("b");
      const page2 = await adapter.list({ cursor: page1.cursor, limit: 2 });
      expect(page2.items.map((i) => i.key)).toEqual(["c", "d"]);
      expect(page2.cursor).toBe("d");
      const page3 = await adapter.list({ cursor: page2.cursor, limit: 2 });
      expect(page3.items.map((i) => i.key)).toEqual(["e"]);
      expect(page3.cursor).toBeUndefined();
    });

    test("a cursor past the last key returns nothing", async () => {
      const adapter = memory();
      await seedKeys(adapter, ["a", "b", "c", "d", "e"]);
      const { items, cursor } = await adapter.list({ cursor: "z" });
      expect(items).toEqual([]);
      expect(cursor).toBeUndefined();
    });

    test("a delimiter collapses folders into common prefixes", async () => {
      const adapter = memory();
      await adapter.upload("a/1.txt", "1");
      await adapter.upload("a/b/2.txt", "2");
      await adapter.upload("a/c/3.txt", "3");
      const { items, prefixes } = await adapter.list({
        delimiter: "/",
        prefix: "a/",
      });
      expect(items.map((i) => i.key)).toEqual(["a/1.txt"]);
      expect(prefixes).toEqual(["a/b/", "a/c/"]);
    });

    test("a delimiter paginates items and prefixes together", async () => {
      const adapter = memory();
      await adapter.upload("a/1.txt", "1");
      await adapter.upload("a/b/2.txt", "2");
      const page1 = await adapter.list({
        delimiter: "/",
        limit: 1,
        prefix: "a/",
      });
      expect(page1.items.map((i) => i.key)).toEqual(["a/1.txt"]);
      expect(page1.cursor).toBe("a/1.txt");
      const page2 = await adapter.list({
        cursor: page1.cursor,
        delimiter: "/",
        limit: 1,
        prefix: "a/",
      });
      expect(page2.prefixes).toEqual(["a/b/"]);
    });
  });

  describe("url", () => {
    test("returns an opaque memory:// URL for an existing key", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "x");
      expect(await adapter.url("a.txt")).toBe("memory://a.txt");
    });

    test("missing key throws NotFound", async () => {
      const adapter = memory();
      await expect(adapter.url("nope")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("reflects expiresIn and responseContentDisposition when passed", async () => {
      const adapter = memory();
      await adapter.upload("a.txt", "x");
      expect(await adapter.url("a.txt", { expiresIn: 60 })).toBe(
        "memory://a.txt?expires=60"
      );
      const withDisposition = await adapter.url("a.txt", {
        responseContentDisposition: "attachment",
      });
      expect(withDisposition).toBe(
        "memory://a.txt?response-content-disposition=attachment"
      );
    });
  });

  describe("signedUploadUrl", () => {
    test("returns a placeholder PUT target with the requested expiry", async () => {
      const adapter = memory();
      const signed = await adapter.signedUploadUrl("a.txt", { expiresIn: 120 });
      expect(signed).toEqual({
        headers: {},
        method: "PUT",
        url: "memory://a.txt?expires=120",
      });
    });

    test("binds Content-Type when provided", async () => {
      const adapter = memory();
      const signed = await adapter.signedUploadUrl("a.txt", {
        contentType: "text/plain",
        expiresIn: 60,
      });
      expect(signed.method).toBe("PUT");
      if (signed.method === "PUT") {
        expect(signed.headers).toEqual({ "Content-Type": "text/plain" });
      }
    });

    test("does not require the key to exist", async () => {
      const adapter = memory();
      await expect(
        adapter.signedUploadUrl("not-yet.txt", { expiresIn: 60 })
      ).resolves.toMatchObject({ method: "PUT" });
    });
  });

  describe("through the Files wrapper", () => {
    test("round-trips with a prefix", async () => {
      const adapter = memory();
      const files = new Files({ adapter, prefix: "tenant-1" });
      await files.upload("a.txt", "hello");
      const file = await files.download("a.txt");
      expect(await file.text()).toBe("hello");
      // The prefix is applied to the underlying key.
      expect(adapter.raw.has("tenant-1/a.txt")).toBe(true);
    });

    test("FilesError from a missing key propagates", async () => {
      const files = new Files({ adapter: memory() });
      await expect(files.download("nope")).rejects.toBeInstanceOf(FilesError);
    });
  });
});

describe("memory resumable uploads (in-process)", () => {
  test("fresh upload completes and stores the bytes", async () => {
    const files = new Files({ adapter: memory() });
    const control = new UploadControl();
    const result = await files.upload("doc.txt", "abcdefghijkl", {
      control,
      multipart: { partSize: 4 },
    });
    expect(result.size).toBe(12);
    expect(control.status).toBe("completed");
    const got = await files.download("doc.txt");
    expect(await got.text()).toBe("abcdefghijkl");
    expect(control.session?.provider).toBe("memory");
  });

  test("pause holds the upload, resume finishes it", async () => {
    const files = new Files({ adapter: memory() });
    const control = new UploadControl();
    let paused = false;
    const promise = files.upload("p.bin", new Uint8Array(12).fill(7), {
      control,
      multipart: { concurrency: 1, partSize: 4 },
      onProgress: ({ loaded }) => {
        if (loaded === 4 && !paused) {
          paused = true;
          control.pause();
        }
      },
    });
    await delay(0);
    await delay(0);
    expect(control.status).toBe("paused");
    control.resume();
    const result = await promise;
    expect(result.size).toBe(12);
  });

  test("abort discards the pending upload", async () => {
    const adapter = memory();
    const files = new Files({ adapter });
    const control = new UploadControl();
    let aborting: Promise<void> | undefined;
    const promise = files.upload("a.bin", new Uint8Array(12).fill(9), {
      control,
      multipart: { concurrency: 1, partSize: 4 },
      onProgress: ({ loaded }) => {
        if (loaded === 4 && !aborting) {
          aborting = control.abort();
        }
      },
    });
    await expect(promise).rejects.toMatchObject({ aborted: true });
    await aborting;
    expect(control.status).toBe("aborted");
    expect(await files.exists("a.bin")).toBe(false);
  });

  test("a token can't be resumed in a different instance (in-process only)", async () => {
    const files = new Files({ adapter: memory() });
    const token: ResumableUploadSession = {
      contentType: "text/plain",
      key: "x.bin",
      provider: "memory",
      uploadId: "mem-1",
    };
    await expect(
      files.upload("x.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/in-process only/u);
  });

  test("resuming a non-memory token throws", async () => {
    const files = new Files({ adapter: memory() });
    const token = {
      bucket: "b",
      key: "x.bin",
      provider: "gcs",
      uri: "u",
    } as ResumableUploadSession;
    await expect(
      files.upload("x.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/Cannot resume a gcs/u);
  });
});
