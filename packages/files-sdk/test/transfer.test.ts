import { describe, expect, test } from "bun:test";

import { Files, FilesError, transfer } from "../src/index.js";
import type { ListResult, StoredFile, TransferProgress } from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const newFiles = (): Files => new Files({ adapter: fakeAdapter() });

const textOf = async (files: Files, key: string): Promise<string> => {
  const file = await files.download(key);
  return file.text();
};

describe("transfer", () => {
  test("transfers every object, with content type and metadata", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "alpha", {
      contentType: "text/plain",
      metadata: { user: "1" },
    });
    // No metadata, to exercise the body-only path.
    await source.upload("b.txt", "beta");
    await source.upload("dir/c.txt", "gamma");

    const result = await transfer(source, dest);

    expect(result.transferred).toEqual(["a.txt", "b.txt", "dir/c.txt"]);
    expect(result.skipped).toBeUndefined();
    expect(result.errors).toBeUndefined();

    const a = await dest.download("a.txt");
    expect(await a.text()).toBe("alpha");
    expect(a.type).toBe("text/plain");
    expect(a.metadata).toEqual({ user: "1" });
    expect(await textOf(dest, "b.txt")).toBe("beta");
    expect(await textOf(dest, "dir/c.txt")).toBe("gamma");
  });

  test("prefix scopes which keys are walked", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("keep/a.txt", "a");
    await source.upload("keep/b.txt", "b");
    await source.upload("skip/c.txt", "c");

    const result = await transfer(source, dest, { prefix: "keep/" });

    expect(result.transferred).toEqual(["keep/a.txt", "keep/b.txt"]);
    expect(await dest.exists("skip/c.txt")).toBe(false);
  });

  test("transformKey remaps destination keys", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "alpha");

    const result = await transfer(source, dest, {
      transformKey: (key) => `archive/${key}`,
    });

    expect(result.transferred).toEqual(["a.txt"]);
    expect(await textOf(dest, "archive/a.txt")).toBe("alpha");
    expect(await dest.exists("a.txt")).toBe(false);
  });

  test("overwrite: false skips keys already at the destination", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "new-a");
    await source.upload("b.txt", "new-b");
    await dest.upload("a.txt", "old-a");

    const result = await transfer(source, dest, { overwrite: false });

    expect(result.transferred).toEqual(["b.txt"]);
    expect(result.skipped).toEqual(["a.txt"]);
    // The pre-existing object is left untouched.
    expect(await textOf(dest, "a.txt")).toBe("old-a");
    expect(await textOf(dest, "b.txt")).toBe("new-b");
  });

  test("forwards an active signal and honors the page-size limit", async () => {
    const source = newFiles();
    const dest = newFiles();
    for (const key of ["a", "b", "c", "d", "e"]) {
      await source.upload(key, key);
    }
    const controller = new AbortController();

    const result = await transfer(source, dest, {
      limit: 2,
      overwrite: false,
      signal: controller.signal,
    });

    expect(result.transferred).toEqual(["a", "b", "c", "d", "e"]);
    expect(await textOf(dest, "c")).toBe("c");
  });

  test("collects per-key failures without throwing", async () => {
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

    const result = await transfer(source, dest);

    expect(result.transferred).toEqual(["a.txt", "c.txt"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]?.key).toBe("bad.txt");
    expect(result.errors?.[0]?.error).toBeInstanceOf(FilesError);
    expect(await dest.exists("bad.txt")).toBe(false);
  });

  test("stopOnError bails at the first failure", async () => {
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
    await source.upload("c.txt", "gamma");

    const result = await transfer(source, dest, { stopOnError: true });

    expect(result.transferred).toEqual(["a.txt"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["b.txt"]);
    // The key after the failure is never attempted.
    expect(await dest.exists("c.txt")).toBe(false);
  });

  test("reports progress once per key, with a total", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "a");
    await dest.upload("b.txt", "old");
    await source.upload("b.txt", "new");

    const events: TransferProgress[] = [];
    await transfer(source, dest, {
      onProgress: (event) => events.push(event),
      overwrite: false,
    });

    expect(events.map((e) => e.done)).toEqual([1, 2]);
    expect(events.every((e) => e.total === 2)).toBe(true);
    const status = Object.fromEntries(events.map((e) => [e.key, e.status]));
    expect(status["a.txt"]).toBe("transferred");
    expect(status["b.txt"]).toBe("skipped");
  });

  test("an empty source transfers nothing", async () => {
    const result = await transfer(newFiles(), newFiles());
    expect(result).toEqual({ transferred: [] });
  });

  test("an already-aborted signal rejects the transfer", async () => {
    const source = newFiles();
    const dest = newFiles();
    await source.upload("a.txt", "alpha");
    const controller = new AbortController();
    controller.abort();

    await expect(
      transfer(source, dest, { signal: controller.signal })
    ).rejects.toThrow();
    expect(await dest.exists("a.txt")).toBe(false);
  });

  test("respects an explicit concurrency", async () => {
    const source = newFiles();
    const dest = newFiles();
    for (const key of ["a", "b", "c"]) {
      await source.upload(key, key);
    }

    const result = await transfer(source, dest, { concurrency: 2 });

    expect(result.transferred).toEqual(["a", "b", "c"]);
  });

  test("a listing failure rejects the whole transfer", async () => {
    const sourceAdapter = fakeAdapter();
    const source = new Files({
      adapter: {
        ...sourceAdapter,
        list: (): Promise<ListResult> =>
          Promise.reject(new FilesError("Provider", "list boom")),
      },
    });

    await expect(transfer(source, newFiles())).rejects.toThrow("list boom");
  });
});
