import { describe, expect, test } from "bun:test";

import { createFiles } from "../src/index.js";
import type { Adapter, Files, ListOptions, ListResult } from "../src/index.js";
import { softDelete } from "../src/soft-delete/index.js";
import type { SoftDeleteOptions } from "../src/soft-delete/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const withSoftDelete = (
  options: SoftDeleteOptions = {},
  adapter: Adapter = fakeAdapter()
) => createFiles({ adapter, plugins: [softDelete(options)] });

const bodyOf = (files: Files, key: string): Promise<string> =>
  files.download(key).then((file) => file.text());

// An adapter that returns at most one item per list page, to exercise the
// cursor loop in trashed() / purge() and the list-hiding cursor spread without
// seeding 1000+ objects.
const pagedAdapter = (): Adapter => {
  const inner = fakeAdapter();
  return {
    ...inner,
    list(opts?: ListOptions): Promise<ListResult> {
      return inner.list({ ...opts, limit: 1 });
    },
  };
};

describe("soft-delete plugin — delete moves to trash", () => {
  test("relocates the object instead of destroying it", async () => {
    const files = withSoftDelete();
    await files.upload("notes.txt", "hi");
    await files.delete("notes.txt");

    expect(await files.exists("notes.txt")).toBe(false);
    expect(await files.exists(".trash/notes.txt")).toBe(true);
    expect(await bodyOf(files, ".trash/notes.txt")).toBe("hi");
  });

  test("deleting a missing key is a no-op, like a plain delete", async () => {
    const files = withSoftDelete();
    await expect(files.delete("ghost.txt")).resolves.toBeUndefined();
    expect(await files.trashed()).toEqual([]);
  });

  test("re-deleting a key replaces its trashed copy (latest wins)", async () => {
    const files = withSoftDelete();
    await files.upload("k.txt", "first");
    await files.delete("k.txt");
    await files.upload("k.txt", "second");
    await files.delete("k.txt");

    const trashed = await files.trashed();
    expect(trashed).toHaveLength(1);
    expect(await bodyOf(files, ".trash/k.txt")).toBe("second");
  });

  test("a delete of a trash key is a real delete", async () => {
    const files = withSoftDelete();
    await files.upload("a.txt", "x");
    // Soft-deletes to .trash/a.txt, then hard-deletes inside the trash.
    await files.delete("a.txt");
    await files.delete(".trash/a.txt");

    expect(await files.exists(".trash/a.txt")).toBe(false);
    expect(await files.trashed()).toEqual([]);
  });

  test("a delete of the trash root itself passes through", async () => {
    const files = withSoftDelete();
    // Exercises the `key === trashDir` exact-match guard.
    await expect(files.delete(".trash")).resolves.toBeUndefined();
  });
});

describe("soft-delete plugin — restore", () => {
  test("brings a deleted object back to its original key", async () => {
    const files = withSoftDelete();
    await files.upload("notes.txt", "hi");
    await files.delete("notes.txt");

    const restored = await files.restore("notes.txt");
    expect(restored.key).toBe("notes.txt");
    expect(await bodyOf(files, "notes.txt")).toBe("hi");
    // Restoring removes it from the trash.
    expect(await files.exists(".trash/notes.txt")).toBe(false);
  });

  test("overwrites a live key re-created after the delete", async () => {
    const files = withSoftDelete();
    await files.upload("k.txt", "old");
    await files.delete("k.txt");
    await files.upload("k.txt", "new");

    await files.restore("k.txt");
    expect(await bodyOf(files, "k.txt")).toBe("old");
  });

  test("throws when nothing is trashed for the key", async () => {
    const files = withSoftDelete();
    await expect(files.restore("never.txt")).rejects.toThrow(
      /nothing trashed for "never\.txt"/u
    );
  });
});

describe("soft-delete plugin — purge", () => {
  test("permanently deletes one trashed object", async () => {
    const files = withSoftDelete();
    await files.upload("a.txt", "x");
    await files.delete("a.txt");

    await files.purge("a.txt");
    expect(await files.exists(".trash/a.txt")).toBe(false);
    expect(await files.trashed()).toEqual([]);
  });

  test("purging a key with nothing trashed is a no-op", async () => {
    const files = withSoftDelete();
    await expect(files.purge("ghost.txt")).resolves.toBeUndefined();
  });

  test("empties the entire trash when no key is given", async () => {
    const files = withSoftDelete();
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    await files.delete("a.txt");
    await files.delete("b.txt");
    expect(await files.trashed()).toHaveLength(2);

    await files.purge();
    expect(await files.trashed()).toEqual([]);
  });

  test("emptying an already-empty trash is a no-op", async () => {
    const files = withSoftDelete();
    await expect(files.purge()).resolves.toBeUndefined();
  });
});

