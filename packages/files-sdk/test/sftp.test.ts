import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import type SftpClient from "ssh2-sftp-client";

import { Files, FilesError, UploadControl } from "../src/index.js";
import type { ResumableUploadSession } from "../src/index.js";

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
    async append(input: unknown, remote: string) {
      const chunk = await collect(input);
      const existing = store.get(remote)?.bytes ?? Buffer.alloc(0);
      store.set(remote, { bytes: Buffer.concat([existing, chunk]) });
      return "ok";
    },
    createReadStream(
      remote: string,
      options?: { start?: number; end?: number }
    ) {
      const entry = store.get(remote);
      if (!entry) {
        throw sftpError(2, "No such file");
      }
      let { bytes } = entry;
      // ssh2 read streams honor inclusive start/end byte offsets.
      if (
        options &&
        (options.start !== undefined || options.end !== undefined)
      ) {
        const start = options.start ?? 0;
        const end = options.end === undefined ? bytes.length - 1 : options.end;
        bytes = bytes.subarray(start, end + 1);
      }
      return Readable.from(bytes);
    },
    delete(remote: string, noErrorOK?: boolean) {
      if (remote.includes("boom")) {
        // Transport failure that noErrorOK doesn't swallow.
        return Promise.reject(
          Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
        );
      }
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

// Connect-per-op path: mock ssh2-sftp-client so a non-injected adapter can
// "connect" without a socket. Each instance is a fresh fake (sharing the
// module-level store) plus connect()/end() to model the connection lifecycle.
let sftpConnectConfigs: unknown[] = [];
let sftpEndCount = 0;
// oxlint-disable-next-line typescript/no-extraneous-class -- the adapter does `new SftpClient()`, so the stub must be constructable.
class MockSftpClient {
  constructor() {
    Object.assign(this, makeFakeClient(), {
      connect: (config: unknown) => {
        sftpConnectConfigs.push(config);
        return Promise.resolve();
      },
      end: () => {
        sftpEndCount += 1;
        return Promise.resolve(true);
      },
    });
  }
}

mock.module("ssh2-sftp-client", () => ({ default: MockSftpClient }));

const { mapSftpError, sftp } = await import("../src/sftp/index.js");

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

  test("move renames natively into a new folder, no body round-trip", async () => {
    const files = newFiles();
    await files.upload("src.txt", "payload");
    await files.move("src.txt", "moved/dest.txt");
    expect(await files.exists("src.txt")).toBe(false);
    const moved = await files.download("moved/dest.txt");
    expect(await moved.text()).toBe("payload");
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

  test("deleteMany removes keys and collects errors", async () => {
    const files = newFiles();
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    const result = await files.delete(["a.txt", "b.txt", "missing.txt"]);
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

describe("sftp connect-per-op (mocked ssh2-sftp-client)", () => {
  beforeEach(() => {
    sftpConnectConfigs = [];
    sftpEndCount = 0;
  });

  test("connects and ends the connection for each operation", async () => {
    const files = new Files({
      adapter: sftp({ host: "sftp.example.com", password: "p", username: "u" }),
    });
    await files.upload("a.txt", "hello");
    const got = await files.download("a.txt");
    expect(await got.text()).toBe("hello");
    expect(sftpConnectConfigs).toHaveLength(2);
    expect(sftpConnectConfigs[0]).toMatchObject({
      host: "sftp.example.com",
      password: "p",
      port: 22,
      username: "u",
    });
    expect(sftpEndCount).toBe(2);
  });

  test("SFTP_PORT env is used in the connect config", async () => {
    process.env.SFTP_PORT = "2222";
    try {
      const files = new Files({
        adapter: sftp({ host: "h", username: "u" }),
      });
      await files.exists("missing.txt");
      expect(sftpConnectConfigs[0]).toMatchObject({ port: 2222 });
    } finally {
      delete process.env.SFTP_PORT;
    }
  });

  test("raw exposes a connect() factory and root when not injected", async () => {
    const adapter = sftp({ host: "h", root: "/srv", username: "u" });
    expect(adapter.root).toBe("/srv");
    const raw = adapter.raw as { connect: () => Promise<unknown> };
    expect(typeof raw.connect).toBe("function");
    expect(await raw.connect()).toBeDefined();
  });

  test("aborting an owned connection ends it once (idempotent release)", async () => {
    // An owned (non-injected) connection releases via end(). Aborting mid-op
    // fires the abort handler's release(); the operation then completes and the
    // finally block releases again — end() must still only run once.
    const files = new Files({
      adapter: sftp({ host: "h", username: "u" }),
    });
    const controller = new AbortController();
    let enqueue!: (chunk: Uint8Array) => void;
    let close!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        enqueue = (chunk) => c.enqueue(chunk);
        close = () => c.close();
      },
    });
    const pending = files.upload("a.txt", stream, {
      signal: controller.signal,
    });
    // Push one chunk and let the upload park in `put`'s stream collection,
    // having already registered its abort listener.
    enqueue(new TextEncoder().encode("partial"));
    await sleep(0);
    // Abort fires the handler's release() (end once); completing the stream
    // then drives the finally block's release() (a no-op via the guard).
    controller.abort();
    close();
    await expect(pending).rejects.toBeDefined();
    await sleep(0);
    expect(sftpEndCount).toBe(1);
  });
});

describe("sftp edge cases (injected client)", () => {
  test("an absolute root resolves the list start directory", () => {
    // Exercises the remoteRoot computation for an absolute root.
    const adapter = sftp({ client: makeFakeClient(), root: "/" });
    expect(adapter.root).toBe("/");
  });

  test("deleteMany with no keys returns early", async () => {
    const files = newFiles();
    const result = await files.delete([]);
    expect(result.deleted).toEqual([]);
    expect(result.errors).toBeUndefined();
  });

  test("deleteMany collects a transport error and stops on stopOnError", async () => {
    const files = newFiles();
    await files.upload("ok.txt", "1");
    const result = await files.delete(["ok.txt", "boom.txt", "after.txt"], {
      stopOnError: true,
    });
    expect(result.deleted).toEqual(["ok.txt"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["boom.txt"]);
  });

  test("stream download of a missing key releases and throws NotFound", async () => {
    const files = newFiles();
    await expect(
      files.download("nope.txt", { as: "stream" })
    ).rejects.toMatchObject({ code: "NotFound" });
  });

  test("stream download wires an abort signal", async () => {
    const files = newFiles();
    await files.upload("s.txt", "streamed");
    const controller = new AbortController();
    const got = await files.download("s.txt", {
      as: "stream",
      signal: controller.signal,
    });
    controller.abort();
    expect(got.size).toBe(8);
  });

  test("uploading a ReadableStream looks up the size via stat", async () => {
    const files = newFiles();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("streamy"));
        c.close();
      },
    });
    const result = await files.upload("s.bin", stream);
    expect(result.size).toBe(7);
  });

  test("head on a directory throws NotFound", async () => {
    // stat reporting a directory is not a file, so head rejects with NotFound.
    const client = {
      end() {
        return Promise.resolve(true);
      },
      stat() {
        return Promise.resolve({
          isDirectory: true,
          isFile: false,
          modifyTime: STABLE_MTIME,
          size: 0,
        });
      },
    } as unknown as SftpClient;
    const files = new Files({ adapter: sftp({ client }) });
    await expect(files.head("a-dir")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("list of a missing root returns an empty page", async () => {
    // A NotFound while walking the root is swallowed: the listing is empty.
    const client = {
      end() {
        return Promise.resolve(true);
      },
      list() {
        return Promise.reject(sftpError(2, "No such file"));
      },
    } as unknown as SftpClient;
    const files = new Files({ adapter: sftp({ client }) });
    const result = await files.list();
    expect(result.items).toEqual([]);
    expect(result.cursor).toBeUndefined();
  });

  test("list rethrows a non-NotFound walk error", async () => {
    const client = {
      end() {
        return Promise.resolve(true);
      },
      list() {
        return Promise.reject(sftpError(3, "permission denied"));
      },
    } as unknown as SftpClient;
    const files = new Files({ adapter: sftp({ client }) });
    await expect(files.list()).rejects.toMatchObject({ code: "Unauthorized" });
  });
});

describe("mapSftpError", () => {
  test("classifies SFTP status codes and messages", () => {
    expect(mapSftpError(sftpError(2, "no such file")).code).toBe("NotFound");
    expect(mapSftpError(sftpError(3, "permission denied")).code).toBe(
      "Unauthorized"
    );
    expect(mapSftpError({ code: "ENOENT" }).code).toBe("NotFound");
    // A codeless error whose message reads like a missing file sniffs to NotFound.
    expect(mapSftpError({ message: "No such file or directory" }).code).toBe(
      "NotFound"
    );
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

describe("sftp resumable uploads", () => {
  test("a retried chunk whose append landed is not appended twice", async () => {
    // The server persists the append but the success reply is lost: the
    // orchestrator retries the chunk. append() writes at EOF, so a blind
    // retry would duplicate the chunk's bytes mid-file — uploadAt must
    // notice the remote size already advanced and skip the write.
    const client = makeFakeClient();
    const realAppend = client.append.bind(client);
    let failNext = true;
    client.append = async (
      input: Parameters<typeof realAppend>[0],
      remote: string
    ) => {
      const result = await realAppend(input, remote);
      if (failNext && remote.includes("lost.bin")) {
        failNext = false;
        throw sftpError(4, "failure: reply lost");
      }
      return result;
    };
    const files = new Files({ adapter: sftp({ client }) });
    const result = await files.upload("lost.bin", "abcdefghijkl", {
      control: new UploadControl(),
      multipart: { concurrency: 1, partSize: 4 },
      retries: 2,
    });
    expect(result.size).toBe(12);
    const got = await files.download("lost.bin");
    expect(await got.text()).toBe("abcdefghijkl");
  });

  test("fresh upload appends chunks and completes", async () => {
    const files = newFiles();
    const control = new UploadControl();
    const result = await files.upload("big.bin", "abcdefghijkl", {
      control,
      multipart: { partSize: 4 },
    });
    expect(result.size).toBe(12);
    expect(control.status).toBe("completed");
    const got = await files.download("big.bin");
    expect(await got.text()).toBe("abcdefghijkl");
    expect(control.session?.provider).toBe("sftp");
  });

  test("resumes from the remote size in a new connection", async () => {
    const writer = newFiles();
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
        // Abandoned — resumed below against the same remote store.
      });
    await sleep(0);
    await sleep(0);
    const token = structuredClone(control.toJSON()) as ResumableUploadSession;
    expect(token.provider).toBe("sftp");

    const resumer = newFiles();
    const result = await resumer.upload("r.bin", "abcdefghijkl", {
      control: UploadControl.from(token),
      multipart: { concurrency: 1, partSize: 4 },
    });
    expect(result.size).toBe(12);
    const got = await resumer.download("r.bin");
    expect(await got.text()).toBe("abcdefghijkl");
    void pending;
  });

  test("abort removes the partial", async () => {
    const files = newFiles();
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
    expect(await files.exists("a.bin")).toBe(false);
  });

  test("metadata is rejected", async () => {
    const files = newFiles();
    await expect(
      files.upload("m.bin", "data", {
        control: new UploadControl(),
        metadata: { a: "b" },
      })
    ).rejects.toThrow(/metadata/u);
  });

  test("cacheControl is rejected", async () => {
    const files = newFiles();
    await expect(
      files.upload("c.bin", "data", {
        cacheControl: "public",
        control: new UploadControl(),
      })
    ).rejects.toThrow(/cacheControl/u);
  });

  test("resuming a non-sftp token throws", async () => {
    const files = newFiles();
    const token = {
      bucket: "b",
      key: "x.bin",
      provider: "gcs",
      uri: "u",
    } as ResumableUploadSession;
    await expect(
      files.upload("x.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/Cannot resume a gcs/u);
  });

  test("resuming a mismatched key throws", async () => {
    const files = newFiles();
    const token: ResumableUploadSession = {
      key: "other.bin",
      provider: "sftp",
    };
    await expect(
      files.upload("x.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/does not match/u);
  });
});
