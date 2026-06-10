import { describe, expect, test } from "bun:test";

import { createFiles } from "../src/index.js";
import type { Adapter, Files, ListOptions, ListResult } from "../src/index.js";
import { versioning } from "../src/versioning/index.js";
import type { VersioningOptions } from "../src/versioning/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const withVersioning = (
  options: VersioningOptions = {},
  adapter: Adapter = fakeAdapter()
) => createFiles({ adapter, plugins: [versioning(options)] });

const bodyOf = (files: Files, key: string): Promise<string> =>
  files.download(key).then((file) => file.text());

// An adapter that returns at most one item per list page, to exercise the
// cursor loop in versions() without seeding 1000+ snapshots.
const pagedAdapter = (): Adapter => {
  const inner = fakeAdapter();
  return {
    ...inner,
    list(opts?: ListOptions): Promise<ListResult> {
      return inner.list({ ...opts, limit: 1 });
    },
  };
};

describe("versioning plugin — snapshots on overwrite", () => {
  test("snapshots the prior bytes before an overwrite", async () => {
    const files = withVersioning();
    await files.upload("notes.txt", "v1");
    await files.upload("notes.txt", "v2");

    expect(await bodyOf(files, "notes.txt")).toBe("v2");
    const versions = await files.versions("notes.txt");
    expect(versions).toHaveLength(1);
    const [previous] = versions;
    expect(previous).toBeDefined();
    expect(await bodyOf(files, previous?.key ?? "")).toBe("v1");
  });

  test("the first write has nothing to snapshot", async () => {
    const files = withVersioning();
    await files.upload("a.txt", "only");
    expect(await files.versions("a.txt")).toEqual([]);
  });

  test("keeps one version per overwrite, newest first", async () => {
    const files = withVersioning();
    await files.upload("k", "1");
    await files.upload("k", "2");
    await files.upload("k", "3");

    const versions = await files.versions("k");
    expect(versions).toHaveLength(2);
    const bodies = await Promise.all(versions.map((v) => bodyOf(files, v.key)));
    // Newest snapshot first: "2" was saved when "3" was written.
    expect(bodies).toEqual(["2", "1"]);
  });
});

describe("versioning plugin — snapshots on delete, copy, move", () => {
  test("snapshots before a delete so it can be restored", async () => {
    const files = withVersioning();
    await files.upload("gone.txt", "bye");
    await files.delete("gone.txt");

    expect(await files.exists("gone.txt")).toBe(false);
    await files.restore("gone.txt");
    expect(await bodyOf(files, "gone.txt")).toBe("bye");
  });

  test("snapshots the destination of a copy before it is clobbered", async () => {
    const files = withVersioning();
    await files.upload("src.txt", "fresh");
    await files.upload("dst.txt", "old-dst");
    await files.copy("src.txt", "dst.txt");

    expect(await bodyOf(files, "dst.txt")).toBe("fresh");
    const versions = await files.versions("dst.txt");
    expect(versions).toHaveLength(1);
  });

  test("a copy to a brand-new key snapshots nothing", async () => {
    const files = withVersioning();
    await files.upload("src.txt", "x");
    await files.copy("src.txt", "new-dst.txt");
    expect(await files.versions("new-dst.txt")).toEqual([]);
  });

  test("snapshots the destination of a move, not the source", async () => {
    const files = withVersioning();
    await files.upload("from.txt", "moving");
    await files.upload("to.txt", "old-to");
    await files.move("from.txt", "to.txt");

    expect(await bodyOf(files, "to.txt")).toBe("moving");
    expect(await files.exists("from.txt")).toBe(false);
    expect(await files.versions("to.txt")).toHaveLength(1);
    // The source relocated rather than being destroyed, so it isn't versioned.
    expect(await files.versions("from.txt")).toEqual([]);
  });
});

describe("versioning plugin — restore", () => {
  test("restores the newest version when no id is given", async () => {
    const files = withVersioning();
    await files.upload("doc", "one");
    await files.upload("doc", "two");

    const restored = await files.restore("doc");
    expect(restored.key).toBe("doc");
    expect(await bodyOf(files, "doc")).toBe("one");
  });

  test("restores a specific version by id", async () => {
    const files = withVersioning();
    await files.upload("doc", "one");
    await files.upload("doc", "two");
    // Versions now hold snapshots of "one" and "two".
    await files.upload("doc", "three");

    const versions = await files.versions("doc");
    const oldest = versions.at(-1);
    expect(oldest).toBeDefined();
    await files.restore("doc", oldest?.versionId);
    expect(await bodyOf(files, "doc")).toBe("one");
  });

  test("snapshots the current bytes first, so a restore is reversible", async () => {
    const files = withVersioning();
    await files.upload("doc", "one");
    // Live is "two" with one version ("one").
    await files.upload("doc", "two");

    // Live becomes "one"; "two" gets snapshotted on the way.
    await files.restore("doc");
    expect(await bodyOf(files, "doc")).toBe("one");

    const versions = await files.versions("doc");
    const bodies = await Promise.all(versions.map((v) => bodyOf(files, v.key)));
    expect(bodies).toContain("two");
  });

  test("throws when the key has no versions", async () => {
    const files = withVersioning();
    await expect(files.restore("never.txt")).rejects.toThrow(
      /no versions to restore for "never\.txt"/u
    );
  });

  test("throws when the given version id does not exist", async () => {
    const files = withVersioning();
    await files.upload("doc", "one");
    await files.upload("doc", "two");
    await expect(files.restore("doc", "nope")).rejects.toThrow(
      /no version "nope" for "doc"/u
    );
  });
});

