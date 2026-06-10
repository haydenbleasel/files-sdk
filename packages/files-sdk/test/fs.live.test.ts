/**
 * Live test for the `fs` adapter against a real local filesystem temp dir.
 *
 * Needs no credentials, so it runs against the actual OS filesystem whenever
 * `LIVE_TESTS=1` is set. Mirrors the CRUD + URL scenarios in `fs.test.ts`, but
 * with no mocking/spying — every assertion goes through real disk I/O.
 *
 *   LIVE_TESTS=1 bun test fs.live
 */
import { afterAll, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { fs as fsAdapter } from "../src/fs/index.js";
import { Files } from "../src/index.js";
import { liveDescribe } from "./live-helper.js";

const tmpRoots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-fs-live-"));
  tmpRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    tmpRoots.map((dir) => fsp.rm(dir, { force: true, recursive: true }))
  );
});

liveDescribe("fs adapter (live)", () => {
  test("upload + download round-trips against real disk", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });

    const result = await files.upload("a.txt", "hello live", {
      contentType: "text/plain",
      metadata: { run: "live" },
    });
    expect(result.key).toBe("a.txt");
    expect(result.size).toBe(10);

    // The body really landed on disk.
    const onDisk = await fsp.readFile(path.join(root, "a.txt"), "utf-8");
    expect(onDisk).toBe("hello live");

    const got = await files.download("a.txt");
    expect(await got.text()).toBe("hello live");
    expect(got.metadata).toEqual({ run: "live" });
  });

  test("head returns metadata without transferring the body", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    await files.upload("h.txt", "heady", { metadata: { a: "b" } });

    const info = await files.head("h.txt");
    expect(info.key).toBe("h.txt");
    expect(info.size).toBe(5);
    expect(info.metadata).toEqual({ a: "b" });
    await expect(files.exists("h.txt")).resolves.toBe(true);
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("copy and move relocate the body on disk", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    await files.upload("src.txt", "payload", { metadata: { v: "1" } });

    await files.copy("src.txt", "copy.txt");
    const copied = await files.download("copy.txt");
    expect(await copied.text()).toBe("payload");
    await expect(files.exists("src.txt")).resolves.toBe(true);

    await files.move("src.txt", "moved.txt");
    await expect(files.exists("src.txt")).resolves.toBe(false);
    const moved = await files.download("moved.txt");
    expect(await moved.text()).toBe("payload");
  });

  test("list reflects real directory contents, sorted and prefix-filtered", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    await files.upload("foo/b.txt", "1");
    await files.upload("foo/a.txt", "1");
    await files.upload("bar/c.txt", "1");

    const all = await files.list();
    expect(all.items.map((i) => i.key)).toEqual([
      "bar/c.txt",
      "foo/a.txt",
      "foo/b.txt",
    ]);

    const scoped = await files.list({ prefix: "foo/" });
    expect(scoped.items.map((i) => i.key)).toEqual(["foo/a.txt", "foo/b.txt"]);
  });

  test("delete removes the body from disk and is idempotent", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    await files.upload("d.txt", "bye");

    await files.delete("d.txt");
    await expect(files.exists("d.txt")).resolves.toBe(false);
    await expect(fsp.access(path.join(root, "d.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Deleting again is a no-op.
    await expect(files.delete("d.txt")).resolves.toBeUndefined();
  });

  test("url() returns a usable file:// URL by default", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    await files.upload("u.txt", "url-body");

    const url = await files.url("u.txt");
    expect(url.startsWith("file://")).toBe(true);
    expect(url.endsWith("/u.txt")).toBe(true);
  });

  test("url() honors urlBaseUrl and signedUploadUrl issues a PUT URL", async () => {
    const root = await makeRoot();
    const files = new Files({
      adapter: fsAdapter({ root, urlBaseUrl: "http://localhost:3000/files" }),
    });
    await files.upload("a/b.txt", "x");

    expect(await files.url("a/b.txt")).toBe(
      "http://localhost:3000/files/a/b.txt"
    );

    const signed = await files.signedUploadUrl("up.txt", {
      contentType: "text/plain",
      expiresIn: 60,
    });
    expect(signed.method).toBe("PUT");
    expect(signed.url).toContain("http://localhost:3000/files/up.txt?");
    expect(signed.url).toContain("expires=");
  });
});
