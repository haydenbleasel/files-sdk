import { beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import type SftpClient from "ssh2-sftp-client";

import { Files, FilesError } from "../src/index.js";
import { mapSftpError, sftp } from "../src/sftp/index.js";

const STABLE_MTIME = new Date("2024-01-02T03:04:05Z").getTime();

interface Entry {
  bytes: Buffer;
}

// In-memory SFTP server backing an injected client. Keys are stored as their
// resolved remote paths; with the default root "." those equal the virtual
// keys, so the store is keyed by key directly.
let store: Map<string, Entry>;
// Paths that should surface as symlinks ('l') in their parent's listing.
let symlinks: Set<string>;

const sftpError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code });

const parentDir = (path: string): string => {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
};

// Strip the "./" / "/" decoration the adapter's walk adds so the fake can match
// stored keys, which are plain relative paths.
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

const collect = async (input: unknown): Promise<Buffer> => {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of input as Readable) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
};

const makeFakeClient = () =>
  ({
    createReadStream(remote: string) {
      const entry = store.get(remote);
      if (!entry) {
        throw sftpError(2, "No such file");
      }
      return Readable.from(entry.bytes);
    },
    delete(remote: string, noErrorOK?: boolean) {
      if (!store.has(remote) && !noErrorOK) {
        return Promise.reject(sftpError(2, "No such file"));
      }
      store.delete(remote);
      return Promise.resolve("ok");
    },
    end() {
      return Promise.resolve(true);
    },
    exists(remote: string) {
      if (store.has(remote)) {
        return Promise.resolve("-" as const);
      }
      for (const key of store.keys()) {
        if (key.startsWith(`${remote}/`)) {
          return Promise.resolve("d" as const);
        }
      }
      return Promise.resolve(false as const);
    },
    get(remote: string) {
      const entry = store.get(remote);
      if (!entry) {
        return Promise.reject(sftpError(2, "No such file"));
      }
      return Promise.resolve(entry.bytes);
    },
    list(dir: string) {
      const prefix = normalizeDir(dir);
      const children = new Map<string, "-" | "d">();
      for (const key of store.keys()) {
        if (prefix && !key.startsWith(`${prefix}/`)) {
          continue;
        }
        const rest = prefix ? key.slice(prefix.length + 1) : key;
        const slash = rest.indexOf("/");
        children.set(
          slash === -1 ? rest : rest.slice(0, slash),
          slash === -1 ? "-" : "d"
        );
      }
      const entries = [...children].map(([name, type]) => ({
        modifyTime: STABLE_MTIME,
        name,
        size:
          type === "-"
            ? (store.get(prefix ? `${prefix}/${name}` : name)?.bytes.length ??
              0)
            : 0,
        type,
      }));
      for (const link of symlinks) {
        if (parentDir(link) === prefix) {
          const name = link.slice(prefix ? prefix.length + 1 : 0);
          entries.push({
            modifyTime: STABLE_MTIME,
            name,
            size: 0,
            type: "l" as never,
          });
        }
      }
      return Promise.resolve(entries);
    },
    mkdir(_dir: string, _recursive?: boolean) {
      return Promise.resolve("ok");
    },
    async put(input: unknown, remote: string) {
      store.set(remote, { bytes: await collect(input) });
      return "ok";
    },
    rename(from: string, to: string) {
      const entry = store.get(from);
      if (entry) {
        store.set(to, entry);
        store.delete(from);
      }
      return Promise.resolve("ok");
    },
    stat(remote: string) {
      const entry = store.get(remote);
      if (!entry) {
        return Promise.reject(sftpError(2, "No such file"));
      }
      return Promise.resolve({
        isDirectory: false,
        isFile: true,
        modifyTime: STABLE_MTIME,
        size: entry.bytes.length,
      });
    },
  }) as unknown as SftpClient;

const newFiles = (opts?: { publicBaseUrl?: string }) =>
  new Files({
    adapter: sftp({ client: makeFakeClient(), ...opts }),
  });

beforeEach(() => {
  store = new Map();
  symlinks = new Set();
});

describe("sftp adapter", () => {
  test("upload then download round-trips text", async () => {
    const files = newFiles();
    const result = await files.upload("docs/a.txt", "hello");
    expect(result.key).toBe("docs/a.txt");
    expect(result.size).toBe(5);
    const got = await files.download("docs/a.txt");
    expect(await got.text()).toBe("hello");
    expect(got.size).toBe(5);
  });

  test("download infers content type from the key extension", async () => {
    const files = newFiles();
    await files.upload("data.json", "{}");
    const got = await files.download("data.json");
    expect(got.type).toBe("application/json");
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

  test("deleteMany removes keys and collects errors", async () => {
    const files = newFiles();
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    const result = await files.deleteMany(["a.txt", "b.txt", "missing.txt"]);
    // Missing deletes are idempotent, so all three count as deleted.
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
    // The symlink is excluded from the walk.
    expect(all.items.map((i) => i.key)).not.toContain("link.txt");
  });

  test("list filters by prefix", async () => {
    const files = newFiles();
    await files.upload("docs/a.txt", "1");
    await files.upload("images/b.png", "2");
    const docs = await files.list({ prefix: "docs/" });
    expect(docs.items.map((i) => i.key)).toEqual(["docs/a.txt"]);
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

  test("url requires publicBaseUrl, else throws", async () => {
    const files = newFiles();
    await expect(files.url("a.txt")).rejects.toThrow(/publicBaseUrl/iu);

    const withBase = newFiles({ publicBaseUrl: "https://cdn.example.com" });
    expect(await withBase.url("dir/a.txt")).toBe(
      "https://cdn.example.com/dir/a.txt"
    );
    expect(
      await withBase.url("a.txt", { responseContentDisposition: "attachment" })
    ).toContain("response-content-disposition=attachment");
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

  test("missing connection config throws at construction", () => {
    expect(() => sftp({ host: "h" })).toThrow(/missing connection/iu);
  });

  test("raw exposes the injected client", () => {
    const client = makeFakeClient();
    const adapter = sftp({ client });
    expect(adapter.raw).toBe(client);
    expect(adapter.name).toBe("sftp");
  });
});

describe("mapSftpError", () => {
  test("classifies SFTP status codes and messages", () => {
    expect(mapSftpError(sftpError(2, "no such file")).code).toBe("NotFound");
    expect(mapSftpError(sftpError(3, "permission denied")).code).toBe(
      "Unauthorized"
    );
    expect(mapSftpError({ code: "ENOENT" }).code).toBe("NotFound");
    expect(
      mapSftpError({
        message: "All configured authentication methods failed",
      }).code
    ).toBe("Unauthorized");
    expect(mapSftpError({ code: "ECONNREFUSED" }).code).toBe("Provider");
  });

  test("passes through an existing FilesError unchanged", () => {
    const err = new FilesError("NotFound", "x");
    expect(mapSftpError(err)).toBe(err);
  });
});
