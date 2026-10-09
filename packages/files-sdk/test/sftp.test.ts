import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import type SftpClient from "ssh2-sftp-client";

import { Files, FilesError, UploadControl } from "../src/index.js";
import type {
  OffsetResumableDriver,
  ResumableUploadSession,
} from "../src/index.js";
import { expectDispositionRefusal } from "./disposition-refusal.js";

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
// Directories created through `mkdir`, recorded AFTER ssh2-sftp-client's
// `normalizeRemotePath` treatment (see `normalizeLikeSsh2`), so a `put` into
// a directory the adapter only thinks it created fails like a real server.
let dirs: Set<string>;

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

// ssh2-sftp-client's `normalizeRemotePath` assumes any path starting with
// ".." is "../" (slices 3 chars) and any other path starting with "." is
// "./" (slices 2 chars), then prefixes the realpath of that anchor. The fake's
// realpath of the login dir is "" (keys are stored relative to it), so a
// dot-prefixed relative dir loses its first two characters exactly as it
// would on a real server.
const normalizeLikeSsh2 = (path: string): string => {
  if (path.startsWith("..")) {
    return path.slice(3);
  }
  if (path.startsWith(".")) {
    return path.slice(2);
  }
  return path;
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
    mkdir(dir: string, _recursive?: boolean) {
      // Model the server-side resolution: the ssh2 slice first, then the
      // "./" / "/" anchors collapse onto the login dir like the rest of the
      // fake, so a correctly anchored "./x" and an absolute "/x" both land
      // where a later put resolves them.
      const target = normalizeDir(normalizeLikeSsh2(dir));
      let acc = "";
      for (const segment of target.split("/")) {
        acc = acc ? `${acc}/${segment}` : segment;
        dirs.add(acc);
      }
      return Promise.resolve("ok");
    },
    async put(input: unknown, remote: string) {
      const parent = normalizeDir(parentDir(remote));
      if (parent && !dirs.has(parent)) {
        throw sftpError(2, "No such file");
      }
      store.set(remote, { bytes: await collect(input) });
      return "ok";
    },
    rename(from: string, to: string) {
      const entry = store.get(from);
      if (!entry) {
        return Promise.reject(sftpError(2, "No such file"));
      }
      // Base SFTP v3 rename (OpenSSH): an existing target is refused.
      if (store.has(to)) {
        return Promise.reject(sftpError(4, "Failure"));
      }
      store.set(to, entry);
      store.delete(from);
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
// When set, connect() rejects with this error.
let sftpConnectError: Error | undefined;
// oxlint-disable-next-line typescript/no-extraneous-class -- the adapter does `new SftpClient()`, so the stub must be constructable.
class MockSftpClient {
  constructor() {
    Object.assign(this, makeFakeClient(), {
      connect: (config: unknown) => {
        sftpConnectConfigs.push(config);
        return sftpConnectError
          ? Promise.reject(sftpConnectError)
          : Promise.resolve();
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
  dirs = new Set();
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

  test("head returns plain metadata with no body", async () => {
    const files = newFiles();
    await files.upload("a.bin", new Uint8Array([1, 2, 3]));
    const meta = await files.head("a.bin");
    expect(meta).toEqual({
      contentType: "application/octet-stream",
      key: "a.bin",
      lastModified: STABLE_MTIME,
      size: 3,
    });
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
    expect(result.results).toEqual(["a.txt", "b.txt", "missing.txt"]);
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
      code: "Invalid",
    });
    await expect(files.download("../escape.txt")).rejects.toMatchObject({
      code: "Invalid",
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
    await expect(files.url("a.txt")).rejects.toMatchObject({
      code: "Unsupported",
      message: expect.stringMatching(/publicBaseUrl/iu),
    });

    const withBase = newFiles({ publicBaseUrl: "https://cdn.example.com" });
    expect(await withBase.url("dir/a.txt")).toBe(
      "https://cdn.example.com/dir/a.txt"
    );
    await expect(
      withBase.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toMatchObject({
      code: "Unsupported",
      message: expect.stringMatching(/responseContentDisposition/iu),
    });
    await expectDispositionRefusal(
      withBase.url("a.txt", { responseContentDisposition: "attachment" })
    );
  });

  test("responseContentDisposition without publicBaseUrl throws", async () => {
    const files = newFiles();
    await expect(
      files.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toMatchObject({
      code: "Unsupported",
      message: expect.stringMatching(/publicBaseUrl/iu),
    });
    await expectDispositionRefusal(
      files.url("a.txt", { responseContentDisposition: "attachment" })
    );
  });

  test("signedUploadUrl is not supported", async () => {
    const files = newFiles();
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toMatchObject({
      code: "Unsupported",
      message: expect.stringMatching(/not supported/iu),
    });
  });

  test("declares its capabilities", () => {
    for (const publicBaseUrl of [undefined, "https://cdn.example.com"]) {
      const caps = newFiles(
        publicBaseUrl === undefined ? undefined : { publicBaseUrl }
      ).capabilities;
      expect(caps.cacheControl).toBe(false);
      expect(caps.delimiter).toBe("any");
      expect(caps.metadata).toBe(false);
      expect(caps.rangeRead).toBe(true);
      expect(caps.resumable).toBe(true);
      // copy() round-trips the bytes through the client.
      expect(caps.serverSideCopy).toBe(false);
      expect(caps.signedUpload).toEqual({
        contentType: false,
        maxSize: false,
        supported: false,
      });
      // A `publicBaseUrl` front URL is permanent, not signed.
      expect(caps.signedUrl).toEqual({ expiry: "none", supported: false });
      // ssh2-sftp-client's `put` has no progress hook, so the Files wrapper
      // reports generically.
      expect(caps.uploadProgress).toBe(false);
    }
  });

  test("missing connection config throws at construction", () => {
    expect(() => sftp({ host: "h" })).toThrow(/missing connection/iu);
    expect(() => sftp({ host: "h" })).toThrow(
      expect.objectContaining({ code: "Invalid" })
    );
  });

  test("raw exposes the injected client", () => {
    const client = makeFakeClient();
    const adapter = sftp({ client });
    expect(adapter.raw).toBe(client);
    expect(adapter.name).toBe("sftp");
  });
});

// Record the exact paths the adapter hands to `mkdir` while keeping the
// fake's directory bookkeeping in place.
const spyMkdir = (client: SftpClient): string[] => {
  const calls: string[] = [];
  const real = client.mkdir.bind(client);
  client.mkdir = ((dir: string, recursive?: boolean) => {
    calls.push(dir);
    return real(dir, recursive);
  }) as SftpClient["mkdir"];
  return calls;
};

describe("sftp parent-directory creation", () => {
  test("anchors a dot-prefixed relative dir so ssh2-sftp-client doesn't strip it", async () => {
    // ssh2-sftp-client's normalizeRemotePath slices two characters off any
    // path starting with ".", so a bare ".well-known/acme-challenge" would be
    // created as "ell-known/acme-challenge" and the following put would fail
    // with a bogus NotFound.
    const client = makeFakeClient();
    const mkdirCalls = spyMkdir(client);
    const files = new Files({ adapter: sftp({ client }) });
    await files.upload(".well-known/acme-challenge/token", "ok");
    expect(mkdirCalls).toEqual(["./.well-known/acme-challenge"]);
    expect(dirs.has(".well-known/acme-challenge")).toBe(true);
    const got = await files.download(".well-known/acme-challenge/token");
    expect(await got.text()).toBe("ok");
  });

  test("anchors plain relative dirs with ./ and leaves absolute dirs alone", async () => {
    const client = makeFakeClient();
    const mkdirCalls = spyMkdir(client);
    const relative = new Files({ adapter: sftp({ client }) });
    await relative.upload("docs/a.txt", "a");
    const absolute = new Files({ adapter: sftp({ client, root: "/srv" }) });
    await absolute.upload("docs/b.txt", "b");
    expect(mkdirCalls).toEqual(["./docs", "/srv/docs"]);
  });

  test("leaves an already ./-anchored root untouched", async () => {
    const client = makeFakeClient();
    const mkdirCalls = spyMkdir(client);
    const files = new Files({ adapter: sftp({ client, root: "./sub" }) });
    await files.upload("nested/c.txt", "c");
    expect(mkdirCalls).toEqual(["./sub/nested"]);
    const got = await files.download("nested/c.txt");
    expect(await got.text()).toBe("c");
  });
});

describe("sftp connect-per-op (mocked ssh2-sftp-client)", () => {
  beforeEach(() => {
    sftpConnectConfigs = [];
    sftpEndCount = 0;
    sftpConnectError = undefined;
  });

  test("a rejected login is Unauthorized, not a retryable Provider", async () => {
    // ssh2-sftp-client rejects connect() with a codeless Error; it has to go
    // through the mapper like every operation error.
    sftpConnectError = new Error(
      "getConnection: All configured authentication methods failed"
    );
    const files = new Files({
      adapter: sftp({ host: "h", password: "bad", username: "u" }),
    });
    await expect(files.upload("a.txt", "x")).rejects.toMatchObject({
      code: "Unauthorized",
    });
    await expect(
      files.download("a.txt", { as: "stream" })
    ).rejects.toMatchObject({ code: "Unauthorized" });
  });

  test("a refused connection is a retryable Provider error", async () => {
    sftpConnectError = Object.assign(
      new Error("getConnection: Remote host refused connection"),
      { code: "ECONNREFUSED" }
    );
    const files = new Files({ adapter: sftp({ host: "h", username: "u" }) });
    await expect(files.head("a.txt")).rejects.toMatchObject({
      code: "Provider",
    });
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
    expect(result.results).toEqual([]);
    expect(result.errors).toBeUndefined();
  });

  test("a bulk delete with stopOnError runs per key and stops at the first error", async () => {
    const files = newFiles();
    await files.upload("ok.txt", "1");
    await files.upload("after.txt", "2");
    const result = await files.delete(["ok.txt", "boom.txt", "after.txt"], {
      stopOnError: true,
    });
    expect(result.results).toEqual(["ok.txt"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["boom.txt"]);
    expect(store.has("after.txt")).toBe(true);
  });

  test("deleteMany collects a transport error and stops on stopOnError", async () => {
    const adapter = sftp({ client: makeFakeClient() });
    const files = new Files({ adapter });
    await files.upload("ok.txt", "1");
    await files.upload("after.txt", "2");
    const result = await adapter.deleteMany?.(
      ["ok.txt", "boom.txt", "after.txt"],
      { stopOnError: true }
    );
    expect(result?.results).toEqual(["ok.txt"]);
    expect(result?.errors?.map((e) => e.key)).toEqual(["boom.txt"]);
    expect(store.has("after.txt")).toBe(true);
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

  test("a consumed stream download detaches from a long-lived signal", async () => {
    // A constructor-level signal outlives every call; a listener left on it
    // would pin each download's connection and stream for its lifetime.
    const controller = new AbortController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const { signal } = controller;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, fn: unknown, opts?: unknown) => {
      added.push(fn);
      add(type, fn as EventListener, opts as AddEventListenerOptions);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, fn: unknown) => {
      removed.push(fn);
      remove(type, fn as EventListener);
    }) as typeof signal.removeEventListener;
    const files = new Files({
      adapter: sftp({ client: makeFakeClient() }),
      signal,
    });
    await files.upload("s.txt", "streamed");
    const got = await files.download("s.txt", { as: "stream" });
    expect(await got.text()).toBe("streamed");
    await sleep(0);
    expect(added.length).toBeGreaterThan(0);
    for (const fn of added) {
      expect(removed).toContain(fn);
    }
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

  test("list skips a subdirectory that vanished mid-walk", async () => {
    // A NotFound on a nested directory must not wipe out the whole listing —
    // only a missing root lists as empty.
    const client = makeFakeClient();
    const realList = client.list.bind(client);
    client.list = (dir: string) =>
      dir.endsWith("gone")
        ? Promise.reject(sftpError(2, "No such file"))
        : realList(dir);
    store.set("a.txt", { bytes: Buffer.from("1") });
    store.set("gone/b.txt", { bytes: Buffer.from("2") });
    store.set("kept/c.txt", { bytes: Buffer.from("3") });
    const files = new Files({ adapter: sftp({ client }) });
    const result = await files.list();
    expect(result.items.map((i) => i.key)).toEqual(["a.txt", "kept/c.txt"]);
  });

  test("list rethrows a nested non-NotFound error", async () => {
    const client = makeFakeClient();
    const realList = client.list.bind(client);
    client.list = (dir: string) =>
      dir.endsWith("nested")
        ? Promise.reject(sftpError(3, "permission denied"))
        : realList(dir);
    store.set("nested/b.txt", { bytes: Buffer.from("2") });
    const files = new Files({ adapter: sftp({ client }) });
    await expect(files.list()).rejects.toMatchObject({ code: "Unauthorized" });
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
    expect(mapSftpError({ code: "ERR_BAD_AUTH" }).code).toBe("Unauthorized");
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

  test("a paused upload stages its partial and leaves the existing object intact", async () => {
    const files = newFiles();
    await files.upload("r.bin", "old");
    const control = new UploadControl();
    const { promise: reachedPause, resolve: onPause } =
      Promise.withResolvers<undefined>();
    const pending = files
      .upload("r.bin", "abcdefghijkl", {
        control,
        multipart: { concurrency: 1, partSize: 4 },
        onProgress: ({ loaded }) => {
          if (loaded === 4 && control.status !== "paused") {
            control.pause();
            onPause();
          }
        },
      })
      .catch(() => {
        // Abandoned — resumed below.
      });
    await reachedPause;
    // The key still serves the old bytes; the partial sits beside it and
    // never shows up in list().
    expect(store.get("r.bin")?.bytes.toString()).toBe("old");
    expect(store.get("r.bin.fls-part")?.bytes.toString()).toBe("abcd");
    const listed = await files.list();
    expect(listed.items.map((i) => i.key)).toEqual(["r.bin"]);

    // Completing renames over the existing file, which base SFTP rename
    // refuses: the target is replaced only now.
    const token = structuredClone(control.toJSON()) as ResumableUploadSession;
    const result = await newFiles().upload("r.bin", "abcdefghijkl", {
      control: UploadControl.from(token),
      multipart: { concurrency: 1, partSize: 4 },
    });
    expect(result.size).toBe(12);
    expect(store.get("r.bin")?.bytes.toString()).toBe("abcdefghijkl");
    expect(store.has("r.bin.fls-part")).toBe(false);
    void pending;
  });

  test("abort discards the partial but keeps an existing object", async () => {
    const files = newFiles();
    await files.upload("a.bin", "old");
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
    expect(store.get("a.bin")?.bytes.toString()).toBe("old");
    expect(store.has("a.bin.fls-part")).toBe(false);
  });

  const driverFor = (
    client: SftpClient,
    key: string
  ): OffsetResumableDriver => {
    const adapter = sftp({ client });
    if (!adapter.resumableUpload) {
      throw new Error("sftp adapter lost resumableUpload");
    }
    return adapter.resumableUpload(key, {}) as OffsetResumableDriver;
  };

  test("complete leaves the target alone when the staged partial is gone", async () => {
    store.set("t.bin", { bytes: Buffer.from("old") });
    await expect(
      driverFor(makeFakeClient(), "t.bin").complete([])
    ).rejects.toMatchObject({ code: "NotFound" });
    expect(store.get("t.bin")?.bytes.toString()).toBe("old");
  });

  test("complete surfaces a rename failure that isn't an existing target", async () => {
    const client = makeFakeClient();
    client.rename = () => Promise.reject(sftpError(3, "permission denied"));
    store.set("t.bin.fls-part", { bytes: Buffer.from("new") });
    await expect(driverFor(client, "t.bin").complete([])).rejects.toMatchObject(
      { code: "Unauthorized" }
    );
    expect(store.has("t.bin.fls-part")).toBe(true);
  });

  test("keys ending in the staging suffix are reserved for writes", async () => {
    const files = newFiles();
    await files.upload("src.txt", "s");
    await expect(files.upload("x.fls-part", "x")).rejects.toMatchObject({
      code: "Invalid",
      message: expect.stringMatching(/reserved/u),
    });
    await expect(files.copy("src.txt", "d/y.FLS-PART")).rejects.toThrow(
      /reserved/u
    );
    await expect(files.move("src.txt", "z.fls-part")).rejects.toThrow(
      /reserved/u
    );
    await expect(
      files.upload("r.fls-part", "data", { control: new UploadControl() })
    ).rejects.toMatchObject({
      code: "Invalid",
      message: expect.stringMatching(/reserved/u),
    });
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
    ).rejects.toMatchObject({
      code: "Invalid",
      message: expect.stringMatching(/Cannot resume a gcs/u),
    });
  });

  test("resuming a mismatched key throws", async () => {
    const files = newFiles();
    const token: ResumableUploadSession = {
      key: "other.bin",
      provider: "sftp",
    };
    await expect(
      files.upload("x.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toMatchObject({
      code: "Invalid",
      message: expect.stringMatching(/does not match/u),
    });
  });
});