describe("versioning plugin — versions() metadata", () => {
  test("reports id, key, size, lastModified, and etag", async () => {
    const files = withVersioning();
    await files.upload("m.txt", "abcd");
    await files.upload("m.txt", "ef");

    const [version] = await files.versions("m.txt");
    expect(version).toBeDefined();
    expect(version?.key).toBe(`.versions/m.txt/${version?.versionId}`);
    // The snapshotted "abcd".
    expect(version?.size).toBe(4);
    expect(version?.etag).toBeDefined();
    expect(version?.lastModified).toBeGreaterThan(0);
    const padded = String(version?.lastModified).padStart(16, "0");
    // The id encodes the source object's last-modified time.
    expect(version?.versionId.startsWith(padded)).toBe(true);
  });
});

describe("versioning plugin — list hiding", () => {
  test("hides version objects from a normal list", async () => {
    const files = withVersioning();
    await files.upload("a.txt", "1");
    // The overwrite creates a .versions/ object.
    await files.upload("a.txt", "2");

    const { items } = await files.list();
    expect(items.map((f) => f.key)).toEqual(["a.txt"]);
  });

  test("shows version objects when listing within the version prefix", async () => {
    const files = withVersioning();
    await files.upload("a.txt", "1");
    await files.upload("a.txt", "2");

    const { items } = await files.list({ prefix: ".versions" });
    expect(items).toHaveLength(1);
    expect(items[0]?.key.startsWith(".versions/a.txt/")).toBe(true);
  });

  test("leaves a version-free list untouched", async () => {
    const files = withVersioning();
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    const { items } = await files.list();
    expect(items.map((f) => f.key)).toEqual(["a.txt", "b.txt"]);
  });

  test("strips the version folder from delimiter prefixes", async () => {
    const files = withVersioning({}, fakeAdapter({ supportsDelimiter: true }));
    await files.upload("photos/x.jpg", "1");
    // .versions/photos/... is created.
    await files.upload("photos/x.jpg", "2");

    const result = await files.list({ delimiter: "/" });
    expect(result.prefixes ?? []).toEqual(["photos/"]);
    expect(result.prefixes ?? []).not.toContain(".versions/");
  });
});

describe("versioning plugin — version store is inert", () => {
  test("does not version writes that target the version prefix", async () => {
    const files = withVersioning();
    await files.upload(".versions/manual", "x");
    // An overwrite, but inside the store, so it isn't itself versioned.
    await files.upload(".versions/manual", "y");

    const { items } = await files.list({ prefix: ".versions/manual" });
    expect(items.map((f) => f.key)).toEqual([".versions/manual"]);
  });

  test("passes reads and url() straight through", async () => {
    const files = withVersioning();
    await files.upload("a.txt", "hello");
    expect(await bodyOf(files, "a.txt")).toBe("hello");
    expect(await files.head("a.txt")).toMatchObject({ key: "a.txt" });
    expect(await files.url("a.txt")).toContain("a.txt");
    const signed = await files.signedUploadUrl("a.txt", { expiresIn: 60 });
    expect(signed.url).toBeDefined();
  });
});

describe("versioning plugin — limit", () => {
  test("prunes the oldest versions beyond the limit", async () => {
    const files = withVersioning({ limit: 2 });
    for (const value of ["1", "2", "3", "4", "5"]) {
      await files.upload("k", value);
    }
    const versions = await files.versions("k");
    expect(versions).toHaveLength(2);
    const bodies = await Promise.all(versions.map((v) => bodyOf(files, v.key)));
    // The two newest snapshots: "4" (saved writing "5") and "3".
    expect(bodies).toEqual(["4", "3"]);
  });

  test("keeps everything when under the limit", async () => {
    const files = withVersioning({ limit: 10 });
    await files.upload("k", "1");
    await files.upload("k", "2");
    expect(await files.versions("k")).toHaveLength(1);
  });

  test("rejects a non-positive limit", () => {
    expect(() => versioning({ limit: 0 })).toThrow(/positive integer/u);
    expect(() => versioning({ limit: 1.5 })).toThrow(/positive integer/u);
  });
});

describe("versioning plugin — options", () => {
  test("honors a custom prefix", async () => {
    const files = withVersioning({ prefix: "history/" });
    await files.upload("a.txt", "1");
    await files.upload("a.txt", "2");

    const [version] = await files.versions("a.txt");
    expect(version?.key.startsWith("history/a.txt/")).toBe(true);
    const { items } = await files.list();
    expect(items.map((f) => f.key)).toEqual(["a.txt"]);
  });

  test("rejects an empty prefix", () => {
    expect(() => versioning({ prefix: "///" })).toThrow(/must not be empty/u);
  });
});

