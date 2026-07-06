import { beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import type { FileStat, WebDAVClient } from "webdav";

import { Files, FilesError } from "../src/index.js";
import { mapWebdavError, webdav } from "../src/webdav/index.js";

const STABLE_MTIME = new Date("2024-01-02T03:04:05Z").getTime();
const STABLE_LASTMOD = new Date(STABLE_MTIME).toUTCString();

interface Entry {
  bytes: Uint8Array;
  type?: string;
}

// In-memory WebDAV store backing an injected client. Keys are the resolved
// remote paths; with the default root "/" a virtual key "docs/a.txt" maps to
// "/docs/a.txt".
let store: Map<string, Entry>;

const webdavError = (status: number, message: string): Error =>
  Object.assign(new Error(message), { status });

const parseRange = (
  headers: Record<string, string> | undefined,
  length: number
): { start: number; end: number } | undefined => {
  const raw = headers?.Range ?? headers?.range;
  if (!raw) {
    return;
  }
  const match = /bytes=(?<start>\d+)-(?<end>\d*)/u.exec(raw);
  if (!match?.groups) {
    return;
  }
  const start = Number(match.groups.start);
  const end = match.groups.end === "" ? length - 1 : Number(match.groups.end);
  return { end, start };
};

const dirPrefix = (dir: string): string =>
  dir === "/" ? "" : dir.replace(/^\//u, "").replace(/\/$/u, "");

const toBytes = (data: unknown): Uint8Array => {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  throw new Error("unexpected put payload");
};

const body = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit;

const makeFakeClient = () =>
  ({
    async copyFile(from: string, to: string) {
      const entry = store.get(from);
      if (!entry) {
        throw webdavError(404, "Not Found");
      }
      store.set(to, { ...entry });
      return await Promise.resolve();
    },
    createDirectory(dir: string) {
      if (dir.includes("throwdir")) {
        // Exercises ensureParentDir's best-effort catch.
        return Promise.reject(webdavError(405, "Method Not Allowed"));
      }
      return Promise.resolve();
    },
    customRequest(remote: string, opts: { headers?: Record<string, string> }) {
      const entry = store.get(remote);
      if (!entry) {
        return Promise.reject(webdavError(404, "Not Found"));
      }
      if (remote.endsWith("empty-body.txt")) {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (remote.endsWith("no-length.txt")) {
        // Streaming body with no Content-Length or Last-Modified header.
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(entry.bytes);
            c.close();
          },
        });
        return Promise.resolve(
          new Response(stream, {
            headers: { "content-type": entry.type ?? "text/plain" },
            status: 200,
          })
        );
      }
      const ignoresRange = remote.endsWith("no-range.txt");
      const range = ignoresRange
        ? undefined
        : parseRange(opts.headers, entry.bytes.length);
      const bytes = range
        ? entry.bytes.subarray(range.start, range.end + 1)
        : entry.bytes;
      return Promise.resolve(
        new Response(body(bytes), {
          headers: {
            "content-length": String(bytes.length),
            "content-type": entry.type ?? "application/octet-stream",
            "last-modified": STABLE_LASTMOD,
          },
          status: range ? 206 : 200,
        })
      );
    },
    deleteFile(remote: string) {
      if (remote.endsWith("boom.txt")) {
        return Promise.reject(webdavError(500, "Internal Server Error"));
      }
      if (!store.has(remote)) {
        return Promise.reject(webdavError(404, "Not Found"));
      }
      store.delete(remote);
      return Promise.resolve();
    },
    getDirectoryContents(dir: string) {
      const prefix = dirPrefix(dir);
      const children = new Map<string, "directory" | "file">();
      for (const key of store.keys()) {
        const rel = key.replace(/^\//u, "");
        if (prefix && !rel.startsWith(`${prefix}/`)) {
          continue;
        }
        const rest = prefix ? rel.slice(prefix.length + 1) : rel;
        const slash = rest.indexOf("/");
        children.set(
          slash === -1 ? rest : rest.slice(0, slash),
          slash === -1 ? "file" : "directory"
        );
      }
      const entries: FileStat[] = [...children].map(([basename, type]) => {
        const remote = prefix ? `/${prefix}/${basename}` : `/${basename}`;
        const entry = store.get(remote);
        return {
          basename,
          etag: null,
          filename: remote,
          lastmod: STABLE_LASTMOD,
          ...(type === "file" && entry?.type && { mime: entry.type }),
          size: type === "file" ? (entry?.bytes.length ?? 0) : 0,
          type,
        };
      });
      return Promise.resolve(entries);
    },
    getFileContents(
      remote: string,
      opts: { details?: boolean; headers?: Record<string, string> }
    ) {
      const entry = store.get(remote);
      if (!entry) {
        return Promise.reject(webdavError(404, "Not Found"));
      }
      const ignoresRange = remote.endsWith("no-range.txt");
      const range = ignoresRange
        ? undefined
        : parseRange(opts.headers, entry.bytes.length);
      const bytes = range
        ? entry.bytes.subarray(range.start, range.end + 1)
        : entry.bytes;
      const rangeRequested = Boolean(
        parseRange(opts.headers, entry.bytes.length)
      );
      if (opts.details) {
        return Promise.resolve({
          data: Buffer.from(bytes),
          headers: {
            "content-type": entry.type ?? "application/octet-stream",
            "last-modified": STABLE_LASTMOD,
          },
          status: rangeRequested && !ignoresRange ? 206 : 200,
          statusText: "OK",
        });
      }
      // Non-details (lazy body): return an ArrayBuffer to exercise that path.
      return Promise.resolve(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        )
      );
    },
    moveFile(from: string, to: string) {
      const entry = store.get(from);
      if (entry) {
        store.set(to, entry);
        store.delete(from);
      }
      return Promise.resolve();
    },
    async putFileContents(
      remote: string,
      data: unknown,
      opts?: { headers?: Record<string, string> }
    ) {
      store.set(remote, {
        bytes: toBytes(data),
        ...(opts?.headers?.["Content-Type"] && {
          type: opts.headers["Content-Type"],
        }),
      });
      return await Promise.resolve(true);
    },
    stat(remote: string) {
      const entry = store.get(remote);
      if (entry) {
        return Promise.resolve<FileStat>({
          basename: remote.split("/").pop() ?? remote,
          etag: null,
          filename: remote,
          lastmod: STABLE_LASTMOD,
          ...(entry.type && { mime: entry.type }),
          size: entry.bytes.length,
          type: "file",
        });
      }
      // A path that's a prefix of stored keys is a directory.
      for (const key of store.keys()) {
        if (key.startsWith(`${remote}/`)) {
          return Promise.resolve<FileStat>({
            basename: remote.split("/").pop() ?? remote,
            etag: null,
            filename: remote,
            lastmod: STABLE_LASTMOD,
            size: 0,
            type: "directory",
          });
        }
      }
      return Promise.reject(webdavError(404, "Not Found"));
    },
  }) as unknown as WebDAVClient;