describe("soft-delete plugin — trashed() metadata", () => {
  test("reports key, trashKey, size, lastModified, and etag", async () => {
    const files = withSoftDelete();
    await files.upload("docs/report.txt", "abcd");
    await files.delete("docs/report.txt");

    const [item] = await files.trashed();
    expect(item).toBeDefined();
    expect(item?.key).toBe("docs/report.txt");
    expect(item?.trashKey).toBe(".trash/docs/report.txt");
    expect(item?.size).toBe(4);
    expect(item?.lastModified).toBeGreaterThan(0);
    expect(item?.etag).toBeDefined();
  });

  test("pages through the whole trash", async () => {
    const files = createFiles({
      adapter: pagedAdapter(),
      plugins: [softDelete()],
    });
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    await files.delete("a.txt");
    await files.delete("b.txt");

    expect(await files.trashed()).toHaveLength(2);
  });
});

describe("soft-delete plugin — list hiding", () => {
  test("hides trashed objects from a normal list", async () => {
    const files = withSoftDelete();
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    await files.delete("a.txt");

    const { items } = await files.list();
    expect(items.map((f) => f.key)).toEqual(["b.txt"]);
  });

  test("shows trashed objects when listing within the trash prefix", async () => {
    const files = withSoftDelete();
    await files.upload("a.txt", "1");
    await files.delete("a.txt");

    const { items } = await files.list({ prefix: ".trash" });
    expect(items.map((f) => f.key)).toEqual([".trash/a.txt"]);
  });

  test("leaves a trash-free list untouched", async () => {
    const files = withSoftDelete();
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    const { items } = await files.list();
    expect(items.map((f) => f.key)).toEqual(["a.txt", "b.txt"]);
  });

  test("keeps the cursor when a page is filtered shorter", async () => {
    const files = createFiles({
      adapter: pagedAdapter(),
      plugins: [softDelete()],
    });
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    // .trash/a.txt sorts before b.txt, so it's the first single-item page.
    await files.delete("a.txt");

    // The single-item page is the trash object; it's filtered out, but the
    // cursor still rides along so a follow-up page reaches "b.txt".
    const first = await files.list();
    expect(first.items).toEqual([]);
    expect(first.cursor).toBeDefined();
  });

  test("strips the trash folder from delimiter prefixes", async () => {
    const files = withSoftDelete({}, fakeAdapter({ supportsDelimiter: true }));
    await files.upload("photos/x.jpg", "1");
    // Creates .trash/photos/x.jpg.
    await files.delete("photos/x.jpg");

    const result = await files.list({ delimiter: "/" });
    expect(result.prefixes ?? []).not.toContain(".trash/");
  });
});

describe("soft-delete plugin — transparency", () => {
  test("passes reads and url() straight through", async () => {
    const files = withSoftDelete();
    await files.upload("a.txt", "hello");
    expect(await bodyOf(files, "a.txt")).toBe("hello");
    expect(await files.head("a.txt")).toMatchObject({ key: "a.txt" });
    expect(await files.url("a.txt")).toContain("a.txt");
    const signed = await files.signedUploadUrl("a.txt", { expiresIn: 60 });
    expect(signed.url).toBeDefined();
  });
});

describe("soft-delete plugin — bulk delete", () => {
  test("soft-deletes every key, restorable afterwards", async () => {
    const files = withSoftDelete();
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");

    const result = await files.delete(["a.txt", "b.txt"]);
    expect(result.deleted).toEqual(["a.txt", "b.txt"]);
    expect(await files.list().then((r) => r.items)).toEqual([]);

    await files.restore("a.txt");
    expect(await bodyOf(files, "a.txt")).toBe("1");
  });
});

describe("soft-delete plugin — options", () => {
  test("honors a custom prefix", async () => {
    const files = withSoftDelete({ prefix: ".bin/" });
    await files.upload("a.txt", "1");
    await files.delete("a.txt");

    const [item] = await files.trashed();
    expect(item?.trashKey).toBe(".bin/a.txt");
    const { items } = await files.list();
    expect(items.map((f) => f.key)).toEqual([]);
  });

  test("rejects an empty prefix", () => {
    expect(() => softDelete({ prefix: "///" })).toThrow(/must not be empty/u);
  });
});

describe("soft-delete plugin — option threading", () => {
  test("the caller's signal applies to the re-routed trash move", async () => {
    const inner = fakeAdapter();
    const seen: (AbortSignal | undefined)[] = [];
    const spying: Adapter = {
      ...inner,
      copy(from, to, opts) {
        seen.push(opts?.signal);
        return inner.copy(from, to, opts);
      },
    };
    const files = createFiles({ adapter: spying, plugins: [softDelete()] });
    await files.upload("a.txt", "x");
    const controller = new AbortController();
    // The re-routed move IS the user's delete — its signal must reach the
    // adapter (via the move's copy step).
    await files.delete("a.txt", { signal: controller.signal });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeDefined();
  });
});

describe("soft-delete plugin — error propagation", () => {
  test("surfaces a non-NotFound error from the trash move", async () => {
    const inner = fakeAdapter();
    const broken: Adapter = {
      ...inner,
      copy() {
        return Promise.reject(new Error("boom"));
      },
    };
    const files = createFiles({ adapter: broken, plugins: [softDelete()] });
    await files.upload("a.txt", "x");
    await expect(files.delete("a.txt")).rejects.toThrow(/boom/u);
  });
});
