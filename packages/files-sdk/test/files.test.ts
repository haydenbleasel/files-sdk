import { describe, expect, mock, test } from "bun:test";

import { Files, FilesError } from "../src/index.js";
import type {
  Adapter,
  ListOptions,
  OperationOptions,
  UploadProgress,
} from "../src/index.js";
import { countingStream } from "../src/internal/core.js";
import { fakeAdapter } from "./fake-adapter.js";

const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

describe("Files class", () => {
  test("upload + download round-trip", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    const result = await files.upload("a.txt", "hello", {
      contentType: "text/plain",
      metadata: { user: "1" },
    });
    expect(result.key).toBe("a.txt");
    expect(result.size).toBe(5);
    expect(result.contentType).toBe("text/plain");
    expect(result.etag).toBeTruthy();

    const got = await files.download("a.txt");
    expect(got.key).toBe("a.txt");
    expect(got.size).toBe(5);
    expect(await got.text()).toBe("hello");
    expect(got.metadata).toEqual({ user: "1" });
  });

  test("download yields a StoredFile with body accessors", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("data.bin", new Uint8Array([1, 2, 3, 4]));
    const got = await files.download("data.bin");
    const buf = await got.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4]));
    const blob = await got.blob();
    expect(blob.size).toBe(4);
  });

  test("download supports streaming consumer via stream()", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("s.txt", "stream-me");
    const got = await files.download("s.txt");
    const reader = got.stream().getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
    expect(chunks.length).toBeGreaterThan(0);
  });

  test("download forwards a byte range to a supporting adapter", async () => {
    const files = new Files({ adapter: fakeAdapter({ supportsRange: true }) });
    await files.upload("r.txt", "0123456789");
    const got = await files.download("r.txt", { range: { end: 4, start: 2 } });
    // Inclusive end: bytes 2..4 → "234", and size reflects the slice.
    expect(await got.text()).toBe("234");
    expect(got.size).toBe(3);
  });

  test("download with an open-ended range reads to EOF", async () => {
    const files = new Files({ adapter: fakeAdapter({ supportsRange: true }) });
    await files.upload("r.txt", "0123456789");
    const got = await files.download("r.txt", { range: { start: 7 } });
    expect(await got.text()).toBe("789");
    expect(got.size).toBe(3);
  });

  test("download with a range throws on an adapter without range support", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("r.txt", "0123456789");
    await expect(
      files.download("r.txt", { range: { start: 0 } })
    ).rejects.toThrow(/range downloads are not supported/u);
  });

  test("download rejects a malformed byte range before hitting the adapter", async () => {
    const files = new Files({ adapter: fakeAdapter({ supportsRange: true }) });
    await files.upload("r.txt", "0123456789");
    await expect(
      files.download("r.txt", { range: { start: -1 } })
    ).rejects.toThrow(/range\.start must be a non-negative integer/u);
    await expect(
      files.download("r.txt", { range: { start: 1.5 } })
    ).rejects.toThrow(/range\.start must be a non-negative integer/u);
    await expect(
      files.download("r.txt", { range: { end: 2, start: 5 } })
    ).rejects.toThrow(/range\.end must be an integer/u);
    await expect(
      files.download("r.txt", { range: { end: 4.5, start: 0 } })
    ).rejects.toThrow(/range\.end must be an integer/u);
  });

  test("head returns metadata-only StoredFile", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("h.txt", "x");
    const info = await files.head("h.txt");
    expect(info.key).toBe("h.txt");
    expect(info.size).toBe(1);
  });

  test("exists returns true for present keys and false for missing ones", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("e.txt", "x");
    expect(await files.exists("e.txt")).toBe(true);
    expect(await files.exists("missing.txt")).toBe(false);
  });

  test("delete removes the object", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    await files.upload("d.txt", "x");
    expect(adapter.has("d.txt")).toBe(true);
    await files.delete("d.txt");
    expect(adapter.has("d.txt")).toBe(false);
  });

  test("delete overload: string resolves void, array resolves a result", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    await files.upload("one.txt", "x");
    await files.upload("two.txt", "y");

    // String form resolves to void.
    const single = await files.delete("one.txt");
    expect(single).toBeUndefined();
    expect(adapter.has("one.txt")).toBe(false);

    // Array form resolves to a structured DeleteManyResult.
    const many = await files.delete(["two.txt"]);
    expect(many).toEqual({ deleted: ["two.txt"] });
    expect(adapter.has("two.txt")).toBe(false);
  });

  test("delete (array) removes multiple objects", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    await files.upload("a.txt", "a");
    await files.upload("b.txt", "b");
    await files.upload("c.txt", "c");

    const result = await files.delete(["a.txt", "b.txt", "c.txt"]);

    expect(result).toEqual({ deleted: ["a.txt", "b.txt", "c.txt"] });
    expect(adapter.has("a.txt")).toBe(false);
    expect(adapter.has("b.txt")).toBe(false);
    expect(adapter.has("c.txt")).toBe(false);
  });

  test("delete (array) returns per-key errors and continues when stopOnError is false", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    await files.upload("ok-1.txt", "1");
    await files.upload("ok-2.txt", "2");

    const result = await files.delete(
      ["ok-1.txt", "fail/a.txt", "ok-2.txt", "fail/b.txt"],
      { stopOnError: false }
    );

    expect(result.deleted).toEqual(["ok-1.txt", "ok-2.txt"]);
    expect(result.errors?.map((item) => item.key)).toEqual([
      "fail/a.txt",
      "fail/b.txt",
    ]);
    expect(adapter.has("ok-1.txt")).toBe(false);
    expect(adapter.has("ok-2.txt")).toBe(false);
  });

  test("delete (array) stops on the first error when stopOnError is true", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    await files.upload("ok-1.txt", "1");
    await files.upload("ok-2.txt", "2");

    const result = await files.delete(["ok-1.txt", "fail/a.txt", "ok-2.txt"], {
      stopOnError: true,
    });

    expect(result.deleted).toEqual(["ok-1.txt"]);
    expect(result.errors?.map((item) => item.key)).toEqual(["fail/a.txt"]);
    expect(adapter.has("ok-2.txt")).toBe(true);
  });

  test("delete (array) returns validation errors without skipping valid keys", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    await files.upload("ok.txt", "1");

    const result = await files.delete(["", "ok.txt", "foo\0bar"], {
      stopOnError: false,
    });

    expect(result.deleted).toEqual(["ok.txt"]);
    expect(result.errors?.map((item) => item.key)).toEqual(["", "foo\0bar"]);
  });

  test("delete (array) applies the configured prefix but reports caller keys", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "uploads" });
    await files.upload("a.txt", "a");
    await files.upload("b.txt", "b");

    const result = await files.delete(["a.txt", "b.txt"]);

    // Result reflects the keys the caller passed, not the prefixed paths.
    expect(result).toEqual({ deleted: ["a.txt", "b.txt"] });
    expect(adapter.has("uploads/a.txt")).toBe(false);
    expect(adapter.has("uploads/b.txt")).toBe(false);
  });

  test("delete (array) falls back to per-key delete and forwards stopOnError", async () => {
    const base = fakeAdapter();
    // Drop the native bulk path so delete([...]) uses the fallback.
    const { deleteMany: _omitted, ...rest } = base;
    const attempted: string[] = [];
    const adapter: Adapter = {
      ...rest,
      delete(key: string) {
        attempted.push(key);
        if (key.startsWith("fail/")) {
          return Promise.reject(new FilesError("Provider", `nope: ${key}`));
        }
        return base.delete(key);
      },
    };
    const files = new Files({ adapter });

    const result = await files.delete(["ok-1.txt", "fail/x.txt", "ok-2.txt"], {
      stopOnError: true,
    });

    expect(result.deleted).toEqual(["ok-1.txt"]);
    expect(result.errors?.map((item) => item.key)).toEqual(["fail/x.txt"]);
    // stopOnError must short-circuit the fallback: ok-2.txt is never attempted.
    expect(attempted).toEqual(["ok-1.txt", "fail/x.txt"]);
  });

  test("delete (array) fallback bounds concurrency and preserves order", async () => {
    const base = fakeAdapter();
    // Drop the native bulk path so delete([...]) uses the worker pool.
    const { deleteMany: _omitted, ...rest } = base;
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter: Adapter = {
      ...rest,
      async delete(key: string) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield so overlapping workers pile up before any settles.
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        if (key.startsWith("fail/")) {
          throw new FilesError("Provider", `nope: ${key}`);
        }
        await base.delete(key);
      },
    };
    const files = new Files({ adapter });
    const keys = [
      "a.txt",
      "fail/b.txt",
      "c.txt",
      "d.txt",
      "fail/e.txt",
      "f.txt",
    ];

    const result = await files.delete(keys, { concurrency: 2 });

    expect(result.deleted).toEqual(["a.txt", "c.txt", "d.txt", "f.txt"]);
    expect(result.errors?.map((item) => item.key)).toEqual([
      "fail/b.txt",
      "fail/e.txt",
    ]);
    // Never more than the configured limit in flight, but it did run > 1 at
    // once (otherwise concurrency would be meaningless).
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test("delete (array) orders errors by input position across validation and provider failures", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    await files.upload("ok.txt", "1");

    const result = await files.delete(
      ["fail/a.txt", "", "ok.txt", "fail/b.txt", "x\0y"],
      { stopOnError: false }
    );

    expect(result.deleted).toEqual(["ok.txt"]);
    // A provider failure, two invalid keys, and another provider failure —
    // all reported in the original input order, not grouped by source.
    expect(result.errors?.map((item) => item.key)).toEqual([
      "fail/a.txt",
      "",
      "fail/b.txt",
      "x\0y",
    ]);
  });

  test("upload (array) stores many and returns results in input order", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });

    const result = await files.upload([
      { body: "a", contentType: "text/plain", key: "a.txt" },
      { body: "b", key: "b.txt" },
      { body: new Uint8Array([1, 2, 3]), key: "c.txt" },
    ]);

    expect(result.uploaded.map((u) => u.key)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
    expect(result.errors).toBeUndefined();
    expect(result.uploaded[0]?.contentType).toBe("text/plain");
    expect(adapter.has("a.txt")).toBe(true);
    expect(adapter.has("c.txt")).toBe(true);
  });

  test("upload (array) collects per-item errors without throwing", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });

    const result = await files.upload([
      { body: "x", key: "ok.txt" },
      { body: "y", key: "" },
      { body: "z", key: "foo\0bar" },
    ]);

    expect(result.uploaded.map((u) => u.key)).toEqual(["ok.txt"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["", "foo\0bar"]);
  });

  test("upload (array) applies the prefix but reports caller keys", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "uploads" });

    const result = await files.upload([
      { body: "a", key: "a.txt" },
      { body: "b", key: "b.txt" },
    ]);

    expect(result.uploaded.map((u) => u.key)).toEqual(["a.txt", "b.txt"]);
    expect(adapter.has("uploads/a.txt")).toBe(true);
    expect(adapter.has("uploads/b.txt")).toBe(true);
  });

  test("upload (array) forwards per-item multipart to the adapter", async () => {
    const base = fakeAdapter();
    const seen: { key: string; multipart: unknown }[] = [];
    const adapter: Adapter = {
      ...base,
      upload(key, body, opts) {
        seen.push({ key, multipart: opts?.multipart });
        return base.upload(key, body, opts);
      },
    };
    const files = new Files({ adapter });

    await files.upload([
      { body: "a", key: "a.txt", multipart: true },
      { body: "b", key: "b.txt", multipart: { partSize: 8 * 1024 * 1024 } },
      { body: "c", key: "c.txt" },
    ]);

    expect(seen).toEqual([
      { key: "a.txt", multipart: true },
      { key: "b.txt", multipart: { partSize: 8 * 1024 * 1024 } },
      { key: "c.txt", multipart: undefined },
    ]);
  });

  test("upload (array) stops on the first error when stopOnError is true", async () => {
    const base = fakeAdapter();
    const attempted: string[] = [];
    const adapter: Adapter = {
      ...base,
      upload(key: string, body, opts) {
        attempted.push(key);
        if (key.startsWith("fail/")) {
          return Promise.reject(new FilesError("Provider", `nope: ${key}`));
        }
        return base.upload(key, body, opts);
      },
    };
    const files = new Files({ adapter });

    const result = await files.upload(
      [
        { body: "1", key: "ok-1.txt" },
        { body: "2", key: "fail/x.txt" },
        { body: "3", key: "ok-2.txt" },
      ],
      { stopOnError: true }
    );

    expect(result.uploaded.map((u) => u.key)).toEqual(["ok-1.txt"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["fail/x.txt"]);
    // stopOnError short-circuits: ok-2.txt is never attempted.
    expect(attempted).toEqual(["ok-1.txt", "fail/x.txt"]);
  });

  test("download (array) returns files in order and collects misses", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    await files.upload("a.txt", "aa");
    await files.upload("c.txt", "cccc");

    const result = await files.download(["a.txt", "missing.txt", "c.txt"]);

    expect(result.downloaded.map((f) => f.key)).toEqual(["a.txt", "c.txt"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["missing.txt"]);
    expect(await result.downloaded[0]?.text()).toBe("aa");
  });

  test("download (array) applies the prefix but reports caller keys", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "p" });
    await files.upload("a.txt", "a");

    const result = await files.download(["a.txt", "missing.txt"]);

    expect(result.downloaded.map((f) => f.key)).toEqual(["a.txt"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["missing.txt"]);
  });

  test("download (array) bounds concurrency and preserves order", async () => {
    const base = fakeAdapter();
    let inFlight = 0;
    let maxInFlight = 0;
    const adapter: Adapter = {
      ...base,
      async download(key: string, opts) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
        return base.download(key, opts);
      },
    };
    const files = new Files({ adapter });
    const keys = ["a", "b", "c", "d", "e", "f"];
    for (const key of keys) {
      await files.upload(key, key);
    }

    const result = await files.download(keys, { concurrency: 2 });

    expect(result.downloaded.map((f) => f.key)).toEqual(keys);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test("head (array) returns metadata files and collects misses", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    await files.upload("a.txt", "aa");
    await files.upload("b.txt", "bbb");

    const result = await files.head(["a.txt", "missing.txt", "b.txt"]);

    expect(result.files.map((f) => f.key)).toEqual(["a.txt", "b.txt"]);
    expect(result.files.map((f) => f.size)).toEqual([2, 3]);
    expect(result.errors?.map((e) => e.key)).toEqual(["missing.txt"]);
  });

  test("exists (array) splits existing and missing in input order", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    await files.upload("a.txt", "a");
    await files.upload("c.txt", "c");

    const result = await files.exists(["a.txt", "b.txt", "c.txt", "d.txt"]);

    expect(result).toEqual({
      existing: ["a.txt", "c.txt"],
      missing: ["b.txt", "d.txt"],
    });
  });

  test("exists (array) collects hard errors separately from missing", async () => {
    const base = fakeAdapter();
    const adapter: Adapter = {
      ...base,
      exists(key: string, opts) {
        if (key.startsWith("fail/")) {
          return Promise.reject(new FilesError("Unauthorized", `nope: ${key}`));
        }
        return base.exists(key, opts);
      },
    };
    const files = new Files({ adapter });
    await files.upload("a.txt", "a");

    const result = await files.exists(["a.txt", "missing.txt", "fail/x.txt"]);

    expect(result.existing).toEqual(["a.txt"]);
    expect(result.missing).toEqual(["missing.txt"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["fail/x.txt"]);
  });

  test("exists (array) applies the prefix but reports caller keys", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "p" });
    await files.upload("a.txt", "a");

    const result = await files.exists(["a.txt", "b.txt"]);

    expect(result).toEqual({ existing: ["a.txt"], missing: ["b.txt"] });
    expect(adapter.has("p/a.txt")).toBe(true);
  });

  test("bulk forms accept an empty array", async () => {
    const files = new Files({ adapter: fakeAdapter() });

    expect(await files.upload([])).toEqual({ uploaded: [] });
    expect(await files.download([])).toEqual({ downloaded: [] });
    expect(await files.head([])).toEqual({ files: [] });
    expect(await files.exists([])).toEqual({ existing: [], missing: [] });
  });

  test("copy duplicates an object", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("from.txt", "payload");
    await files.copy("from.txt", "to.txt");
    const got = await files.download("to.txt");
    expect(await got.text()).toBe("payload");
  });

  test("file handle binds operations to one key", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    const file = files.file("handle.txt");

    expect(file.key).toBe("handle.txt");
    expect(await file.exists()).toBe(false);

    const uploaded = await file.upload("hello", { contentType: "text/plain" });
    expect(uploaded.key).toBe("handle.txt");
    expect(await file.exists()).toBe(true);

    const meta = await file.head();
    expect(meta.key).toBe("handle.txt");
    expect(meta.type).toBe("text/plain");

    const downloaded = await file.download();
    expect(await downloaded.text()).toBe("hello");

    const url = await file.url({ expiresIn: 60 });
    expect(url).toContain("handle.txt");
    expect(url).toContain("expires=60");

    const signed = await file.signedUploadUrl({ expiresIn: 60 });
    expect(signed.method).toBe("PUT");

    await file.delete();
    expect(await file.exists()).toBe(false);
  });

  test("file handle supports copy helpers", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    const source = files.file("source.txt");
    await source.upload("payload");

    await source.copyTo("copy.txt");
    const copied = await files.download("copy.txt");
    expect(await copied.text()).toBe("payload");

    const mirror = files.file("mirror.txt");
    await mirror.copyFrom("copy.txt");
    const mirrored = await mirror.download();
    expect(await mirrored.text()).toBe("payload");
  });

  test("move relocates an object via copy+delete fallback", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    await files.upload("from.txt", "payload");

    await files.move("from.txt", "to.txt");

    expect(adapter.has("from.txt")).toBe(false);
    const got = await files.download("to.txt");
    expect(await got.text()).toBe("payload");
  });

  test("move is a no-op when source and destination are the same key", async () => {
    const adapter = fakeAdapter();
    // A naive copy+delete would copy the object onto itself, then delete it —
    // destroying it. The same-key guard must prevent that.
    const copy = mock(adapter.copy);
    const del = mock(adapter.delete);
    const files = new Files({ adapter: { ...adapter, copy, delete: del } });
    await files.upload("same.txt", "keep");

    await files.move("same.txt", "same.txt");

    expect(copy).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    const got = await files.download("same.txt");
    expect(await got.text()).toBe("keep");
  });

  test("move prefers the adapter's native move when present", async () => {
    const base = fakeAdapter();
    const native = mock((from: string, to: string) => base.copy(from, to));
    const copy = mock(base.copy);
    const del = mock(base.delete);
    const adapter = { ...base, copy, delete: del, move: native };
    const files = new Files({ adapter });
    await files.upload("from.txt", "payload");

    await files.move("from.txt", "to.txt");

    expect(native).toHaveBeenCalledWith("from.txt", "to.txt", undefined);
    // Native move owns the relocation — the copy+delete fallback must not run.
    expect(copy).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  test("file handle supports move helpers", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    const source = files.file("source.txt");
    await source.upload("payload");

    await source.moveTo("moved.txt");
    expect(await source.exists()).toBe(false);
    const moved = await files.download("moved.txt");
    expect(await moved.text()).toBe("payload");

    const target = files.file("final.txt");
    await target.moveFrom("moved.txt");
    expect(await files.exists("moved.txt")).toBe(false);
    const final = await target.download();
    expect(await final.text()).toBe("payload");
  });

  test("listAll iterates every object across pages", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    for (let i = 0; i < 5; i += 1) {
      await files.upload(`f${i}.txt`, String(i));
    }

    const keys: string[] = [];
    // A page size below the total forces listAll to follow the cursor.
    for await (const file of files.listAll({ limit: 2 })) {
      keys.push(file.key);
    }

    expect(keys.toSorted()).toEqual([
      "f0.txt",
      "f1.txt",
      "f2.txt",
      "f3.txt",
      "f4.txt",
    ]);
  });

  test("listAll honors prefix and the constructor prefix strips keys", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "users" });
    await files.upload("avatars/1.png", "one");
    await files.upload("avatars/2.png", "two");
    await files.upload("docs/1.txt", "doc");

    const keys: string[] = [];
    for await (const file of files.listAll({ limit: 1, prefix: "avatars/" })) {
      keys.push(file.key);
    }

    expect(keys.toSorted()).toEqual(["avatars/1.png", "avatars/2.png"]);
  });

  test("list returns items filtered by prefix", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("a/1.txt", "1");
    await files.upload("a/2.txt", "2");
    await files.upload("b/3.txt", "3");
    const { items } = await files.list({ prefix: "a/" });
    expect(items.map((i) => i.key).toSorted()).toEqual(["a/1.txt", "a/2.txt"]);
  });

  test("list with a delimiter returns folders as common prefixes", async () => {
    const files = new Files({
      adapter: fakeAdapter({ supportsDelimiter: true }),
    });
    await files.upload("a/1.txt", "1");
    await files.upload("a/b/2.txt", "2");
    await files.upload("a/c/3.txt", "3");
    const { items, prefixes } = await files.list({
      delimiter: "/",
      prefix: "a/",
    });
    expect(items.map((i) => i.key)).toEqual(["a/1.txt"]);
    expect(prefixes).toEqual(["a/b/", "a/c/"]);
  });

  test("a constructor prefix strips both item keys and common prefixes", async () => {
    const files = new Files({
      adapter: fakeAdapter({ supportsDelimiter: true }),
      prefix: "users",
    });
    await files.upload("avatars/1.png", "one");
    await files.upload("avatars/thumbs/2.png", "two");
    const { items, prefixes } = await files.list({
      delimiter: "/",
      prefix: "avatars/",
    });
    expect(items.map((i) => i.key)).toEqual(["avatars/1.png"]);
    expect(prefixes).toEqual(["avatars/thumbs/"]);
  });

  test("list rejects a delimiter on an adapter without support", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("a/1.txt", "1");
    await expect(files.list({ delimiter: "/" })).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("list rejects an empty delimiter", async () => {
    const files = new Files({
      adapter: fakeAdapter({ supportsDelimiter: true }),
    });
    await expect(files.list({ delimiter: "" })).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("listAll ignores delimiter and walks the whole tree", async () => {
    const files = new Files({
      adapter: fakeAdapter({ supportsDelimiter: true }),
    });
    await files.upload("a/1.txt", "1");
    await files.upload("a/b/2.txt", "2");
    await files.upload("a/c/3.txt", "3");
    const keys: string[] = [];
    for await (const file of files.listAll({ delimiter: "/", prefix: "a/" })) {
      keys.push(file.key);
    }
    expect(keys.toSorted()).toEqual(["a/1.txt", "a/b/2.txt", "a/c/3.txt"]);
  });

  test("constructor retries Provider failures", async () => {
    const adapter = fakeAdapter();
    let attempts = 0;
    const files = new Files({
      adapter: {
        ...adapter,
        head(key: string, opts?: OperationOptions) {
          attempts += 1;
          if (attempts < 3) {
            throw new TypeError("temporary");
          }
          return adapter.head(key, opts);
        },
      },
      retries: 2,
    });

    await files.upload("retry.txt", "ok");
    const info = await files.head("retry.txt");

    expect(info.key).toBe("retry.txt");
    expect(attempts).toBe(3);
  });

  test("retry backoff receives attempt and wrapped error", async () => {
    const adapter = fakeAdapter();
    const backoffCalls: { attempt: number; message: string }[] = [];
    let attempts = 0;
    const files = new Files({
      adapter: {
        ...adapter,
        exists(key: string, opts?: OperationOptions) {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("network");
          }
          return adapter.exists(key, opts);
        },
      },
      retries: {
        backoff: ({ attempt, error }) => {
          backoffCalls.push({ attempt, message: error.message });
          return 0;
        },
        max: 1,
      },
    });

    await files.upload("exists.txt", "ok");

    expect(await files.exists("exists.txt")).toBe(true);
    expect(backoffCalls).toEqual([{ attempt: 1, message: "network" }]);
  });

  test("per-call retries override constructor retries", async () => {
    const adapter = fakeAdapter();
    let attempts = 0;
    const files = new Files({
      adapter: {
        ...adapter,
        head(key: string, opts?: OperationOptions) {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("temporary");
          }
          return adapter.head(key, opts);
        },
      },
      retries: 0,
    });

    await files.upload("override.txt", "ok");
    await files.head("override.txt", { retries: { backoff: () => 0, max: 1 } });

    expect(attempts).toBe(2);
  });

  test("NotFound errors are not retried", async () => {
    const adapter = fakeAdapter();
    let attempts = 0;
    const files = new Files({
      adapter: {
        ...adapter,
        head() {
          attempts += 1;
          throw new FilesError("NotFound", "missing");
        },
      },
      retries: { backoff: () => 0, max: 3 },
    });

    try {
      await files.head("missing.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("NotFound");
      expect(attempts).toBe(1);
    }
  });

  test("Unauthorized and Conflict errors are not retried", async () => {
    for (const code of ["Unauthorized", "Conflict"] as const) {
      let attempts = 0;
      const files = new Files({
        adapter: {
          ...fakeAdapter(),
          head() {
            attempts += 1;
            throw new FilesError(code, code);
          },
        },
        retries: { backoff: () => 0, max: 3 },
      });

      try {
        await files.head(`${code}.txt`);
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe(code);
        expect(attempts).toBe(1);
      }
    }
  });

  test("retries stop at the configured max", async () => {
    let attempts = 0;
    const files = new Files({
      adapter: {
        ...fakeAdapter(),
        exists() {
          attempts += 1;
          throw new Error("still broken");
        },
      },
      retries: { backoff: () => 0, max: 2 },
    });

    try {
      await files.exists("cap.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).message).toBe("still broken");
      expect(attempts).toBe(3);
    }
  });

  test("ReadableStream uploads are not retried", async () => {
    let attempts = 0;
    const files = new Files({
      adapter: {
        ...fakeAdapter(),
        upload() {
          attempts += 1;
          throw new Error("stream upload failed");
        },
      },
      retries: { backoff: () => 0, max: 3 },
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("payload"));
        controller.close();
      },
    });

    try {
      await files.upload("stream.txt", stream);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).message).toBe("stream upload failed");
      expect(attempts).toBe(1);
    }
  });

  test("timeout aborts an operation, passes signal to the adapter, and is not retried", async () => {
    let attempts = 0;
    let seenSignal: AbortSignal | undefined;
    const files = new Files({
      adapter: {
        ...fakeAdapter(),
        head(_key: string, opts?: OperationOptions): Promise<never> {
          attempts += 1;
          seenSignal = opts?.signal;
          // oxlint-disable-next-line promise/avoid-new -- test needs a pending adapter call.
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              reject(opts.signal?.reason);
            });
          });
        },
      },
      retries: 3,
      timeout: 1,
    });

    try {
      await files.head("slow.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toBe(
        "Operation timed out after 1ms"
      );
      expect(attempts).toBe(1);
      expect(seenSignal).toBeDefined();
      expect(seenSignal?.aborted).toBe(true);
    }
  });

  test("aborted caller signal fails before the adapter is called", async () => {
    let attempts = 0;
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const files = new Files({
      adapter: {
        ...fakeAdapter(),
        exists() {
          attempts += 1;
          return Promise.resolve(true);
        },
      },
      retries: 3,
    });

    try {
      await files.exists("x.txt", { signal: controller.signal });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).message).toBe("Operation aborted: stop");
      expect(attempts).toBe(0);
    }
  });

  test("constructor signal aborts a pending operation", async () => {
    const controller = new AbortController();
    const files = new Files({
      adapter: {
        ...fakeAdapter(),
        head(_key: string, opts?: OperationOptions): Promise<never> {
          // oxlint-disable-next-line promise/avoid-new -- test needs a pending adapter call.
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              reject(new Error("adapter saw abort"));
            });
          });
        },
      },
      signal: controller.signal,
    });

    const pending = files.head("constructor-abort.txt");
    controller.abort(new Error("constructor stop"));

    try {
      await pending;
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).message).toBe(
        "Operation aborted: constructor stop"
      );
    }
  });

  test("bulk reads honor the constructor signal", async () => {
    const controller = new AbortController();
    const files = new Files({
      adapter: {
        ...fakeAdapter(),
        head(_key: string, opts?: OperationOptions): Promise<never> {
          // oxlint-disable-next-line promise/avoid-new -- test needs a pending adapter call.
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              reject(new Error("adapter saw abort"));
            });
          });
        },
      },
      signal: controller.signal,
    });

    const pending = files.head(["a.txt", "b.txt"]);
    controller.abort(new Error("bulk stop"));

    const result = await pending;
    expect(result.files).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    for (const entry of result.errors ?? []) {
      expect(entry.error.aborted).toBe(true);
    }
  });

  test("bulk deletes honor the constructor timeout", async () => {
    const files = new Files({
      adapter: {
        ...fakeAdapter(),
        delete(_key: string, opts?: OperationOptions): Promise<never> {
          // oxlint-disable-next-line promise/avoid-new -- test needs a pending adapter call.
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              reject(opts.signal?.reason);
            });
          });
        },
        // Force the per-key fan-out path past the hanging delete().
        deleteMany: undefined,
      },
      timeout: 20,
    });

    const result = await files.delete(["slow-1", "slow-2"]);
    expect(result.deleted).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    for (const entry of result.errors ?? []) {
      expect(entry.error.timedOut).toBe(true);
    }
  });

  test("per-call signal aborts a pending operation even with a constructor signal", async () => {
    const constructorController = new AbortController();
    const callController = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const files = new Files({
      adapter: {
        ...fakeAdapter(),
        head(_key: string, opts?: OperationOptions): Promise<never> {
          seenSignal = opts?.signal;
          // oxlint-disable-next-line promise/avoid-new -- test needs a pending adapter call.
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              reject(new Error("adapter saw abort"));
            });
          });
        },
      },
      signal: constructorController.signal,
    });

    const pending = files.head("call-abort.txt", {
      signal: callController.signal,
    });
    callController.abort(new Error("call stop"));

    try {
      await pending;
      throw new Error("should have thrown");
    } catch (error) {
      expect(seenSignal).toBeDefined();
      expect(seenSignal).not.toBe(constructorController.signal);
      expect(seenSignal).not.toBe(callController.signal);
      expect((error as FilesError).message).toBe(
        "Operation aborted: call stop"
      );
    }
  });

  test("per-call timeout overrides the constructor timeout", async () => {
    let attempts = 0;
    const files = new Files({
      adapter: {
        ...fakeAdapter(),
        head(_key: string, opts?: OperationOptions): Promise<never> {
          attempts += 1;
          // oxlint-disable-next-line promise/avoid-new -- test needs a pending adapter call.
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              reject(opts.signal?.reason);
            });
          });
        },
      },
      retries: 2,
      timeout: 50,
    });

    try {
      await files.head("override-timeout.txt", { timeout: 1 });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).message).toBe(
        "Operation timed out after 1ms"
      );
      expect(attempts).toBe(1);
    }
  });

  test("file handles forward per-call operation options", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const adapter = fakeAdapter();
    const files = new Files({
      adapter: {
        ...adapter,
        delete(key: string, opts?: OperationOptions) {
          seenSignal = opts?.signal;
          return adapter.delete(key, opts);
        },
      },
    });

    await files.upload("handle-options.txt", "ok");
    await files
      .file("handle-options.txt")
      .delete({ signal: controller.signal });

    expect(seenSignal).toBe(controller.signal);
  });

  test("constructor prefix round-trips upload, head, download, and exists keys", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "users" });

    const uploaded = await files.upload("123", "avatar");
    expect(uploaded.key).toBe("123");
    expect(adapter.has("users/123")).toBe(true);

    const head = await files.head(uploaded.key);
    expect(head.key).toBe("123");
    // `name` aliases the key and must be stripped alongside it.
    expect(head.name).toBe("123");
    expect(await files.exists(uploaded.key)).toBe(true);

    const downloaded = await files.download(uploaded.key);
    expect(downloaded.key).toBe("123");
    expect(downloaded.name).toBe("123");
    expect(await downloaded.text()).toBe("avatar");
  });

  test("constructor prefix normalizes leading and trailing slashes on prefix and key", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "/users/" });

    const uploaded = await files.upload("/123", "avatar");
    expect(uploaded.key).toBe("123");
    expect(adapter.has("users/123")).toBe(true);
  });

  test("constructor prefix keeps file handle keys consistent", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "users" });
    const avatar = files.file("123");

    expect(avatar.key).toBe("123");
    await avatar.upload("avatar");
    const head = await avatar.head();
    const downloaded = await avatar.download();
    expect(head.key).toBe("123");
    expect(downloaded.key).toBe("123");
  });

  test("constructor prefix lets listed keys round-trip into delete", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "users" });

    await files.upload("123", "one");
    await files.upload("456", "two");

    const { items } = await files.list();
    expect(items.map((item) => item.key).toSorted()).toEqual(["123", "456"]);

    const [firstItem] = items;
    if (!firstItem) {
      throw new Error("expected a listed item");
    }

    await files.delete(firstItem.key);
    expect(adapter.has("users/123")).toBe(false);
  });

  test("constructor prefix scopes list queries and strips listed item keys", async () => {
    const base = fakeAdapter();
    let seenPrefix: string | undefined;
    const adapter = {
      ...base,
      list(opts?: ListOptions) {
        seenPrefix = opts?.prefix;
        return base.list(opts);
      },
    };
    const files = new Files({ adapter, prefix: "users" });

    await files.upload("avatars/1.png", "one");
    await files.upload("avatars/2.png", "two");
    await files.upload("docs/1.txt", "doc");

    const first = await files.list({ limit: 1, prefix: "avatars" });
    expect(seenPrefix).toBe("users/avatars");
    expect(first.items.map((item) => item.key)).toEqual(["avatars/1.png"]);

    const second = await files.list({
      cursor: first.cursor,
      limit: 1,
      prefix: "avatars",
    });
    expect(second.items.map((item) => item.key)).toEqual(["avatars/2.png"]);
  });

  test("constructor prefix list without explicit prefix does not match sibling paths", async () => {
    const adapter = fakeAdapter();
    await adapter.upload("users/123", "user");
    await adapter.upload("users-archive/123", "archive");
    const files = new Files({ adapter, prefix: "users" });

    const { items } = await files.list();
    expect(items.map((item) => item.key)).toEqual(["123"]);
  });

  test("constructor prefix applies to urls, signed uploads, copy, and handle helpers", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "users" });
    const avatar = files.file("123");

    await avatar.upload("avatar");
    const url = await avatar.url({ expiresIn: 60 });
    expect(url).toContain(encodeURIComponent("users/123"));

    await avatar.copyTo("456");
    const copied = await files.download("456");
    expect(await copied.text()).toBe("avatar");

    const mirror = files.file("789");
    await mirror.copyFrom("456");
    const mirrored = await mirror.download();
    expect(await mirrored.text()).toBe("avatar");

    await files.move("456", "654");
    expect(adapter.has("users/456")).toBe(false);
    expect(adapter.has("users/654")).toBe(true);

    const signed = await files.signedUploadUrl("999", { expiresIn: 60 });
    expect(signed.url).toContain(encodeURIComponent("users/999"));

    await avatar.delete();
    expect(adapter.has("users/123")).toBe(false);
  });

  test("constructor prefix validation rejects non-string, empty-after-trim, and null bytes", () => {
    expect(
      () => new Files({ adapter: fakeAdapter(), prefix: 123 as never })
    ).toThrow(/prefix must be a string/u);
    expect(() => new Files({ adapter: fakeAdapter(), prefix: "///" })).toThrow(
      /prefix must be a non-empty string/u
    );
    expect(
      () => new Files({ adapter: fakeAdapter(), prefix: "users\0bad" })
    ).toThrow(/prefix must not contain null bytes/u);
  });

  test("constructor prefix only strips exact path prefixes from adapter keys", async () => {
    const base = fakeAdapter();
    await base.upload("users/123", "avatar");
    const files = new Files({
      adapter: {
        ...base,
        async head(key) {
          const file = await base.head(key);
          return { ...file, key: "users-archive/123" };
        },
      },
      prefix: "users",
    });

    const head = await files.head("123");
    expect(head.key).toBe("users-archive/123");
  });

  test("error normalization wraps adapter errors as FilesError with code", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    try {
      await files.download("missing");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("non-FilesError thrown by adapter is wrapped as Provider", async () => {
    const adapter = fakeAdapter();
    const broken = {
      ...adapter,
      upload() {
        throw new TypeError("kaboom");
      },
    };
    const files = new Files({ adapter: broken });
    try {
      await files.upload("x", "y");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toBe("kaboom");
    }
  });

  test("raw exposes the adapter's native client", () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    expect(files.raw).toBe(adapter.raw);
  });

  test("adapter getter returns the underlying adapter", () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter });
    expect(files.adapter).toBe(adapter);
  });

  test("capabilities derives flags from the adapter, defaulting conservatively", () => {
    // The fake advertises metadata + cacheControl and nothing else: no range,
    // no progress, no resumable/multipart, no declared signedUrl / copy flags.
    const files = new Files({ adapter: fakeAdapter() });
    expect(files.capabilities).toEqual({
      cacheControl: true,
      delimiter: false,
      metadata: true,
      multipart: false,
      rangeRead: false,
      serverSideCopy: false,
      signedUrl: { supported: false },
      uploadProgress: false,
    });
  });

  test("capabilities reflects range + delimiter when the adapter advertises them", () => {
    const files = new Files({
      adapter: fakeAdapter({ supportsDelimiter: true, supportsRange: true }),
    });
    expect(files.capabilities.rangeRead).toBe(true);
    expect(files.capabilities.delimiter).toBe(true);
  });

  test("capabilities surfaces multipart, progress, copy, and signed-url declarations", () => {
    const base = fakeAdapter();
    const adapter: Adapter = {
      ...base,
      reportsUploadProgress: true,
      resumableUpload: () => {
        throw new Error("unused");
      },
      signedUrl: { maxExpiresIn: 604_800, supported: true },
      supportsServerSideCopy: true,
    };
    const files = new Files({ adapter });
    expect(files.capabilities).toEqual({
      cacheControl: true,
      delimiter: false,
      metadata: true,
      multipart: true,
      rangeRead: false,
      serverSideCopy: true,
      signedUrl: { maxExpiresIn: 604_800, supported: true },
      uploadProgress: true,
    });
  });

  test("url returns a string with the configured expiry", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("k.txt", "v");
    const url = await files.url("k.txt", { expiresIn: 60 });
    expect(url).toMatch(/^https:\/\/fake\.local/u);
    expect(url).toContain("expires=60");
  });

  test("signedUploadUrl returns a discriminated SignedUpload", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    const out = await files.signedUploadUrl("k.txt", { expiresIn: 60 });
    expect(out.method).toBe("PUT");
    expect(out.url).toMatch(/^https:\/\/fake\.local/u);
  });

  test("empty key is rejected at the SDK boundary", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    try {
      await files.upload("", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).message).toMatch(/non-empty/u);
    }
  });

  test("null bytes in keys are rejected at the SDK boundary", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    try {
      await files.download("foo\0bar");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).message).toMatch(/null bytes/u);
    }
  });

  test("copy validates both source and destination keys", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    try {
      await files.copy("a.txt", "");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).message).toMatch(/copy destination/u);
    }
  });

  test("exists validates the key at the SDK boundary", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    try {
      await files.exists("");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).message).toMatch(/non-empty/u);
    }
  });
});