const newFiles = (opts?: { publicBaseUrl?: string }) =>
  new Files({ adapter: webdav({ client: makeFakeClient(), ...opts }) });

beforeEach(() => {
  store = new Map();
});

describe("webdav adapter", () => {
  test("upload then download round-trips text", async () => {
    const files = newFiles();
    const result = await files.upload("docs/a.txt", "hello");
    expect(result.key).toBe("docs/a.txt");
    expect(result.size).toBe(5);
    const got = await files.download("docs/a.txt");
    expect(await got.text()).toBe("hello");
    expect(got.size).toBe(5);
  });

  test("upload round-trips the content type via the stored header", async () => {
    const files = newFiles();
    await files.upload("report.csv", "a,b,c", { contentType: "text/csv" });
    const got = await files.download("report.csv");
    expect(got.type).toBe("text/csv");
    const meta = await files.head("report.csv");
    expect(meta.type).toBe("text/csv");
  });

  test("head returns metadata and a lazy body", async () => {
    const files = newFiles();
    await files.upload("a.bin", new Uint8Array([1, 2, 3]));
    const meta = await files.head("a.bin");
    expect(meta.size).toBe(3);
    expect(meta.lastModified).toBe(STABLE_MTIME);
    expect(new Uint8Array(await meta.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3])
    );
  });

  test("download streams when as=stream", async () => {
    const files = newFiles();
    await files.upload("s.txt", "streamed");
    const got = await files.download("s.txt", { as: "stream" });
    expect(await got.text()).toBe("streamed");
    expect(got.size).toBe(8);
    expect(got.lastModified).toBe(STABLE_MTIME);
  });

  test("exists reflects presence", async () => {
    const files = newFiles();
    await files.upload("here.txt", "x");
    expect(await files.exists("here.txt")).toBe(true);
    expect(await files.exists("missing.txt")).toBe(false);
  });

  test("delete is idempotent", async () => {
    const files = newFiles();
    await files.upload("gone.txt", "x");
    await files.delete("gone.txt");
    await files.delete("gone.txt");
    expect(await files.exists("gone.txt")).toBe(false);
  });

  test("delete rethrows a non-NotFound error", async () => {
    const files = newFiles();
    await expect(files.delete("boom.txt")).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("download of a missing key throws NotFound", async () => {
    const files = newFiles();
    await expect(files.download("nope.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("copy duplicates an object server-side", async () => {
    const files = newFiles();
    await files.upload("src.txt", "payload");
    await files.copy("src.txt", "dst/copy.txt");
    const copied = await files.download("dst/copy.txt");
    expect(await copied.text()).toBe("payload");
    expect(await files.exists("src.txt")).toBe(true);
  });

  test("copy of a missing source throws NotFound", async () => {
    const files = newFiles();
    await expect(files.copy("missing.txt", "dst.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("move renames natively into a new folder", async () => {
    const files = newFiles();
    await files.upload("src.txt", "payload");
    await files.move("src.txt", "moved/dest.txt");
    expect(await files.exists("src.txt")).toBe(false);
    const moved = await files.download("moved/dest.txt");
    expect(await moved.text()).toBe("payload");
  });

  test("upload to a folder whose MKCOL fails still succeeds", async () => {
    // ensureParentDir swallows the createDirectory error; the PUT lands.
    const files = newFiles();
    const result = await files.upload("throwdir/x.txt", "ok");
    expect(result.size).toBe(2);
    const got = await files.download("throwdir/x.txt");
    expect(await got.text()).toBe("ok");
  });

  test("download honors a bounded byte range (buffer path)", async () => {
    const files = newFiles();
    await files.upload("r.txt", "0123456789");
    const part = await files.download("r.txt", { range: { end: 5, start: 2 } });
    expect(await part.text()).toBe("2345");
    expect(part.size).toBe(4);
  });

  test("download honors an open-ended range as a stream", async () => {
    const files = newFiles();
    await files.upload("r.txt", "0123456789");
    const part = await files.download("r.txt", {
      as: "stream",
      range: { start: 4 },
    });
    expect(await part.text()).toBe("456789");
    expect(part.size).toBe(6);
  });

  test("a server that ignores Range throws (buffer path)", async () => {
    const files = newFiles();
    await files.upload("no-range.txt", "0123456789");
    await expect(
      files.download("no-range.txt", { range: { end: 3, start: 0 } })
    ).rejects.toMatchObject({ code: "Provider" });
  });

  test("a server that ignores Range throws (stream path)", async () => {
    const files = newFiles();
    await files.upload("no-range.txt", "0123456789");
    await expect(
      files.download("no-range.txt", { as: "stream", range: { start: 0 } })
    ).rejects.toMatchObject({ code: "Provider" });
  });

  test("a stream response without a body throws", async () => {
    const files = newFiles();
    await files.upload("empty-body.txt", "x");
    await expect(
      files.download("empty-body.txt", { as: "stream" })
    ).rejects.toMatchObject({ code: "Provider" });
  });

  test("a stream response without content-length reports size 0", async () => {
    const files = newFiles();
    await files.upload("no-length.txt", "hello");
    const got = await files.download("no-length.txt", { as: "stream" });
    expect(got.size).toBe(0);
    expect(got.lastModified).toBeUndefined();
    expect(await got.text()).toBe("hello");
  });

  test("list walks recursively, paginates, and filters by prefix", async () => {
    const files = newFiles();
    await files.upload("a.txt", "1");
    await files.upload("nested/b.txt", "2");
    await files.upload("nested/c.txt", "3");

    const first = await files.list({ limit: 2 });
    expect(first.items.map((i) => i.key)).toEqual(["a.txt", "nested/b.txt"]);
    expect(first.cursor).toBe("nested/b.txt");
    const second = await files.list({ cursor: first.cursor, limit: 2 });
    expect(second.items.map((i) => i.key)).toEqual(["nested/c.txt"]);
    expect(second.cursor).toBeUndefined();

    const docs = await files.list({ prefix: "nested/" });
    expect(docs.items.map((i) => i.key)).toEqual([
      "nested/b.txt",
      "nested/c.txt",
    ]);
    expect(docs.items[0]?.lastModified).toBe(STABLE_MTIME);
  });

  test("a delimiter collapses subdirectories into common prefixes", async () => {
    const files = newFiles();
    await files.upload("a/1.txt", "1");
    await files.upload("a/b/2.txt", "2");
    await files.upload("a/c/3.txt", "3");
    const result = await files.list({ delimiter: "/", prefix: "a/" });
    expect(result.items.map((i) => i.key)).toEqual(["a/1.txt"]);
    expect(result.prefixes).toEqual(["a/b/", "a/c/"]);
  });

  test("keys that escape the root are rejected", async () => {
    const files = newFiles();
    await expect(files.upload("../escape.txt", "x")).rejects.toMatchObject({
      code: "Provider",
    });
    await expect(files.download("../escape.txt")).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("metadata and cacheControl on upload throw", async () => {
    const files = newFiles();
    await expect(
      files.upload("a.txt", "x", { metadata: { k: "v" } })
    ).rejects.toThrow(/metadata/iu);
    await expect(
      files.upload("a.txt", "x", { cacheControl: "max-age=60" })
    ).rejects.toThrow(/cacheControl/iu);
  });

  test("uploading a non-tight typed-array view copies to a clean buffer", async () => {
    const files = newFiles();
    // A subarray whose byteOffset is non-zero exercises the slice path.
    const view = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    const result = await files.upload("view.bin", view);
    expect(result.size).toBe(3);
    const got = await files.download("view.bin");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3])
    );
  });

  test("a lazy body read maps a provider error", async () => {
    const files = newFiles();
    await files.upload("lazy.txt", "hi");
    const meta = await files.head("lazy.txt");
    await files.delete("lazy.txt");
    await expect(meta.arrayBuffer()).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("uploading a ReadableStream buffers and looks up the size", async () => {
    const files = newFiles();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("streamy"));
        c.close();
      },
    });
    const result = await files.upload("s.bin", stream);
    expect(result.size).toBe(7);
    const got = await files.download("s.bin");
    expect(await got.text()).toBe("streamy");
  });

  test("url requires publicBaseUrl, else throws", async () => {
    const files = newFiles();
    await expect(files.url("a.txt")).rejects.toThrow(/publicBaseUrl/iu);

    const withBase = newFiles({ publicBaseUrl: "https://cdn.example.com" });
    expect(await withBase.url("dir/a.txt")).toBe(
      "https://cdn.example.com/dir/a.txt"
    );
    await expect(
      withBase.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toThrow(/responseContentDisposition/iu);
  });

  test("responseContentDisposition without publicBaseUrl throws", async () => {
    const files = newFiles();
    await expect(
      files.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toThrow(/publicBaseUrl/iu);
  });

  test("signedUploadUrl is not supported", async () => {
    const files = newFiles();
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toThrow(/not supported/iu);
  });

  test("raw exposes the injected client and root", () => {
    const client = makeFakeClient();
    const adapter = webdav({ client, root: "/uploads" });
    expect(adapter.raw).toBe(client);
    expect(adapter.name).toBe("webdav");
    expect(adapter.root).toBe("/uploads");
  });
});

describe("webdav edge cases (injected client)", () => {
  test("head on a directory throws NotFound", async () => {
    const files = newFiles();
    await files.upload("dir/child.txt", "x");
    await expect(files.head("dir")).rejects.toMatchObject({ code: "NotFound" });
  });

  test("exists on a directory returns false", async () => {
    const files = newFiles();
    await files.upload("dir/child.txt", "x");
    expect(await files.exists("dir")).toBe(false);
  });

  test("head falls back to the key extension when the server sends no mime", async () => {
    const client = {
      stat() {
        return Promise.resolve({
          basename: "a.json",
          etag: null,
          filename: "/a.json",
          lastmod: "not-a-real-date",
          size: 2,
          type: "file",
        } as FileStat);
      },
    } as unknown as WebDAVClient;
    const files = new Files({ adapter: webdav({ client }) });
    const meta = await files.head("a.json");
    expect(meta.type).toBe("application/json");
    expect(meta.lastModified).toBeUndefined();
  });

  test("list of a missing root returns an empty page", async () => {
    const client = {
      getDirectoryContents() {
        return Promise.reject(webdavError(404, "Not Found"));
      },
    } as unknown as WebDAVClient;
    const files = new Files({ adapter: webdav({ client }) });
    const result = await files.list();
    expect(result.items).toEqual([]);
    expect(result.cursor).toBeUndefined();
  });

  test("list rethrows a non-NotFound walk error", async () => {
    const client = {
      getDirectoryContents() {
        return Promise.reject(webdavError(403, "Forbidden"));
      },
    } as unknown as WebDAVClient;
    const files = new Files({ adapter: webdav({ client }) });
    await expect(files.list()).rejects.toMatchObject({ code: "Unauthorized" });
  });

  test("move maps a provider error", async () => {
    const client = {
      createDirectory: () => Promise.resolve(),
      moveFile: () => Promise.reject(webdavError(507, "Insufficient Storage")),
    } as unknown as WebDAVClient;
    const files = new Files({ adapter: webdav({ client }) });
    await expect(files.move("a.txt", "b/c.txt")).rejects.toMatchObject({
      code: "Provider",
    });
  });
});

describe("webdav connection config", () => {
  test("constructs a client from baseUrl + credentials", () => {
    const adapter = webdav({
      authType: "digest",
      baseUrl: "https://dav.example.com/remote.php/dav",
      password: "p",
      username: "u",
    });
    expect(adapter.raw).toBeDefined();
    expect(adapter.root).toBe("/");
  });

  test("basic auth alias and default root", () => {
    const adapter = webdav({
      authType: "basic",
      baseUrl: "https://dav.example.com",
      username: "u",
    });
    expect(adapter.raw).toBeDefined();
  });

  test("infers auth from credentials when authType is omitted", () => {
    const adapter = webdav({
      baseUrl: "https://dav.example.com",
      password: "p",
      username: "u",
    });
    expect(adapter.raw).toBeDefined();
  });

  test("token auth uses the supplied OAuth token", () => {
    const adapter = webdav({
      authType: "token",
      baseUrl: "https://dav.example.com",
      token: { access_token: "abc", token_type: "Bearer" },
    });
    expect(adapter.raw).toBeDefined();
  });

  test("reads WEBDAV_* env vars", () => {
    process.env.WEBDAV_URL = "https://dav.example.com";
    process.env.WEBDAV_USERNAME = "u";
    process.env.WEBDAV_PASSWORD = "p";
    process.env.WEBDAV_AUTH_TYPE = "digest";
    try {
      const adapter = webdav();
      expect(adapter.raw).toBeDefined();
    } finally {
      delete process.env.WEBDAV_URL;
      delete process.env.WEBDAV_USERNAME;
      delete process.env.WEBDAV_PASSWORD;
      delete process.env.WEBDAV_AUTH_TYPE;
    }
  });

  test("missing connection config throws at construction", () => {
    expect(() => webdav()).toThrow(/missing connection/iu);
  });

  test("an unknown authType throws", () => {
    expect(() =>
      webdav({ authType: "nope" as never, baseUrl: "https://dav.example.com" })
    ).toThrow(/unknown authType/iu);
  });
});

describe("mapWebdavError", () => {
  test("classifies HTTP status codes", () => {
    expect(mapWebdavError(webdavError(404, "x")).code).toBe("NotFound");
    expect(mapWebdavError(webdavError(401, "x")).code).toBe("Unauthorized");
    expect(mapWebdavError(webdavError(403, "x")).code).toBe("Unauthorized");
    expect(mapWebdavError(webdavError(409, "x")).code).toBe("Conflict");
    expect(mapWebdavError(webdavError(500, "x")).code).toBe("Provider");
    // A transport failure with no status falls through to Provider.
    expect(mapWebdavError(new Error("fetch failed")).code).toBe("Provider");
  });

  test("passes through an existing FilesError unchanged", () => {
    const err = new FilesError("NotFound", "x");
    expect(mapWebdavError(err)).toBe(err);
  });
});
