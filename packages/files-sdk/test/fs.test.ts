import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fs as fsAdapter, mapFsError } from "../src/fs/index.js";
import { Files, FilesError, UploadControl } from "../src/index.js";
import type { ResumableUploadSession } from "../src/index.js";

const tmpRoots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-fs-"));
  tmpRoots.push(root);
  return root;
};

afterAll(async () => {
  await Promise.all(
    tmpRoots.map((dir) => fsp.rm(dir, { force: true, recursive: true }))
  );
});

const drainStream = async (
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
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

describe("fs adapter", () => {
  describe("construction", () => {
    test("missing root throws", () => {
      // oxlint-disable-next-line no-empty-object-type
      expect(() => fsAdapter({} as unknown as { root: string })).toThrow(
        /missing `root`/u
      );
    });

    test("exposes name and resolved root", async () => {
      const root = await makeRoot();
      const adapter = fsAdapter({ root });
      expect(adapter.name).toBe("fs");
      // mkdtemp on macOS returns /var/folders/... which symlinks to
      // /private/var/folders/... — both shapes are valid; just check
      // it's an absolute path that contains the temp prefix.
      expect(path.isAbsolute(adapter.root)).toBe(true);
      expect(adapter.raw.root).toBe(adapter.root);
    });

    test("relative root resolves to absolute", () => {
      const adapter = fsAdapter({ root: "./.tmp-relative-root" });
      expect(path.isAbsolute(adapter.root)).toBe(true);
    });
  });

  describe("upload + download", () => {
    test("string body round-trips with default text/plain", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      const result = await files.upload("a.txt", "hello");
      expect(result.key).toBe("a.txt");
      expect(result.size).toBe(5);
      expect(result.contentType).toBe("text/plain; charset=utf-8");
      expect(result.etag).toMatch(/^"[0-9a-f]{16}"$/u);

      const got = await files.download("a.txt");
      expect(await got.text()).toBe("hello");
      expect(got.type).toBe("text/plain; charset=utf-8");
      expect(got.etag).toBe(result.etag);
    });

    test("Uint8Array body preserves bytes exactly", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      const data = randomBytes(1024);
      const bytes = new Uint8Array(data);
      await files.upload("data.bin", bytes, {
        contentType: "application/octet-stream",
      });
      const got = await files.download("data.bin");
      const out = new Uint8Array(await got.arrayBuffer());
      expect(out).toEqual(bytes);
    });

    test("Blob body preserves type when no contentType override", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      const blob = new Blob(["ok"], { type: "image/png" });
      const result = await files.upload("img.png", blob);
      expect(result.contentType).toBe("image/png");
    });

    test("ArrayBuffer body uploads with default octet-stream type", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer;
      const result = await files.upload("ab.bin", buf);
      expect(result.size).toBe(5);
      expect(result.contentType).toBe("application/octet-stream");
      const got = await files.download("ab.bin");
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3, 4, 5])
      );
    });

    test("ArrayBufferView (DataView) body uploads bytes verbatim", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      const underlying = new Uint8Array([10, 20, 30, 40, 50, 60]);
      // Slice via a view so byteOffset > 0 — verifies the adapter respects
      // offsets when copying out of the underlying buffer.
      const view = new DataView(underlying.buffer, 2, 3);
      const result = await files.upload("v.bin", view);
      expect(result.size).toBe(3);
      const got = await files.download("v.bin");
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(
        new Uint8Array([30, 40, 50])
      );
    });

    test("explicit contentType overrides body-derived default", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      const result = await files.upload("a.txt", "hi", {
        contentType: "application/json",
      });
      expect(result.contentType).toBe("application/json");
    });

    test("metadata persists through sidecar", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("a.txt", "x", { metadata: { user: "1" } });
      const got = await files.download("a.txt");
      expect(got.metadata).toEqual({ user: "1" });
    });

    test("nested keys create directories on demand", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("a/b/c/deep.txt", "hi");
      const stat = await fsp.stat(path.join(root, "a", "b", "c", "deep.txt"));
      expect(stat.isFile()).toBe(true);
    });

    test("upload writes a sidecar with the expected shape", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("a.txt", "hi", {
        cacheControl: "max-age=60",
        contentType: "text/plain",
        metadata: { x: "y" },
      });
      const sidecar = JSON.parse(
        await fsp.readFile(path.join(root, "a.txt.meta.json"), "utf-8")
      );
      expect(sidecar.contentType).toBe("text/plain");
      expect(sidecar.cacheControl).toBe("max-age=60");
      expect(sidecar.metadata).toEqual({ x: "y" });
      expect(typeof sidecar.etag).toBe("string");
      expect(typeof sidecar.lastModified).toBe("number");
    });

    test("ReadableStream upload writes via temp file and round-trips", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("part1-"));
          controller.enqueue(new TextEncoder().encode("part2"));
          controller.close();
        },
      });
      const result = await files.upload("streamed.txt", stream);
      expect(result.size).toBe(11);
      const got = await files.download("streamed.txt");
      expect(await got.text()).toBe("part1-part2");
    });

    test("upload overwrites in place (atomic via temp + rename)", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("a.txt", "first");
      await files.upload("a.txt", "second-and-longer");
      const got = await files.download("a.txt");
      expect(await got.text()).toBe("second-and-longer");
    });

    test("download as: 'stream' yields a usable ReadableStream", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("s.txt", "stream-content");
      const got = await files.download("s.txt", { as: "stream" });
      const bytes = await drainStream(got.stream());
      expect(new TextDecoder().decode(bytes)).toBe("stream-content");
    });

    test("range reads only the requested slice off disk (buffer)", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("r.txt", "0123456789");
      const got = await files.download("r.txt", {
        range: { end: 5, start: 3 },
      });
      expect(await got.text()).toBe("345");
      expect(got.size).toBe(3);
    });

    test("open-ended range streams from start to EOF", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("r.txt", "0123456789");
      const got = await files.download("r.txt", {
        as: "stream",
        range: { start: 6 },
      });
      expect(got.size).toBe(4);
      const bytes = await drainStream(got.stream());
      expect(new TextDecoder().decode(bytes)).toBe("6789");
    });

    test("download falls back when sidecar is missing", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      // Hand-place a body file with no sidecar — simulates files dropped
      // into the root by hand or by another tool.
      await fsp.writeFile(path.join(root, "raw.bin"), "raw-data");
      const got = await files.download("raw.bin");
      expect(await got.text()).toBe("raw-data");
      expect(got.type).toBe("application/octet-stream");
      expect(got.etag).toBeUndefined();
    });

    test("download throws NotFound for missing key", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await expect(files.download("missing.txt")).rejects.toMatchObject({
        code: "NotFound",
      });
    });
  });

  describe("head", () => {
    test("returns metadata without transferring the body", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("h.txt", "hi", { metadata: { a: "b" } });
      const info = await files.head("h.txt");
      expect(info.key).toBe("h.txt");
      expect(info.size).toBe(2);
      expect(info.metadata).toEqual({ a: "b" });
    });

    test("lazy body still works on the StoredFile from head()", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("h.txt", "lazy-body");
      const info = await files.head("h.txt");
      expect(await info.text()).toBe("lazy-body");
    });

    test("head throws NotFound for missing key", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await expect(files.head("nope")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("exists returns true for present keys and false for missing keys", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("exists.txt", "hi");
      await expect(files.exists("exists.txt")).resolves.toBe(true);
      await expect(files.exists("missing.txt")).resolves.toBe(false);
    });
  });

  describe("delete", () => {
    test("removes body and sidecar", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("d.txt", "x");
      await files.delete("d.txt");
      await expect(fsp.access(path.join(root, "d.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fsp.access(path.join(root, "d.txt.meta.json"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("surfaces non-ENOENT rm errors as FilesError", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      // Place a directory at the body path. `fsp.rm` without `recursive`
      // refuses to remove a directory — the adapter should surface the
      // ERR_FS_EISDIR as a Provider error rather than swallow it.
      await fsp.mkdir(path.join(root, "thedir"));
      await expect(files.delete("thedir")).rejects.toMatchObject({
        code: "Provider",
      });
    });

    test("is idempotent on missing keys", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await expect(files.delete("never-existed")).resolves.toBeUndefined();
    });
  });

  describe("copy", () => {
    test("copies body and sidecar with refreshed lastModified", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("src.txt", "data", { metadata: { v: "1" } });
      await files.copy("src.txt", "dst.txt");
      const got = await files.download("dst.txt");
      expect(await got.text()).toBe("data");
      expect(got.metadata).toEqual({ v: "1" });
    });

    test("copy throws NotFound when source is missing", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await expect(files.copy("nope", "dst")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("copy creates intermediate directories at destination", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("a.txt", "ok");
      await files.copy("a.txt", "deep/nest/dest.txt");
      const got = await files.download("deep/nest/dest.txt");
      expect(await got.text()).toBe("ok");
    });
  });

  describe("move", () => {
    test("relocates body and sidecar, removing the source", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("src.txt", "data", {
        contentType: "text/plain",
        metadata: { v: "1" },
      });
      await files.move("src.txt", "dst.txt");

      expect(await files.exists("src.txt")).toBe(false);
      const got = await files.download("dst.txt");
      expect(await got.text()).toBe("data");
      expect(got.type).toBe("text/plain");
      expect(got.metadata).toEqual({ v: "1" });
    });

    test("throws NotFound when source is missing", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await expect(files.move("nope", "dst")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("creates intermediate directories at destination", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("a.txt", "ok");
      await files.move("a.txt", "deep/nest/dest.txt");
      expect(await files.exists("a.txt")).toBe(false);
      const got = await files.download("deep/nest/dest.txt");
      expect(await got.text()).toBe("ok");
    });

    test("clears a stale destination sidecar when source has none", async () => {
      const root = await makeRoot();
      const adapter = fsAdapter({ root });
      const files = new Files({ adapter });
      // Destination previously held metadata; the source body is written
      // straight to disk with no sidecar.
      await files.upload("dst.txt", "old", { metadata: { stale: "yes" } });
      await fsp.writeFile(path.join(root, "src.txt"), "fresh");

      await files.move("src.txt", "dst.txt");
      const got = await files.download("dst.txt");
      expect(await got.text()).toBe("fresh");
      expect(got.metadata).toBeUndefined();
    });
  });

  describe("list", () => {
    test("returns all uploads under root, sorted", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("b.txt", "1");
      await files.upload("a.txt", "1");
      await files.upload("c/x.txt", "1");
      const result = await files.list();
      expect(result.items.map((i) => i.key)).toEqual([
        "a.txt",
        "b.txt",
        "c/x.txt",
      ]);
    });

    test("filters by prefix", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("foo/1.txt", "1");
      await files.upload("foo/2.txt", "1");
      await files.upload("bar/1.txt", "1");
      const result = await files.list({ prefix: "foo/" });
      expect(result.items.map((i) => i.key)).toEqual([
        "foo/1.txt",
        "foo/2.txt",
      ]);
    });

    test("paginates with limit + cursor", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      for (const k of ["a", "b", "c", "d", "e"]) {
        await files.upload(`${k}.txt`, "1");
      }
      const page1 = await files.list({ limit: 2 });
      expect(page1.items.map((i) => i.key)).toEqual(["a.txt", "b.txt"]);
      expect(page1.cursor).toBe("b.txt");

      const page2 = await files.list({ cursor: page1.cursor, limit: 2 });
      expect(page2.items.map((i) => i.key)).toEqual(["c.txt", "d.txt"]);
      expect(page2.cursor).toBe("d.txt");

      const page3 = await files.list({ cursor: page2.cursor, limit: 2 });
      expect(page3.items.map((i) => i.key)).toEqual(["e.txt"]);
      expect(page3.cursor).toBeUndefined();
    });

    test("does not include sidecar files as items", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("a.txt", "x");
      const result = await files.list();
      const keys = result.items.map((i) => i.key);
      expect(keys).toContain("a.txt");
      expect(keys.some((k) => k.endsWith(".meta.json"))).toBe(false);
    });

    test("returns empty when root does not yet exist", async () => {
      const root = path.join(
        os.tmpdir(),
        `files-sdk-fs-missing-${Date.now()}-${process.pid}`
      );
      tmpRoots.push(root);
      const files = new Files({ adapter: fsAdapter({ root }) });
      const result = await files.list();
      expect(result.items).toEqual([]);
    });

    test("skips files that vanish between walk and stat (ENOENT mid-page)", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("a.txt", "1");
      await files.upload("b.txt", "1");
      await files.upload("c.txt", "1");
      // Walk produces all three keys; the items loop then stats each in
      // turn. Make the first stat call reject with ENOENT — that file is
      // skipped rather than failing the whole listing.
      const originalStat = fsp.stat;
      const statSpy = spyOn(fsp, "stat");
      let consumed = false;
      statSpy.mockImplementation(((p: Parameters<typeof fsp.stat>[0]) => {
        if (!consumed) {
          consumed = true;
          return Promise.reject(
            Object.assign(new Error("vanished"), { code: "ENOENT" })
          );
        }
        return originalStat(p);
      }) as typeof fsp.stat);
      try {
        const result = await files.list();
        expect(result.items.map((i) => i.key)).toEqual(["b.txt", "c.txt"]);
      } finally {
        statSpy.mockRestore();
      }
    });

    test("surfaces non-ENOENT walk errors as FilesError", async () => {
      // Force fsp.readdir on a subdirectory to fail with EACCES by chmod'ing
      // it to 0o000. Exercises the walk's non-ENOENT throw branch and the
      // outer list() catch.
      if (process.platform === "win32" || process.getuid?.() === 0) {
        // chmod is a no-op for root on POSIX and isn't meaningful on Windows.
        return;
      }
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("ok.txt", "hi");
      const blocked = path.join(root, "blocked");
      await fsp.mkdir(blocked);
      await fsp.writeFile(path.join(blocked, "inner.txt"), "x");
      await fsp.chmod(blocked, 0o000);
      try {
        await expect(files.list()).rejects.toBeInstanceOf(FilesError);
      } finally {
        // Restore so the afterAll cleanup can remove the tree.
        await fsp.chmod(blocked, 0o755);
      }
    });
  });

  describe("path safety", () => {
    test("rejects keys that escape root via ..", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await expect(files.download("../outside.txt")).rejects.toMatchObject({
        code: "Provider",
      });
    });

    test("constructor prefix rejects dot segments before fs path resolution", async () => {
      const root = await makeRoot();
      await fsp.mkdir(path.join(root, "tenant-b"), { recursive: true });
      await fsp.writeFile(path.join(root, "tenant-b", "secret.txt"), "secret");
      const files = new Files({
        adapter: fsAdapter({ root }),
        prefix: "tenant-a",
      });

      await expect(
        files.download("../tenant-b/secret.txt")
      ).rejects.toMatchObject({
        code: "Provider",
      });
      await expect(
        files.upload("../tenant-b/pwn.txt", "pwn")
      ).rejects.toMatchObject({
        code: "Provider",
      });
      await expect(
        fsp.readFile(path.join(root, "tenant-b", "pwn.txt"), "utf-8")
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("rejects deeply traversing keys", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await expect(files.upload("../../etc/passwd", "x")).rejects.toMatchObject(
        { code: "Provider" }
      );
    });

    test("rejects absolute keys", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await expect(files.download("/etc/passwd")).rejects.toMatchObject({
        code: "Provider",
      });
    });

    test("rejects copy with an escaping destination", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("a.txt", "x");
      await expect(files.copy("a.txt", "../outside.txt")).rejects.toMatchObject(
        { code: "Provider" }
      );
    });

    test("rejects keys that resolve to the adapter root itself", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      // "." resolves to the root directory — there's no body at the root,
      // so this should be rejected before any fs operation runs.
      await expect(files.download(".")).rejects.toMatchObject({
        code: "Provider",
      });
    });

    test("rejects keys ending in the reserved sidecar suffix", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      // Otherwise upload("x.txt.meta.json", ...) would silently overwrite the
      // sidecar of "x.txt" (its contentType / etag / metadata), the key
      // would be hidden from list() because walk() filters .meta.json,
      // and delete("x.txt.meta.json") would wipe x.txt's sidecar. Reject
      // at the boundary instead.
      await expect(files.upload("x.txt.meta.json", "x")).rejects.toMatchObject({
        code: "Provider",
      });
      await expect(files.download("x.txt.meta.json")).rejects.toMatchObject({
        code: "Provider",
      });
      await expect(files.head("x.txt.meta.json")).rejects.toMatchObject({
        code: "Provider",
      });
      await expect(files.exists("x.txt.meta.json")).rejects.toMatchObject({
        code: "Provider",
      });
      await expect(files.delete("x.txt.meta.json")).rejects.toMatchObject({
        code: "Provider",
      });
      await expect(
        files.copy("a.txt", "a.txt.meta.json")
      ).rejects.toMatchObject({ code: "Provider" });
      await expect(files.url("x.txt.meta.json")).rejects.toMatchObject({
        code: "Provider",
      });
      await expect(
        files.signedUploadUrl("x.txt.meta.json", { expiresIn: 60 })
      ).rejects.toMatchObject({ code: "Provider" });
    });

    test("rejects sidecar-suffix variants that alias on the host filesystem", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      // A literal `endsWith(".meta.json")` check leaves the namespace open
      // on the platforms this dev adapter mostly runs on: case-insensitive
      // volumes (APFS/NTFS) alias `x.txt.META.JSON` onto `x.txt.meta.json`,
      // Windows strips trailing dots/spaces (`x.txt.meta.json.`), and
      // path.resolve folds a trailing slash (`x.txt.meta.json/`) back onto
      // the sidecar. All of these would let an upload overwrite another
      // key's sidecar, so every variant must reject.
      const variants = [
        "x.txt.META.JSON",
        "x.txt.Meta.Json",
        "x.txt.meta.json.",
        "x.txt.meta.json ",
        "x.txt.meta.json/",
      ];
      for (const variant of variants) {
        await expect(files.upload(variant, "x")).rejects.toMatchObject({
          code: "Provider",
        });
        await expect(files.delete(variant)).rejects.toMatchObject({
          code: "Provider",
        });
      }
    });

    test("keys with .meta.json elsewhere in the path are allowed", async () => {
      // The collision is at the sidecar path only — a key whose final
      // segment is not `*.meta.json` is safe. e.g. a folder named
      // `drafts.meta.json/` containing `note.txt` round-trips fine.
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("drafts.meta.json/note.txt", "hi");
      const got = await files.download("drafts.meta.json/note.txt");
      expect(await got.text()).toBe("hi");
    });
  });

  describe("url", () => {
    test("returns a file:// URL by default", async () => {
      const root = await makeRoot();
      const adapter = fsAdapter({ root });
      const files = new Files({ adapter });
      await files.upload("a.txt", "x");
      const u = await files.url("a.txt");
      expect(u.startsWith("file://")).toBe(true);
      expect(u.endsWith("/a.txt")).toBe(true);
    });

    test("uses urlBaseUrl when configured", async () => {
      const root = await makeRoot();
      const files = new Files({
        adapter: fsAdapter({ root, urlBaseUrl: "http://localhost:3000/files" }),
      });
      await files.upload("a/b.txt", "x");
      const u = await files.url("a/b.txt");
      expect(u).toBe("http://localhost:3000/files/a/b.txt");
    });

    test("trims trailing slash on urlBaseUrl", async () => {
      const root = await makeRoot();
      const files = new Files({
        adapter: fsAdapter({
          root,
          urlBaseUrl: "http://localhost:3000/files/",
        }),
      });
      const u = await files.url("a.txt");
      expect(u).toBe("http://localhost:3000/files/a.txt");
    });

    test("appends responseContentDisposition with urlBaseUrl", async () => {
      const root = await makeRoot();
      const files = new Files({
        adapter: fsAdapter({ root, urlBaseUrl: "http://localhost:3000/files" }),
      });
      const u = await files.url("a.txt", {
        responseContentDisposition: "attachment",
      });
      expect(u).toContain("response-content-disposition=attachment");
    });

    test("throws on responseContentDisposition without urlBaseUrl", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await expect(
        files.url("a.txt", { responseContentDisposition: "attachment" })
      ).rejects.toMatchObject({ code: "Provider" });
    });
  });

  describe("signedUploadUrl", () => {
    test("throws without urlBaseUrl", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await expect(
        files.signedUploadUrl("a.txt", { expiresIn: 60 })
      ).rejects.toMatchObject({ code: "Provider" });
    });

    test("returns PUT URL with expires query when urlBaseUrl is set", async () => {
      const root = await makeRoot();
      const files = new Files({
        adapter: fsAdapter({
          root,
          urlBaseUrl: "http://localhost:3000/upload",
        }),
      });
      const signed = await files.signedUploadUrl("a.txt", {
        contentType: "text/plain",
        expiresIn: 60,
        maxSize: 1024,
      });
      expect(signed.method).toBe("PUT");
      expect(signed.url).toContain("http://localhost:3000/upload/a.txt?");
      expect(signed.url).toContain("expires=");
      expect(signed.url).toContain("content-type=text%2Fplain");
      expect(signed.url).toContain("max-size=1024");
      if (signed.method === "PUT") {
        expect(signed.headers?.["Content-Type"]).toBe("text/plain");
      }
    });

    test("validates key path even without urlBaseUrl", async () => {
      const root = await makeRoot();
      const files = new Files({
        adapter: fsAdapter({
          root,
          urlBaseUrl: "http://localhost:3000/upload",
        }),
      });
      await expect(
        files.signedUploadUrl("../escape", { expiresIn: 60 })
      ).rejects.toMatchObject({ code: "Provider" });
    });
  });

  describe("error mapping", () => {
    test("mapFsError preserves FilesError instances", () => {
      const original = new FilesError("Conflict", "boom");
      expect(mapFsError(original)).toBe(original);
    });

    test("classifies ENOENT as NotFound", () => {
      const err = Object.assign(new Error("nope"), { code: "ENOENT" });
      expect(mapFsError(err).code).toBe("NotFound");
    });

    test("classifies EACCES as Unauthorized", () => {
      const err = Object.assign(new Error("denied"), { code: "EACCES" });
      expect(mapFsError(err).code).toBe("Unauthorized");
    });

    test("classifies EEXIST as Conflict", () => {
      const err = Object.assign(new Error("exists"), { code: "EEXIST" });
      expect(mapFsError(err).code).toBe("Conflict");
    });

    test("classifies unknown codes as Provider", () => {
      const err = Object.assign(new Error("???"), { code: "EWHATEVER" });
      expect(mapFsError(err).code).toBe("Provider");
    });

    test("classifies err.code that isn't a string as Provider", () => {
      // numeric `code` (libuv sometimes attaches one) shouldn't match the
      // string-based classifier — falls through to Provider.
      const err = Object.assign(new Error("weird"), { code: 42 });
      expect(mapFsError(err).code).toBe("Provider");
    });

    test("classifies an error with no code field as Provider", () => {
      expect(mapFsError(new Error("plain")).code).toBe("Provider");
    });

    test("non-Error values fall back to the default message", () => {
      const mapped = mapFsError("string thrown");
      expect(mapped.code).toBe("Provider");
      expect(mapped.message).toBe("fs error");
    });
  });

  describe("sidecar resilience", () => {
    test("download falls through to defaults when sidecar JSON is missing fields", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await fsp.writeFile(path.join(root, "x.bin"), "data");
      // Sidecar parses but is missing the required keys — adapter should
      // treat it as if there were no sidecar at all.
      await fsp.writeFile(
        path.join(root, "x.bin.meta.json"),
        JSON.stringify({ unrelated: true })
      );
      const got = await files.download("x.bin");
      expect(await got.text()).toBe("data");
      expect(got.type).toBe("application/octet-stream");
      expect(got.etag).toBeUndefined();
    });

    test("download surfaces sidecar JSON parse errors as Provider", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await fsp.writeFile(path.join(root, "x.bin"), "data");
      await fsp.writeFile(path.join(root, "x.bin.meta.json"), "{not json");
      await expect(files.download("x.bin")).rejects.toMatchObject({
        code: "Provider",
      });
    });

    test("head's lazy body errors when underlying body file is removed", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await files.upload("h.txt", "lazy");
      const info = await files.head("h.txt");
      // Yank the body file out from under the lazy factory — text() should
      // reject through mapFsError, not crash with a raw ENOENT.
      await fsp.rm(path.join(root, "h.txt"));
      await expect(info.text()).rejects.toMatchObject({ code: "NotFound" });
    });
  });

  describe("upload failure cleanup", () => {
    test("buffer upload surfaces and cleans up when rename fails", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      // Pre-create a directory at the destination — rename(file → dir) fails
      // with EISDIR/EPERM, and the temp file should still get cleaned up.
      await fsp.mkdir(path.join(root, "blocker"));
      await expect(files.upload("blocker", "x")).rejects.toBeInstanceOf(
        FilesError
      );
      const remaining = await fsp.readdir(root);
      // No `.tmp` leftovers — bestEffortRm should have removed them.
      expect(remaining.some((n) => n.includes(".tmp"))).toBe(false);
    });

    test("stream upload surfaces and cleans up when rename fails", async () => {
      const root = await makeRoot();
      const files = new Files({ adapter: fsAdapter({ root }) });
      await fsp.mkdir(path.join(root, "blocker"));
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("payload"));
          c.close();
        },
      });
      await expect(files.upload("blocker", stream)).rejects.toBeInstanceOf(
        FilesError
      );
      const remaining = await fsp.readdir(root);
      expect(remaining.some((n) => n.includes(".tmp"))).toBe(false);
    });
  });
});