describe("upload progress", () => {
  test("buffered body brackets the upload with a 0 and a final event", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    const events: UploadProgress[] = [];

    await files.upload("a.txt", "hello", {
      onProgress: (p) => events.push(p),
    });

    expect(events).toEqual([
      { loaded: 0, total: 5 },
      { loaded: 5, total: 5 },
    ]);
  });

  test("stream body reports byte-level progress as it's consumed", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    const events: UploadProgress[] = [];

    await files.upload(
      "s.bin",
      streamOf([
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5]),
        new Uint8Array([6]),
      ]),
      { onProgress: (p) => events.push(p) }
    );

    // Cumulative loaded after each chunk; total is unknown for a stream.
    expect(events.map((e) => e.loaded)).toEqual([3, 5, 6]);
    expect(events.every((e) => e.total === undefined)).toBe(true);
  });

  test("the wrapped stream still uploads the original bytes", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("s.bin", streamOf([new Uint8Array([1, 2, 3, 4])]), {
      onProgress: () => {
        // no-op
      },
    });
    const got = await files.download("s.bin");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
  });

  test("no progress events fire without an onProgress callback", async () => {
    // A throwing reporter would surface if the wrapper called it unbidden.
    const adapter: Adapter = {
      ...fakeAdapter(),
    };
    const files = new Files({ adapter });
    const result = await files.upload("a.txt", "hello");
    expect(result.size).toBe(5);
  });

  test("defers entirely to a self-reporting adapter", async () => {
    const base = fakeAdapter();
    const adapter: Adapter = {
      ...base,
      reportsUploadProgress: true,
      upload(key, body, opts) {
        opts?.onProgress?.({ loaded: 10, total: 20 });
        opts?.onProgress?.({ loaded: 20, total: 20 });
        return base.upload(key, body, opts);
      },
    };
    const files = new Files({ adapter });
    const events: UploadProgress[] = [];

    await files.upload("x.bin", "hello", {
      onProgress: (p) => events.push(p),
    });

    // No 0/total bracketing from the wrapper — the adapter owns the reports.
    expect(events).toEqual([
      { loaded: 10, total: 20 },
      { loaded: 20, total: 20 },
    ]);
  });

  test("buffered ArrayBuffer / Uint8Array / Blob bodies surface their byte length as total", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    const seen: Record<string, UploadProgress[]> = { ab: [], blob: [], u8: [] };

    await files.upload("ab", new ArrayBuffer(4), {
      onProgress: (p) => seen.ab?.push(p),
    });
    await files.upload("u8", new Uint8Array([1, 2, 3]), {
      onProgress: (p) => seen.u8?.push(p),
    });
    await files.upload("blob", new Blob(["hello"]), {
      onProgress: (p) => seen.blob?.push(p),
    });

    expect(seen.ab).toEqual([
      { loaded: 0, total: 4 },
      { loaded: 4, total: 4 },
    ]);
    expect(seen.u8).toEqual([
      { loaded: 0, total: 3 },
      { loaded: 3, total: 3 },
    ]);
    expect(seen.blob).toEqual([
      { loaded: 0, total: 5 },
      { loaded: 5, total: 5 },
    ]);
  });

  test("a throwing onProgress neither fails the upload nor retries it", async () => {
    const base = fakeAdapter();
    let uploads = 0;
    const adapter: Adapter = {
      ...base,
      upload(key, body, opts) {
        uploads += 1;
        return base.upload(key, body, opts);
      },
    };
    const files = new Files({ adapter });

    // With retries configured, a post-upload `onProgress` throw treated as a
    // provider error would re-run the attempt — re-uploading the body — and
    // ultimately reject. It must do neither: progress is fire-and-forget.
    const result = await files.upload("a.txt", "hello", {
      onProgress: () => {
        throw new Error("reporter boom");
      },
      retries: 3,
    });

    expect(result.size).toBe(5);
    expect(uploads).toBe(1);
    expect(base.has("a.txt")).toBe(true);
  });

  test("a throwing onProgress does not error a streaming upload", async () => {
    const files = new Files({ adapter: fakeAdapter() });

    await files.upload("s.bin", streamOf([new Uint8Array([1, 2, 3, 4])]), {
      onProgress: () => {
        throw new Error("reporter boom");
      },
    });

    const got = await files.download("s.bin");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
  });

  test("countingStream cancel propagates to the source reader", async () => {
    let cancelledWith: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelledWith = reason;
      },
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const counted = countingStream(source, () => {
      // ignore progress
    });
    const reader = counted.getReader();
    await reader.read();
    await reader.cancel("stop");
    expect(cancelledWith).toBe("stop");
  });

  test("bulk upload tags each item's progress with its key", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    const events: (UploadProgress & { key: string })[] = [];

    await files.upload(
      [
        { body: "aa", key: "a.txt" },
        { body: "bbbb", key: "b.txt" },
      ],
      { onProgress: (p) => events.push(p) }
    );

    expect(events.filter((e) => e.key === "a.txt")).toEqual([
      { key: "a.txt", loaded: 0, total: 2 },
      { key: "a.txt", loaded: 2, total: 2 },
    ]);
    expect(events.filter((e) => e.key === "b.txt")).toEqual([
      { key: "b.txt", loaded: 0, total: 4 },
      { key: "b.txt", loaded: 4, total: 4 },
    ]);
  });
});

