import { describe, expect, test } from "bun:test";

import type { ListOptions } from "../src/index.js";
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

  test("constructor prefix round-trips upload, head, download, and exists keys", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "/users" });

    const uploaded = await files.upload("/123", "avatar");
    expect(uploaded.key).toBe("/123");
    expect(adapter.has("/users/123")).toBe(true);

    const head = await files.head(uploaded.key);
    expect(head.key).toBe("/123");
    expect(await files.exists(uploaded.key)).toBe(true);

    const downloaded = await files.download(uploaded.key);
    expect(downloaded.key).toBe("/123");
    expect(await downloaded.text()).toBe("avatar");
  });

  test("constructor prefix keeps file handle keys consistent", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "/users" });
    const avatar = files.file("/123");

    expect(avatar.key).toBe("/123");
    await avatar.upload("avatar");
    const head = await avatar.head();
    const downloaded = await avatar.download();
    expect(head.key).toBe("/123");
    expect(downloaded.key).toBe("/123");
  });

  test("constructor prefix lets listed keys round-trip into delete", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "/users" });

    await files.upload("/123", "one");
    await files.upload("/456", "two");

    const { items } = await files.list();
    expect(items.map((item) => item.key).toSorted()).toEqual(["/123", "/456"]);

    const [firstItem] = items;
    if (!firstItem) {
      throw new Error("expected a listed item");
    }

    await files.delete(firstItem.key);
    expect(adapter.has("/users/123")).toBe(false);
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
    const files = new Files({ adapter, prefix: "/users" });

    await files.upload("/avatars/1.png", "one");
    await files.upload("/avatars/2.png", "two");
    await files.upload("/docs/1.txt", "doc");

    const first = await files.list({ limit: 1, prefix: "/avatars" });
    expect(seenPrefix).toBe("/users/avatars");
    expect(first.items.map((item) => item.key)).toEqual(["/avatars/1.png"]);

    const second = await files.list({
      cursor: first.cursor,
      limit: 1,
      prefix: "/avatars",
    });
    expect(second.items.map((item) => item.key)).toEqual(["/avatars/2.png"]);
  });

  test("constructor prefix list without explicit prefix does not match sibling paths", async () => {
    const adapter = fakeAdapter();
    await adapter.upload("/users/123", "user");
    await adapter.upload("/users-archive/123", "archive");
    const files = new Files({ adapter, prefix: "/users" });

    const { items } = await files.list();
    expect(items.map((item) => item.key)).toEqual(["/123"]);
  });

  test("constructor prefix applies to urls, signed uploads, copy, and handle helpers", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, prefix: "/users" });
    const avatar = files.file("/123");

    await avatar.upload("avatar");
    const url = await avatar.url({ expiresIn: 60 });
    expect(url).toContain(encodeURIComponent("/users/123"));

    await avatar.copyTo("/456");
    const copied = await files.download("/456");
    expect(await copied.text()).toBe("avatar");

    const mirror = files.file("/789");
    await mirror.copyFrom("/456");
    const mirrored = await mirror.download();
    expect(await mirrored.text()).toBe("avatar");

    const signed = await files.signedUploadUrl("/999", { expiresIn: 60 });
    expect(signed.url).toContain(encodeURIComponent("/users/999"));

    await avatar.delete();
    expect(adapter.has("/users/123")).toBe(false);
  });

  test("constructor prefix validation rejects non-string, empty-after-trim, and null bytes", () => {
    expect(
      () => new Files({ adapter: fakeAdapter(), prefix: 123 as never })
    ).toThrow(/prefix must be a non-empty string/u);
    expect(() => new Files({ adapter: fakeAdapter(), prefix: "///" })).toThrow(
      /prefix must be a non-empty string/u
    );
    expect(
      () => new Files({ adapter: fakeAdapter(), prefix: "users\0bad" })
    ).toThrow(/prefix must not contain null bytes/u);
  });

  test("constructor prefix only strips exact path prefixes from adapter keys", async () => {
    const base = fakeAdapter();
    await base.upload("/users/123", "avatar");
    const files = new Files({
      adapter: {
        ...base,
        async head(key) {
          const file = await base.head(key);
          return { ...file, key: "/users-archive/123" };
        },
      },
      prefix: "/users",
    });

    const head = await files.head("/123");
    expect(head.key).toBe("/users-archive/123");
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