describe("fs resumable uploads", () => {
  test("fresh upload writes the file and a sidecar", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    const control = new UploadControl();
    const result = await files.upload("big.bin", "abcdefghijkl", {
      contentType: "text/plain",
      control,
      multipart: { partSize: 4 },
    });
    expect(result.size).toBe(12);
    expect(control.status).toBe("completed");
    const got = await files.download("big.bin");
    expect(await got.text()).toBe("abcdefghijkl");
    expect(got.type).toBe("text/plain");
    expect(got.etag).toBeDefined();
    // The partial file is gone once complete renames it into place.
    await expect(
      fsp.stat(path.join(root, "big.bin.fls-part"))
    ).rejects.toThrow();
  });

  test("resumes in a new adapter instance from the persisted token", async () => {
    const root = await makeRoot();
    const writer = new Files({ adapter: fsAdapter({ root }) });
    const control = new UploadControl();
    let paused = false;
    const pending = writer
      .upload("r.bin", "abcdefghijkl", {
        control,
        multipart: { concurrency: 1, partSize: 4 },
        onProgress: ({ loaded }) => {
          if (loaded === 4 && !paused) {
            paused = true;
            control.pause();
          }
        },
      })
      .catch(() => {
        // Abandoned — a "new process" resumes below.
      });
    await delay(0);
    await delay(0);
    const token = structuredClone(control.toJSON()) as ResumableUploadSession;
    expect(token.provider).toBe("fs");

    // A fresh adapter on the same root resumes from the partial file on disk.
    const resumer = new Files({ adapter: fsAdapter({ root }) });
    const result = await resumer.upload("r.bin", "abcdefghijkl", {
      control: UploadControl.from(token),
      multipart: { concurrency: 1, partSize: 4 },
    });
    expect(result.size).toBe(12);
    const got = await resumer.download("r.bin");
    expect(await got.text()).toBe("abcdefghijkl");
    await control.abort();
    await pending;
  });

  test("a paused partial does not show up in list()", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    const control = new UploadControl();
    let paused = false;
    const pending = files
      .upload("hidden.bin", "abcdefghijkl", {
        control,
        multipart: { concurrency: 1, partSize: 4 },
        onProgress: ({ loaded }) => {
          if (loaded === 4 && !paused) {
            paused = true;
            control.pause();
          }
        },
      })
      .catch(() => {
        // Abandoned below.
      });
    await delay(0);
    await delay(0);
    const { items } = await files.list();
    expect(items.map((item) => item.key)).not.toContain("hidden.bin.fls-part");
    await control.abort();
    await pending;
  });

  test("abort deletes the partial file", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    const control = new UploadControl();
    let aborting: Promise<void> | undefined;
    const promise = files.upload("a.bin", "abcdefghijkl", {
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
    await expect(fsp.stat(path.join(root, "a.bin.fls-part"))).rejects.toThrow();
  });

  test("uses the default part size when multipart is unset", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    const result = await files.upload("d.bin", "hello", {
      control: new UploadControl(),
    });
    expect(result.size).toBe(5);
    const got = await files.download("d.bin");
    expect(await got.text()).toBe("hello");
  });

  test("resuming a token whose partial was cleaned up restarts from zero", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    // The partial file never existed, so probe reports offset 0 and the upload
    // re-sends every chunk, creating the partial on first write.
    const token: ResumableUploadSession = {
      contentType: "text/plain",
      key: "z.bin",
      provider: "fs",
      tempPath: path.join(root, "z.bin.fls-part"),
    };
    const result = await files.upload("z.bin", "abcdefghijkl", {
      control: UploadControl.from(token),
      multipart: { partSize: 4 },
    });
    expect(result.size).toBe(12);
    const got = await files.download("z.bin");
    expect(await got.text()).toBe("abcdefghijkl");
  });

  test("resuming a token for a different key throws", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    const token: ResumableUploadSession = {
      contentType: "text/plain",
      key: "other.bin",
      provider: "fs",
      tempPath: path.join(root, "other.bin.fls-part"),
    };
    await expect(
      files.upload("mine.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/does not match/u);
  });

  test("resuming a non-fs token throws", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    const token = {
      bucket: "b",
      key: "a.bin",
      provider: "gcs",
      uri: "u",
    } as ResumableUploadSession;
    await expect(
      files.upload("a.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/Cannot resume a gcs/u);
  });

  test("a key ending in the reserved partial suffix is rejected", async () => {
    const root = await makeRoot();
    const files = new Files({ adapter: fsAdapter({ root }) });
    await expect(files.upload("x.fls-part", "data")).rejects.toThrow(
      /reserved/u
    );
  });
});
