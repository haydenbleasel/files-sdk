import { beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

import type { Client } from "basic-ftp";

import { ftp, mapFtpError } from "../src/ftp/index.js";
import { Files, FilesError } from "../src/index.js";

const STABLE_MTIME = new Date("2024-01-02T03:04:05Z");

// In-memory FTP server backing an injected client. Faithfully models FTP's
// stateful working directory: uploadFrom/downloadTo/size/remove resolve their
// path against the current cwd, and cd/ensureDir change it. The adapter keeps
// cwd at the login dir ("") except briefly during an upload.
let store: Map<string, Buffer>;
let symlinks: Set<string>;

const ftpError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code });

const normalizeDir = (dir: string): string => {
  if (dir === "." || dir === "/" || dir === "") {
    return "";
  }
  let d = dir.startsWith("./") ? dir.slice(2) : dir;
  if (d.startsWith("/")) {
    d = d.slice(1);
  }
  return d.endsWith("/") ? d.slice(0, -1) : d;
};

const parentDir = (path: string): string => {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
};

const makeFakeClient = () => {
  let cwd = "";
  const resolve = (path: string): string => (cwd ? `${cwd}/${path}` : path);
  return {
    cd(path: string) {
      cwd = normalizeDir(path);
      return Promise.resolve({ code: 250 });
    },
    close() {
      // no-op for the injected client
    },
    async downloadTo(dest: Writable, path: string) {
      const entry = store.get(resolve(path));
      if (!entry) {
        throw ftpError(550, "550 File not found");
      }
      dest.end(entry);
      await once(dest, "finish");
      return { code: 226 };
    },
    ensureDir(dir: string) {
      cwd = normalizeDir(dir);
      return Promise.resolve();
    },
    lastMod(path: string) {
      if (!store.has(resolve(path))) {
        return Promise.reject(ftpError(550, "550 not found"));
      }
      return Promise.resolve(STABLE_MTIME);
    },
    list(dir: string) {
      const prefix = normalizeDir(resolve(dir));
      const children = new Map<string, "file" | "dir">();
      for (const key of store.keys()) {
        if (prefix && !key.startsWith(`${prefix}/`)) {
          continue;
        }
        const rest = prefix ? key.slice(prefix.length + 1) : key;
        const slash = rest.indexOf("/");
        children.set(
          slash === -1 ? rest : rest.slice(0, slash),
          slash === -1 ? "file" : "dir"
        );
      }
      const entries = [...children].map(([name, kind]) => ({
        isDirectory: kind === "dir",
        isFile: kind === "file",
        isSymbolicLink: false,
        modifiedAt: STABLE_MTIME,
        name,
        size:
          kind === "file"
            ? (store.get(prefix ? `${prefix}/${name}` : name)?.length ?? 0)
            : 0,
      }));
      for (const link of symlinks) {
        if (parentDir(link) === prefix) {
          entries.push({
            isDirectory: false,
            isFile: false,
            isSymbolicLink: true,
            modifiedAt: STABLE_MTIME,
            name: link.slice(prefix ? prefix.length + 1 : 0),
            size: 0,
          });
        }
      }
      return Promise.resolve(entries);
    },
    pwd() {
      return Promise.resolve(cwd);
    },
    remove(path: string, ignoreErrorCodes?: boolean) {
      const target = resolve(path);
      if (!store.has(target)) {
        if (ignoreErrorCodes) {
          return Promise.resolve({ code: 250 });
        }
        return Promise.reject(ftpError(550, "550 not found"));
      }
      store.delete(target);
      return Promise.resolve({ code: 250 });
    },
    size(path: string) {
      const entry = store.get(resolve(path));
      if (!entry) {
        return Promise.reject(ftpError(550, "550 not found"));
      }
      return Promise.resolve(entry.length);
    },
    async uploadFrom(source: Readable, path: string) {
      const chunks: Buffer[] = [];
      for await (const chunk of source) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      store.set(resolve(path), Buffer.concat(chunks));
      return { code: 226 };
    },
  } as unknown as Client;
};

const newFiles = (opts?: { publicBaseUrl?: string }) =>
  new Files({ adapter: ftp({ client: makeFakeClient(), ...opts }) });

beforeEach(() => {
  store = new Map();
  symlinks = new Set();
});