describe("versioning plugin — paginated history", () => {
  test("pages through every version", async () => {
    const files = createFiles({
      adapter: pagedAdapter(),
      plugins: [versioning()],
    });
    await files.upload("k", "1");
    await files.upload("k", "2");
    // Two snapshots, returned one page at a time.
    await files.upload("k", "3");

    const versions = await files.versions("k");
    expect(versions).toHaveLength(2);
  });

  test("prune sees past the first list page", async () => {
    // One-item pages: a single-page prune would count at most one version
    // and never enforce the limit.
    const files = createFiles({
      adapter: pagedAdapter(),
      plugins: [versioning({ limit: 2 })],
    });
    for (const value of ["1", "2", "3", "4", "5"]) {
      await files.upload("k", value);
    }
    const versions = await files.versions("k");
    expect(versions).toHaveLength(2);
    const bodies = await Promise.all(versions.map((v) => bodyOf(files, v.key)));
    expect(bodies).toEqual(["4", "3"]);
  });
});

describe("versioning plugin — bulk operations", () => {
  test("snapshots before a bulk-upload overwrite", async () => {
    // The snapshot re-routes to `head` + `copy` via `next`; this exercises that
    // a cross-kind sub-op works inside a bulk upload, not just a single one.
    const files = withVersioning();
    await files.upload("a.txt", "v1");
    const result = await files.upload([{ body: "v2", key: "a.txt" }]);

    expect(result.uploaded).toHaveLength(1);
    expect(await bodyOf(files, "a.txt")).toBe("v2");
    const versions = await files.versions("a.txt");
    expect(versions).toHaveLength(1);
    expect(await bodyOf(files, versions[0]?.key ?? "")).toBe("v1");
  });

  test("snapshots before a bulk delete so it can be restored", async () => {
    const files = withVersioning();
    await files.upload("gone.txt", "bye");
    const result = await files.delete(["gone.txt"]);

    expect(result.deleted).toEqual(["gone.txt"]);
    expect(await files.exists("gone.txt")).toBe(false);
    await files.restore("gone.txt");
    expect(await bodyOf(files, "gone.txt")).toBe("bye");
  });
});

describe("versioning plugin — nested keys", () => {
  test("versions() of a key excludes a nested key's snapshots", async () => {
    const files = withVersioning();
    await files.upload("a", "a-v1");
    await files.upload("a", "a-v2");
    await files.upload("a/b", "ab-v1");
    await files.upload("a/b", "ab-v2");

    const ofA = await files.versions("a");
    expect(ofA).toHaveLength(1);
    expect(await bodyOf(files, ofA[0]?.key ?? "")).toBe("a-v1");
    const ofAb = await files.versions("a/b");
    expect(ofAb).toHaveLength(1);
    expect(await bodyOf(files, ofAb[0]?.key ?? "")).toBe("ab-v1");
  });

  test("restore() of a key never picks up a nested key's snapshot", async () => {
    const files = withVersioning();
    await files.upload("a", "a-v1");
    await files.upload("a", "a-v2");
    // Snapshotted *after* a's versions, so its id would sort newest if it
    // leaked into a's history.
    await files.upload("a/b", "ab-v1");
    await files.upload("a/b", "ab-v2");

    await files.restore("a");
    expect(await bodyOf(files, "a")).toBe("a-v1");
  });

  test("rejects a versionId containing a slash", async () => {
    const files = withVersioning();
    await files.upload("a", "a-v1");
    await files.upload("a", "a-v2");
    await files.upload("a/b", "ab-v1");
    await files.upload("a/b", "ab-v2");

    const [nested] = await files.versions("a/b");
    await expect(files.restore("a", `b/${nested?.versionId}`)).rejects.toThrow(
      /version ids never contain/u
    );
  });

  test("pruning a key leaves a nested key's snapshots alone", async () => {
    const files = withVersioning({ limit: 1 });
    // a/b accrues two snapshots first, so they'd be counted (and the parent's
    // own snapshot pruned) if the nested dir leaked into a's listing.
    for (const value of ["1", "2", "3"]) {
      await files.upload("a/b", value);
    }
    await files.upload("a", "a-v1");
    await files.upload("a", "a-v2");

    const ofA = await files.versions("a");
    expect(ofA).toHaveLength(1);
    expect(await bodyOf(files, ofA[0]?.key ?? "")).toBe("a-v1");
    // a/b's own history is intact (limit applies per key: newest survivor).
    const ofAb = await files.versions("a/b");
    expect(ofAb).toHaveLength(1);
    expect(await bodyOf(files, ofAb[0]?.key ?? "")).toBe("2");
  });
});

describe("versioning plugin — error propagation", () => {
  test("surfaces a non-NotFound error from the snapshot head", async () => {
    const inner = fakeAdapter();
    const broken: Adapter = {
      ...inner,
      head() {
        return Promise.reject(new Error("boom"));
      },
    };
    const files = createFiles({ adapter: broken, plugins: [versioning()] });
    await expect(files.upload("a.txt", "x")).rejects.toThrow(/boom/u);
  });
});
