import { describe, expect, test } from "bun:test";

import { Files, FilesError, sync } from "../src/index.js";
import type { ListResult, StoredFile, SyncProgress } from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const newFiles = (): Files => new Files({ adapter: fakeAdapter() });

const textOf = async (files: Files, key: string): Promise<string> => {
  const file = await files.download(key);
  return file.text();
};

describe("sync", () => {
  test("uploads new objects, carrying content type and metadata", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "alpha", {
      contentType: "text/plain",
      metadata: { user: "1" },
    });
    // No metadata, to exercise the body-only path.
    await source.upload("b.txt", "beta");

    const result = await sync(source, dest);

    expect(result.uploaded).toEqual(["a.txt", "b.txt"]);
    expect(result.skipped).toEqual([]);
    expect(result.deleted).toBeUndefined();
    expect(result.errors).toBeUndefined();

    const a = await dest.download("a.txt");
    expect(await a.text()).toBe("alpha");
    expect(a.type).toBe("text/plain");
    expect(a.metadata).toEqual({ user: "1" });
    expect(await textOf(dest, "b.txt")).toBe("beta");
  });

  test("default etag compare skips identical objects and uploads the rest", async () => {
    const source = newFiles();
    const dest = newFiles();
    // Both stores assign the same first-upload etag, so a.txt matches on size
    // and etag and is skipped; b.txt is absent from the destination.
    await source.upload("a.txt", "alpha");
    await dest.upload("a.txt", "alpha");
    await source.upload("b.txt", "beta");

    const result = await sync(source, dest);

    expect(result.skipped).toEqual(["a.txt"]);
    expect(result.uploaded).toEqual(["b.txt"]);
    expect(await textOf(dest, "b.txt")).toBe("beta");
  });

  test("default etag compare re-uploads when etags differ at the same size", async () => {
    const source = newFiles();
    const dest = newFiles();
    // Advance the destination's etag counter so a.txt gets a different etag
    // than the source's, despite identical byte length.
    await dest.upload("filler", "x");
    await dest.upload("a.txt", "OLD!!");
    await source.upload("a.txt", "alpha");

    const result = await sync(source, dest);

    expect(result.uploaded).toEqual(["a.txt"]);
    expect(result.skipped).toEqual([]);
    expect(await textOf(dest, "a.txt")).toBe("alpha");
  });

  test("compare: 'size' skips on matching byte length regardless of content", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "alpha");
    // Same length, different bytes + etag.
    await dest.upload("a.txt", "OLD!!");

    const result = await sync(source, dest, { compare: "size" });

    expect(result.skipped).toEqual(["a.txt"]);
    expect(result.uploaded).toEqual([]);
    // Left untouched, which proves it was skipped rather than overwritten.
    expect(await textOf(dest, "a.txt")).toBe("OLD!!");
  });

  test("a compare function decides skip vs upload per key", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "alpha");
    await source.upload("b.txt", "beta");
    await dest.upload("a.txt", "alpha");
    await dest.upload("b.txt", "beta");

    const result = await sync(source, dest, {
      compare: (s) => s.key === "a.txt",
    });

    expect(result.skipped).toEqual(["a.txt"]);
    expect(result.uploaded).toEqual(["b.txt"]);
  });

  test("prune deletes destination keys absent from the source", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("keep.txt", "fresh");
    await dest.upload("stale.txt", "gone");

    const result = await sync(source, dest, { prune: true });

    expect(result.uploaded).toEqual(["keep.txt"]);
    expect(result.deleted).toEqual(["stale.txt"]);
    expect(await dest.exists("stale.txt")).toBe(false);
    expect(await textOf(dest, "keep.txt")).toBe("fresh");
  });

  test("without prune, extraneous destination keys are left intact", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "a");
    await dest.upload("extra.txt", "x");

    const result = await sync(source, dest);

    expect(result.deleted).toBeUndefined();
    expect(await dest.exists("extra.txt")).toBe(true);
  });

  test("prune with nothing extraneous returns an empty deleted list", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "a");

    const result = await sync(source, dest, { prune: true });

    expect(result.uploaded).toEqual(["a.txt"]);
    expect(result.deleted).toEqual([]);
  });

  test("transformKey remaps keys and destPrefix scopes the prune set", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "alpha");
    // Mirrored namespace, now stale.
    await dest.upload("archive/old.txt", "old");
    // Outside the mirror scope.
    await dest.upload("other/keep.txt", "untouched");

    const result = await sync(source, dest, {
      destPrefix: "archive/",
      prune: true,
      transformKey: (key) => `archive/${key}`,
    });

    expect(result.uploaded).toEqual(["a.txt"]);
    expect(await textOf(dest, "archive/a.txt")).toBe("alpha");
    expect(result.deleted).toEqual(["archive/old.txt"]);
    // The key outside destPrefix is never a prune candidate.
    expect(await dest.exists("other/keep.txt")).toBe(true);
  });

  test("dryRun returns the full plan without mutating either side", async () => {
    const source = newFiles();
    const dest = newFiles();
    // same.txt shares the first-upload etag on both sides, so it's skipped.
    await source.upload("same.txt", "s");
    await source.upload("new.txt", "n");
    await dest.upload("same.txt", "s");
    await dest.upload("stale.txt", "gone");

    const result = await sync(source, dest, { dryRun: true, prune: true });

    expect(result.uploaded).toEqual(["new.txt"]);
    expect(result.skipped).toEqual(["same.txt"]);
    expect(result.deleted).toEqual(["stale.txt"]);
    // Nothing was actually written or removed.
    expect(await dest.exists("new.txt")).toBe(false);
    expect(await dest.exists("stale.txt")).toBe(true);
  });

  test("reports progress once per key across uploaded, skipped, and deleted", async () => {
    const source = newFiles();
    const dest = newFiles();
    // same.txt shares the first-upload etag on both sides, so it's skipped.
    await source.upload("same.txt", "s");
    await source.upload("up.txt", "u");
    await dest.upload("same.txt", "s");
    await dest.upload("stale.txt", "x");

    const events: SyncProgress[] = [];
    await sync(source, dest, {
      onProgress: (event) => events.push(event),
      prune: true,
    });

    expect(events.map((e) => e.done)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.total === 3)).toBe(true);
    const status = Object.fromEntries(events.map((e) => [e.key, e.status]));
    expect(status["same.txt"]).toBe("skipped");
    expect(status["up.txt"]).toBe("uploaded");
    expect(status["stale.txt"]).toBe("deleted");
  });

  test("collects per-key upload failures without throwing", async () => {
    const sourceAdapter = fakeAdapter();
    const original = sourceAdapter.download;
    const source = new Files({
      adapter: {
        ...sourceAdapter,
        download: (key: string): Promise<StoredFile> =>
          key === "bad.txt"
            ? Promise.reject(new FilesError("Provider", "boom"))
            : original(key),
      },
    });
    const dest = newFiles();
    await source.upload("a.txt", "alpha");
    await source.upload("bad.txt", "x");
    await source.upload("c.txt", "gamma");

    const result = await sync(source, dest);

    expect(result.uploaded).toEqual(["a.txt", "c.txt"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.key).toBe("bad.txt");
    expect(result.errors?.[0]?.error).toBeInstanceOf(FilesError);
    expect(await dest.exists("bad.txt")).toBe(false);
  });

  test("a failed destination upload cancels the open source stream", async () => {
    let cancelled = 0;
    const sourceAdapter = fakeAdapter();
    const original = sourceAdapter.download.bind(sourceAdapter);
    const source = new Files({
      adapter: {
        ...sourceAdapter,
        async download(key: string, opts?: unknown): Promise<StoredFile> {
          const file = await original(key, opts as never);
          return {
            ...file,
            stream: () =>
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancelled += 1;
                },
                start() {
                  // Never enqueue: the destination fails before reading.
                },
              }),
          };
        },
      },
    });
    const destAdapter = fakeAdapter();
    const dest = new Files({
      adapter: {
        ...destAdapter,
        upload: () => Promise.reject(new FilesError("Unauthorized", "denied")),
      },
    });
    await source.upload("a.txt", "alpha");

    const result = await sync(source, dest);
    expect(result.uploaded).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(cancelled).toBe(1);
  });

  test("collects prune failures without throwing", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "a");
    // fakeAdapter.deleteMany rejects keys under `fail/`.
    await dest.upload("fail/x", "boom");
    await dest.upload("ok/y", "bye");

    const result = await sync(source, dest, { prune: true });

    expect(result.deleted).toEqual(["ok/y"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.key).toBe("fail/x");
    expect(await dest.exists("fail/x")).toBe(true);
  });

  test("stopOnError bails at the first upload failure and skips the prune", async () => {
    const sourceAdapter = fakeAdapter();
    const original = sourceAdapter.download;
    const source = new Files({
      adapter: {
        ...sourceAdapter,
        download: (key: string): Promise<StoredFile> =>
          key === "b.txt"
            ? Promise.reject(new FilesError("Provider", "boom"))
            : original(key),
      },
    });
    const dest = newFiles();
    await source.upload("a.txt", "alpha");
    await source.upload("b.txt", "beta");
    await dest.upload("stale.txt", "x");

    const result = await sync(source, dest, { prune: true, stopOnError: true });

    expect(result.uploaded).toEqual(["a.txt"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["b.txt"]);
    // The prune phase never runs after a bailed upload phase.
    expect(result.deleted).toEqual([]);
    expect(await dest.exists("stale.txt")).toBe(true);
  });

  test("an empty source with prune wipes the destination scope", async () => {
    const source = newFiles();
    const dest = newFiles();
    await dest.upload("a.txt", "a");
    await dest.upload("b.txt", "b");

    const result = await sync(source, dest, { prune: true });

    expect(result.uploaded).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.deleted).toEqual(["a.txt", "b.txt"]);
    expect(await dest.exists("a.txt")).toBe(false);
    expect(await dest.exists("b.txt")).toBe(false);
  });

  test("an empty source and destination sync nothing", async () => {
    const result = await sync(newFiles(), newFiles());
    expect(result).toEqual({ skipped: [], uploaded: [] });
  });

  test("honors an explicit concurrency and page-size limit", async () => {
    const source = newFiles();
    const dest = newFiles();
    for (const key of ["a", "b", "c", "d", "e"]) {
      // eslint-disable-next-line no-await-in-loop -- seeds keys in order to assert deterministic sync ordering
      await source.upload(key, key);
    }

    const result = await sync(source, dest, { concurrency: 2, limit: 2 });

    expect(result.uploaded).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("an already-aborted signal rejects the sync", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "alpha");
    const controller = new AbortController();
    controller.abort();

    await expect(
      sync(source, dest, { signal: controller.signal })
    ).rejects.toThrow();
    expect(await dest.exists("a.txt")).toBe(false);
  });

  test("a listing failure rejects the whole sync", async () => {
    const sourceAdapter = fakeAdapter();
    const source = new Files({
      adapter: {
        ...sourceAdapter,
        list: (): Promise<ListResult> =>
          Promise.reject(new FilesError("Provider", "list boom")),
      },
    });

    await expect(sync(source, newFiles())).rejects.toThrow("list boom");
  });
});
