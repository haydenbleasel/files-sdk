import { describe, expect, test } from "bun:test";

import { Files, FilesError } from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

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

  test("list returns items filtered by prefix", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("a/1.txt", "1");
    await files.upload("a/2.txt", "2");
    await files.upload("b/3.txt", "3");
    const { items } = await files.list({ prefix: "a/" });
    expect(items.map((i) => i.key).toSorted()).toEqual(["a/1.txt", "a/2.txt"]);
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
