import { describe, expect, test } from "bun:test";

import { createFiles } from "../src/index.js";
import type { Adapter } from "../src/index.js";
import { softDelete } from "../src/soft-delete/index.js";
import { versioning } from "../src/versioning/index.js";
import type { VersioningOptions } from "../src/versioning/index.js";
import { fakeAdapter } from "./fake-adapter.js";

/** Every raw key in storage, straight from the adapter (no plugin filtering). */
const rawKeys = async (adapter: Adapter): Promise<string[]> => {
  const { items } = await adapter.list({ limit: 1000 });
  return items.map((item) => item.key).toSorted();
};

const orphans = async (adapter: Adapter): Promise<string[]> => {
  const keys = await rawKeys(adapter);
  return keys.filter((key) => key.startsWith(".versions/.trash/"));
};

const TRASH_IGNORED: VersioningOptions = { ignore: [".trash"] };

const paired = (options: VersioningOptions = TRASH_IGNORED) => {
  const adapter = fakeAdapter();
  const files = createFiles({
    adapter,
    plugins: [versioning(options), softDelete()],
  });
  return { adapter, files };
};

describe("softDelete + versioning on one instance", () => {
  test("constructs in either order — the restores no longer collide", () => {
    expect(() =>
      createFiles({
        adapter: fakeAdapter(),
        plugins: [softDelete(), versioning()],
      })
    ).not.toThrow();
    const files = createFiles({
      adapter: fakeAdapter(),
      plugins: [versioning(), softDelete()],
    });
    expect(typeof files.restoreVersion).toBe("function");
    expect(typeof files.restoreTrashed).toBe("function");
    expect(typeof files.versions).toBe("function");
    expect(typeof files.trashed).toBe("function");
    expect(typeof files.purge).toBe("function");
  });

  test("a delete is snapshotted and trashed when versioning is outermost", async () => {
    const { adapter, files } = paired();
    await files.upload("notes.txt", "v1");
    await files.upload("notes.txt", "v2");
    await files.delete("notes.txt");

    expect(adapter.has("notes.txt")).toBe(false);
    expect(adapter.has(".trash/notes.txt")).toBe(true);
    const trashed = await files.trashed();
    expect(trashed.map((t) => t.key)).toEqual(["notes.txt"]);
    // Both the overwrite ("v1") and the delete ("v2") were snapshotted.
    expect(await files.versions("notes.txt")).toHaveLength(2);
  });

  test("restoreTrashed and restoreVersion each do their own thing", async () => {
    const { files } = paired();
    await files.upload("notes.txt", "v1");
    await files.upload("notes.txt", "v2");
    await files.delete("notes.txt");

    const restored = await files.restoreTrashed("notes.txt");
    expect(restored.key).toBe("notes.txt");
    const afterTrashRestore = await files.download("notes.txt");
    expect(await afterTrashRestore.text()).toBe("v2");
    expect(await files.trashed()).toEqual([]);

    const [, oldest] = await files.versions("notes.txt");
    const rolled = await files.restoreVersion("notes.txt", oldest?.versionId);
    expect(rolled.key).toBe("notes.txt");
    const afterVersionRestore = await files.download("notes.txt");
    expect(await afterVersionRestore.text()).toBe("v1");
  });

  test("purge really frees the bytes when the trash prefix is ignored", async () => {
    const { adapter, files } = paired();
    await files.upload("a.txt", "a");
    await files.upload("b.txt", "b");
    await files.delete("a.txt");
    await files.delete("b.txt");

    await files.purge("a.txt");
    expect(adapter.has(".trash/a.txt")).toBe(false);
    expect(await orphans(adapter)).toEqual([]);

    // The whole trash, via the bulk delete.
    await files.purge();
    expect(await files.trashed()).toEqual([]);
    expect(await orphans(adapter)).toEqual([]);
    // The deletes' own snapshots are untouched — that's the history.
    expect(await files.versions("a.txt")).toHaveLength(1);
    expect(await files.versions("b.txt")).toHaveLength(1);
  });

  test("without `ignore`, a purge is itself snapshotted (why the option exists)", async () => {
    const { adapter, files } = paired({});
    await files.upload("a.txt", "a");
    await files.delete("a.txt");
    await files.purge("a.txt");

    expect(adapter.has(".trash/a.txt")).toBe(false);
    // The bytes never left storage: versioning snapshotted the trash key.
    expect(await orphans(adapter)).toHaveLength(1);
  });

  test("`ignore` prefixes are normalized like `prefix`", async () => {
    const { adapter, files } = paired({ ignore: ["/.trash/"] });
    await files.upload("a.txt", "a");
    await files.delete("a.txt");
    await files.purge("a.txt");
    expect(await orphans(adapter)).toEqual([]);

    expect(() => versioning({ ignore: ["/"] })).toThrow(
      /prefix must not be empty/u
    );
  });

  test("softDelete outermost trashes a delete but does not version it", async () => {
    const adapter = fakeAdapter();
    const files = createFiles({
      adapter,
      plugins: [softDelete(), versioning({ ignore: [".trash"] })],
    });
    await files.upload("notes.txt", "v1");
    await files.upload("notes.txt", "v2");
    await files.delete("notes.txt");

    expect(adapter.has(".trash/notes.txt")).toBe(true);
    // Versioning saw a move into the trash, not a delete — only the overwrite
    // was snapshotted. This is the documented reason to put versioning first.
    expect(await files.versions("notes.txt")).toHaveLength(1);
  });
});