describe("ftp adapter", () => {
  test("upload then download round-trips text", async () => {
    const files = newFiles();
    const result = await files.upload("docs/a.txt", "hello");
    expect(result.key).toBe("docs/a.txt");
    expect(result.size).toBe(5);
    const got = await files.download("docs/a.txt");
    expect(await got.text()).toBe("hello");
  });

  test("upload to root and a nested path coexist (cwd is restored)", async () => {
    // Regression: a nested upload changes cwd via ensureDir; a following
    // root-level op on the same (reused) connection must still resolve
    // against the login dir.
    const reused = new Files({ adapter: ftp({ client: makeFakeClient() }) });
    await reused.upload("nested/deep/a.txt", "deep");
    await reused.upload("root.txt", "root");
    const rootFile = await reused.download("root.txt");
    expect(await rootFile.text()).toBe("root");
    const nestedFile = await reused.download("nested/deep/a.txt");
    expect(await nestedFile.text()).toBe("deep");
  });

  test("download infers content type from the key extension", async () => {
    const files = newFiles();
    await files.upload("page.html", "<html></html>");
    const got = await files.download("page.html");
    expect(got.type).toBe("text/html; charset=utf-8");
  });

  test("head returns metadata and a lazy body", async () => {
    const files = newFiles();
    await files.upload("a.bin", new Uint8Array([1, 2, 3, 4]));
    const meta = await files.head("a.bin");
    expect(meta.size).toBe(4);
    expect(meta.lastModified).toBe(STABLE_MTIME.getTime());
    expect(new Uint8Array(await meta.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
  });

  test("download streams when as=stream", async () => {
    const files = newFiles();
    await files.upload("s.txt", "streamed");
    const got = await files.download("s.txt", { as: "stream" });
    expect(await got.text()).toBe("streamed");
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

  test("download of a missing key throws NotFound", async () => {
    const files = newFiles();
    await expect(files.download("nope.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("copy duplicates an object", async () => {
    const files = newFiles();
    await files.upload("src.txt", "payload");
    await files.copy("src.txt", "dst/copy.txt");
    const copied = await files.download("dst/copy.txt");
    expect(await copied.text()).toBe("payload");
    expect(await files.exists("src.txt")).toBe(true);
  });

  test("deleteMany removes keys idempotently", async () => {
    const files = newFiles();
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    const result = await files.deleteMany(["a.txt", "b.txt", "missing.txt"]);
    expect(result.deleted).toEqual(["a.txt", "b.txt", "missing.txt"]);
    expect(result.errors).toBeUndefined();
  });

  test("list walks recursively, paginates, and skips symlinks", async () => {
    const files = newFiles();
    await files.upload("a.txt", "1");
    await files.upload("nested/b.txt", "2");
    await files.upload("nested/c.txt", "3");
    symlinks.add("link.txt");

    const first = await files.list({ limit: 2 });
    expect(first.items.map((i) => i.key)).toEqual(["a.txt", "nested/b.txt"]);
    expect(first.cursor).toBe("nested/b.txt");
    const second = await files.list({ cursor: first.cursor, limit: 2 });
    expect(second.items.map((i) => i.key)).toEqual(["nested/c.txt"]);
    expect(second.cursor).toBeUndefined();

    const all = await files.list();
    expect(all.items.map((i) => i.key)).not.toContain("link.txt");
  });

  test("keys that escape the root are rejected", async () => {
    const files = newFiles();
    await expect(files.upload("../escape.txt", "x")).rejects.toMatchObject({
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

  test("url requires publicBaseUrl, else throws", async () => {
    const files = newFiles();
    await expect(files.url("a.txt")).rejects.toThrow(/publicBaseUrl/iu);

    const withBase = newFiles({ publicBaseUrl: "https://cdn.example.com" });
    expect(await withBase.url("dir/a.txt")).toBe(
      "https://cdn.example.com/dir/a.txt"
    );
  });

  test("signedUploadUrl is not supported", async () => {
    const files = newFiles();
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toThrow(/not supported/iu);
  });

  test("missing host throws at construction", () => {
    expect(() => ftp({})).toThrow(/missing connection/iu);
  });

  test("raw exposes the injected client", () => {
    const client = makeFakeClient();
    const adapter = ftp({ client });
    expect(adapter.raw).toBe(client);
    expect(adapter.name).toBe("ftp");
  });
});

describe("mapFtpError", () => {
  test("classifies FTP reply codes", () => {
    expect(mapFtpError(ftpError(550, "not found")).code).toBe("NotFound");
    expect(mapFtpError(ftpError(530, "not logged in")).code).toBe(
      "Unauthorized"
    );
    expect(mapFtpError(ftpError(552, "quota exceeded")).code).toBe("Conflict");
    expect(mapFtpError(ftpError(421, "service unavailable")).code).toBe(
      "Provider"
    );
    // Socket errors arrive with a string code → Provider (retryable).
    expect(mapFtpError({ code: "ECONNREFUSED" }).code).toBe("Provider");
  });

  test("passes through an existing FilesError unchanged", () => {
    const err = new FilesError("Unauthorized", "x");
    expect(mapFtpError(err)).toBe(err);
  });
});