const searchCollect = async (
  gen: AsyncGenerator<{ key: string }, void>
): Promise<string[]> => {
  const keys: string[] = [];
  for await (const file of gen) {
    keys.push(file.key);
  }
  return keys;
};

const searchSeed = async (files: Files, keys: string[]): Promise<void> => {
  for (const key of keys) {
    await files.upload(key, key);
  }
};

// A fakeAdapter whose `list` records the prefix it's called with, so tests can
// assert prefix push-down (or its absence).
const listSpy = (): {
  adapter: ReturnType<typeof fakeAdapter>;
  prefixes: (string | undefined)[];
} => {
  const adapter = fakeAdapter();
  const prefixes: (string | undefined)[] = [];
  const baseList = adapter.list.bind(adapter);
  adapter.list = (opts) => {
    prefixes.push(opts?.prefix);
    return baseList(opts);
  };
  return { adapter, prefixes };
};

describe("Files.search", () => {
  test("glob is the default and matches whole keys within a segment", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, ["a/1.txt", "a/2.log", "a/deep/3.txt", "b/4.txt"]);
    // `*` does not cross `/`, so the nested a/deep/3.txt is excluded.
    expect(await searchCollect(files.search("a/*.txt"))).toEqual(["a/1.txt"]);
  });

  test("`**` spans path segments at any depth", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, ["docs/x.pdf", "docs/2024/q1.pdf", "img/y.png"]);
    const keys = await searchCollect(files.search("docs/**/*.pdf"));
    expect(keys.toSorted()).toEqual(["docs/2024/q1.pdf", "docs/x.pdf"]);
  });

  test("walks across pages when the page size is below the match count", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, [
      "p/1.txt",
      "p/2.txt",
      "p/3.txt",
      "p/4.txt",
      "q/5.txt",
    ]);
    const keys = await searchCollect(files.search("p/*.txt", { limit: 2 }));
    expect(keys.toSorted()).toEqual([
      "p/1.txt",
      "p/2.txt",
      "p/3.txt",
      "p/4.txt",
    ]);
  });

  test("pushes a glob's literal prefix down to the underlying list", async () => {
    const { adapter, prefixes } = listSpy();
    const files = new Files({ adapter });
    await searchSeed(files, [
      "uploads/2024/a.pdf",
      "uploads/2023/b.pdf",
      "other/c.pdf",
    ]);

    expect(await searchCollect(files.search("uploads/2024/*.pdf"))).toEqual([
      "uploads/2024/a.pdf",
    ]);
    expect(prefixes).toEqual(["uploads/2024"]);
  });

  test("a leading-wildcard glob pushes down no prefix", async () => {
    const { adapter, prefixes } = listSpy();
    const files = new Files({ adapter });
    await searchSeed(files, ["a/x.txt", "b/y.txt"]);

    const keys = await searchCollect(files.search("**/*.txt"));
    expect(keys.toSorted()).toEqual(["a/x.txt", "b/y.txt"]);
    expect(prefixes).toEqual([undefined]);
  });

  test("match: regex tests the key, and an explicit prefix bounds the walk", async () => {
    const { adapter, prefixes } = listSpy();
    const files = new Files({ adapter });
    await searchSeed(files, [
      "logs/error.log",
      "logs/info.log",
      "data/error.log",
    ]);

    expect(
      await searchCollect(
        files.search("error\\.log$", { match: "regex", prefix: "logs/" })
      )
    ).toEqual(["logs/error.log"]);
    expect(prefixes).toEqual(["logs/"]);
  });

  test("a RegExp instance matches by regex", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, ["a.txt", "b.png", "c.txt"]);
    const keys = await searchCollect(files.search(/\.txt$/u));
    expect(keys.toSorted()).toEqual(["a.txt", "c.txt"]);
  });

  test("caseInsensitive recompiles a RegExp that lacks the i flag", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, ["Photo.JPG", "note.txt"]);
    expect(
      await searchCollect(
        files.search(/photo\.jpg/u, { caseInsensitive: true })
      )
    ).toEqual(["Photo.JPG"]);
  });

  test("caseInsensitive leaves an already-i RegExp untouched", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, ["Photo.JPG"]);
    expect(
      await searchCollect(
        files.search(/photo\.jpg/iu, { caseInsensitive: true })
      )
    ).toEqual(["Photo.JPG"]);
  });

  test("an invalid regex pattern throws before walking", async () => {
    const { adapter, prefixes } = listSpy();
    const files = new Files({ adapter });
    await searchSeed(files, ["a.txt"]);

    await expect(files.search("(", { match: "regex" }).next()).rejects.toThrow(
      FilesError
    );
    // It rejected before any list call.
    expect(prefixes).toEqual([]);
  });

  test("an unsafe regex pattern throws before walking", async () => {
    const { adapter, prefixes } = listSpy();
    const files = new Files({ adapter });
    await searchSeed(files, ["a.txt"]);

    // The classic catastrophic-backtracking pattern, "(a+)+$". Assembled at
    // runtime so static scanners don't flag a regex the SDK exists to reject
    // before it can ever run.
    const unsafePattern = ["(a+)", "+$"].join("");
    await expect(
      files.search(unsafePattern, { match: "regex" }).next()
    ).rejects.toThrow(/too complex/u);
    expect(prefixes).toEqual([]);
  });

  test("match: substring matches anywhere in the key", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, ["q1-report-final.pdf", "summary.txt"]);
    expect(
      await searchCollect(files.search("report", { match: "substring" }))
    ).toEqual(["q1-report-final.pdf"]);
  });

  test("match: substring honors caseInsensitive", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, ["q1-REPORT.pdf", "summary.txt"]);
    expect(
      await searchCollect(
        files.search("report", { caseInsensitive: true, match: "substring" })
      )
    ).toEqual(["q1-REPORT.pdf"]);
  });

  test("match: exact requires the whole key to match", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, ["a/1.txt", "a/1.txt.bak"]);
    expect(
      await searchCollect(files.search("a/1.txt", { match: "exact" }))
    ).toEqual(["a/1.txt"]);
  });

  test("match: exact honors caseInsensitive", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, ["A/One.TXT", "A/Two.txt"]);
    expect(
      await searchCollect(
        files.search("a/one.txt", { caseInsensitive: true, match: "exact" })
      )
    ).toEqual(["A/One.TXT"]);
  });

  test("maxResults caps matches and stops paging early", async () => {
    const { adapter, prefixes } = listSpy();
    const files = new Files({ adapter });
    await searchSeed(files, [
      "m/1.txt",
      "m/2.txt",
      "m/3.txt",
      "m/4.txt",
      "m/5.txt",
    ]);

    const hits = await searchCollect(
      files.search("m/*.txt", { limit: 1, maxResults: 2 })
    );
    expect(hits).toHaveLength(2);
    // One page per match, then it returns — no further pages are fetched.
    expect(prefixes).toHaveLength(2);
  });

  test("maxResults of 0 yields nothing", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, ["a.txt", "b.txt"]);
    expect(
      await searchCollect(files.search("*.txt", { maxResults: 0 }))
    ).toEqual([]);
  });

  test("no matches yields an empty result", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await searchSeed(files, ["a.txt", "b.txt"]);
    expect(await searchCollect(files.search("zzz*"))).toEqual([]);
  });

  test("caseInsensitive glob disables prefix push-down", async () => {
    const { adapter, prefixes } = listSpy();
    const files = new Files({ adapter });
    await searchSeed(files, ["Uploads/a.pdf", "uploads/b.pdf"]);

    // A case-sensitive provider prefix would miss the lowercased key, so the
    // glob head is not pushed down; both keys are walked and matched.
    const keys = await searchCollect(
      files.search("Uploads/*.pdf", { caseInsensitive: true })
    );
    expect(keys.toSorted()).toEqual(["Uploads/a.pdf", "uploads/b.pdf"]);
    expect(prefixes).toEqual([undefined]);
  });

  test("matches the caller-facing key under a constructor prefix", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "tenant" });
    await files.upload("avatars/1.png", "one");
    await files.upload("avatars/2.png", "two");
    await files.upload("docs/notes.txt", "doc");

    const keys = await searchCollect(files.search("avatars/*.png"));
    expect(keys.toSorted()).toEqual(["avatars/1.png", "avatars/2.png"]);
  });
});
