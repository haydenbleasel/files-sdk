import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import type { Client } from "basic-ftp";

import { Files, FilesError, UploadControl } from "../src/index.js";
import type { ResumableUploadSession } from "../src/index.js";

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
  let progress: ((info: { bytesOverall: number }) => void) | undefined;
  const resolve = (path: string): string => (cwd ? `${cwd}/${path}` : path);
  return {
    async appendFrom(source: Readable, path: string) {
      const chunks: Buffer[] = [];
      for await (const chunk of source) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      const existing = store.get(resolve(path)) ?? Buffer.alloc(0);
      store.set(resolve(path), Buffer.concat([existing, ...chunks]));
      return { code: 226 };
    },
    cd(path: string) {
      cwd = normalizeDir(path);
      return Promise.resolve({ code: 250 });
    },
    close() {
      // no-op for the injected client
    },
    async downloadTo(dest: Writable, path: string, startAt?: number) {
      const entry = store.get(resolve(path));
      if (!entry) {
        throw ftpError(550, "550 File not found");
      }
      // `startAt` issues REST: begin the transfer at that byte offset.
      dest.end(startAt ? entry.subarray(startAt) : entry);
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
      if (target.includes("boom")) {
        // Transport failure that ignoreErrorCodes doesn't swallow.
        return Promise.reject(
          Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
        );
      }
      if (!store.has(target)) {
        if (ignoreErrorCodes) {
          return Promise.resolve({ code: 250 });
        }
        return Promise.reject(ftpError(550, "550 not found"));
      }
      store.delete(target);
      return Promise.resolve({ code: 250 });
    },
    rename(from: string, to: string) {
      const src = resolve(from);
      const entry = store.get(src);
      if (!entry) {
        return Promise.reject(ftpError(550, "550 not found"));
      }
      store.delete(src);
      store.set(resolve(to), entry);
      return Promise.resolve({ code: 250 });
    },
    size(path: string) {
      const entry = store.get(resolve(path));
      if (!entry) {
        return Promise.reject(ftpError(550, "550 not found"));
      }
      return Promise.resolve(entry.length);
    },
    trackProgress(handler?: (info: { bytesOverall: number }) => void) {
      progress = handler;
    },
    async uploadFrom(source: Readable, path: string) {
      const chunks: Buffer[] = [];
      let bytesOverall = 0;
      for await (const chunk of source) {
        const buf = Buffer.from(chunk as Buffer);
        chunks.push(buf);
        bytesOverall += buf.length;
        progress?.({ bytesOverall });
      }
      store.set(resolve(path), Buffer.concat(chunks));
      return { code: 226 };
    },
  } as unknown as Client;
};

// Connect-per-op path: mock basic-ftp's Client so a non-injected adapter can
// "connect" without a socket. Each instance is a fresh fake (sharing the
// module-level store) plus access()/close() to model the connection lifecycle.
let ftpAccessConfigs: unknown[] = [];
let ftpCloseCount = 0;
// oxlint-disable-next-line typescript/no-extraneous-class -- the adapter does `new Client()`, so the stub must be constructable.
class MockBasicFtpClient {
  constructor(_timeout?: number) {
    Object.assign(this, makeFakeClient(), {
      access: (config: unknown) => {
        ftpAccessConfigs.push(config);
        return Promise.resolve({ code: 220 });
      },
      close: () => {
        ftpCloseCount += 1;
      },
    });
  }
}

mock.module("basic-ftp", () => ({ Client: MockBasicFtpClient }));

const { ftp, mapFtpError } = await import("../src/ftp/index.js");

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

  test("upload reports progress via trackProgress", async () => {
    const files = newFiles();
    const events: { loaded: number; total?: number }[] = [];
    await files.upload("docs/a.txt", "hello", {
      onProgress: (p) => events.push(p),
    });
    // The buffer is sent as one chunk, so one cumulative report with total.
    expect(events).toEqual([{ loaded: 5, total: 5 }]);
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

  test("move renames natively into a new folder, no body round-trip", async () => {
    const files = newFiles();
    await files.upload("src.txt", "payload");
    await files.move("src.txt", "moved/dest.txt");
    expect(await files.exists("src.txt")).toBe(false);
    const moved = await files.download("moved/dest.txt");
    expect(await moved.text()).toBe("payload");
  });

  test("move of a missing source throws NotFound", async () => {
    const files = newFiles();
    await expect(files.move("nope.txt", "dst.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("download honors an open-ended byte range via REST offset", async () => {
    const files = newFiles();
    await files.upload("r.txt", "0123456789");
    const part = await files.download("r.txt", { range: { start: 4 } });
    expect(await part.text()).toBe("456789");
    expect(part.size).toBe(6);
  });

  test("download honors a bounded byte range (offset + client slice)", async () => {
    const files = newFiles();
    await files.upload("r.txt", "0123456789");
    const part = await files.download("r.txt", { range: { end: 5, start: 2 } });
    expect(await part.text()).toBe("2345");
    expect(part.size).toBe(4);
  });

  test("deleteMany removes keys idempotently", async () => {
    const files = newFiles();
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    const result = await files.delete(["a.txt", "b.txt", "missing.txt"]);
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

describe("ftp connect-per-op (mocked basic-ftp)", () => {
  beforeEach(() => {
    ftpAccessConfigs = [];
    ftpCloseCount = 0;
  });

  test("connects and closes the connection for each operation", async () => {
    const files = new Files({
      adapter: ftp({ host: "ftp.example.com", password: "p", user: "u" }),
    });
    await files.upload("a.txt", "hello");
    const got = await files.download("a.txt");
    expect(await got.text()).toBe("hello");
    expect(ftpAccessConfigs).toHaveLength(2);
    expect(ftpAccessConfigs[0]).toMatchObject({
      host: "ftp.example.com",
      password: "p",
      port: 21,
      user: "u",
    });
    expect(ftpCloseCount).toBe(2);
  });

  test("FTP_SECURE=implicit reaches the access config", async () => {
    process.env.FTP_SECURE = "implicit";
    try {
      const files = new Files({ adapter: ftp({ host: "h", user: "u" }) });
      await files.exists("missing.txt");
      expect(ftpAccessConfigs[0]).toMatchObject({ secure: "implicit" });
    } finally {
      delete process.env.FTP_SECURE;
    }
  });

  test("FTP_SECURE=true reaches the access config", async () => {
    process.env.FTP_SECURE = "true";
    try {
      const files = new Files({ adapter: ftp({ host: "h", user: "u" }) });
      await files.exists("missing.txt");
      expect(ftpAccessConfigs[0]).toMatchObject({ secure: true });
    } finally {
      delete process.env.FTP_SECURE;
    }
  });

  test("raw exposes a connect() factory when not injected", async () => {
    const adapter = ftp({ host: "h", user: "u" });
    const raw = adapter.raw as { connect: () => Promise<unknown> };
    expect(typeof raw.connect).toBe("function");
    expect(await raw.connect()).toBeDefined();
  });

  test("aborting an owned connection closes it once (idempotent release)", async () => {
    // An owned (non-injected) connection releases via close(). Aborting mid-op
    // fires the abort handler's release(); the operation then completes and the
    // finally block releases again — close() must still only run once.
    const files = new Files({ adapter: ftp({ host: "h", user: "u" }) });
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
    // Push one chunk and let the upload park in `uploadFrom`'s `for await`,
    // having already registered its abort listener.
    enqueue(new TextEncoder().encode("partial"));
    await sleep(0);
    // Abort fires the handler's release() (close once); completing the stream
    // then drives the finally block's release() (a no-op via the guard).
    controller.abort();
    close();
    await expect(pending).rejects.toBeDefined();
    await sleep(0);
    expect(ftpCloseCount).toBe(1);
  });
});

describe("ftp edge cases (injected client)", () => {
  test("url rejects responseContentDisposition when publicBaseUrl is set", async () => {
    const files = newFiles({ publicBaseUrl: "https://cdn.example.com" });
    await expect(
      files.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toThrow(/responseContentDisposition/iu);
  });

  test("url with responseContentDisposition but no publicBaseUrl throws", async () => {
    const files = newFiles();
    await expect(
      files.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toThrow(/responseContentDisposition/iu);
  });

  test("deleteMany collects a transport error and continues", async () => {
    const files = newFiles();
    await files.upload("ok.txt", "1");
    await files.upload("after.txt", "2");
    const result = await files.delete(["ok.txt", "boom.txt", "after.txt"]);
    expect(result.deleted).toEqual(["ok.txt", "after.txt"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["boom.txt"]);
  });

  test("deleteMany stops at the first error when stopOnError is set", async () => {
    const files = newFiles();
    await files.upload("ok.txt", "1");
    const result = await files.delete(["ok.txt", "boom.txt", "after.txt"], {
      stopOnError: true,
    });
    expect(result.deleted).toEqual(["ok.txt"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["boom.txt"]);
  });

  test("uploading a ReadableStream looks up the size after transfer", async () => {
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

  test("deleteMany with no keys returns early", async () => {
    const files = newFiles();
    const result = await files.delete([]);
    expect(result.deleted).toEqual([]);
    expect(result.errors).toBeUndefined();
  });

  test("an absolute root is exposed and resolves the list start dir", () => {
    const adapter = ftp({ client: makeFakeClient(), root: "/" });
    expect(adapter.root).toBe("/");
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
    expect(got.size).toBe(8);
    // Aborting runs the registered handler (destroy + release).
    controller.abort();
  });

  test("an absolute root resolves root-level keys and walks the tree", async () => {
    // root "/" exercises splitRemote's idx===0 branch (dir "/"), childListPath's
    // "/" branch during the recursive walk, and remoteRoot's absolute branch.
    const files = new Files({
      adapter: ftp({ client: makeFakeClient(), root: "/" }),
    });
    const result = await files.upload("file.txt", "hi");
    expect(result.size).toBe(2);
    // Pre-seed a nested tree (stored at the resolved relative paths the walk
    // lists) so the recursion descends through a "/"-rooted directory.
    store.set("a.txt", Buffer.from("1"));
    store.set("nested/b.txt", Buffer.from("2"));
    const listed = await files.list();
    expect(listed.items.map((i) => i.key)).toEqual([
      "a.txt",
      "file.txt",
      "nested/b.txt",
    ]);
  });

  test("head omits lastModified when the MDTM probe yields no date", async () => {
    // lastMod resolving to undefined exercises lastModMs's early return, so the
    // StoredFile carries size but no lastModified.
    const client = {
      close() {
        // no-op
      },
      lastMod() {
        return Promise.resolve();
      },
      size() {
        return Promise.resolve(3);
      },
    } as unknown as Client;
    const files = new Files({ adapter: ftp({ client }) });
    const meta = await files.head("a.txt");
    expect(meta.size).toBe(3);
    expect(meta.lastModified).toBeUndefined();
  });

  test("stream download surfaces a transfer error on the returned stream", async () => {
    // size() succeeds (so the StoredFile is built) but the background transfer
    // rejects — the fire-and-forget .catch destroys the stream with that error.
    const client = {
      close() {
        // no-op
      },
      downloadTo() {
        // Reject after a tick so the consumer is reading when the transfer
        // fails — the .catch then destroys the live stream with the error.
        // oxlint-disable-next-line promise/avoid-new -- test needs a deferred rejection.
        return new Promise((_resolve, reject) => {
          setImmediate(() => reject(ftpError(550, "550 transfer aborted")));
        });
      },
      lastMod() {
        return Promise.resolve(STABLE_MTIME);
      },
      size() {
        return Promise.resolve(10);
      },
    } as unknown as Client;
    const files = new Files({ adapter: ftp({ client }) });
    const got = await files.download("a.txt", { as: "stream" });
    expect(got.size).toBe(10);
    const reader = (got.stream() as ReadableStream<Uint8Array>).getReader();
    await expect(reader.read()).rejects.toThrow(/transfer aborted/u);
  });

  test("list of a missing root returns an empty page", async () => {
    // A NotFound while walking the root is swallowed: the listing is empty.
    const client = {
      close() {
        // no-op
      },
      list() {
        return Promise.reject(ftpError(550, "550 not found"));
      },
    } as unknown as Client;
    const files = new Files({ adapter: ftp({ client }) });
    const result = await files.list();
    expect(result.items).toEqual([]);
    expect(result.cursor).toBeUndefined();
  });

  test("list rethrows a non-NotFound walk error", async () => {
    const client = {
      close() {
        // no-op
      },
      list() {
        return Promise.reject(ftpError(530, "530 not logged in"));
      },
    } as unknown as Client;
    const files = new Files({ adapter: ftp({ client }) });
    await expect(files.list()).rejects.toMatchObject({ code: "Unauthorized" });
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

describe("ftp resumable uploads", () => {
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
    expect(control.session?.provider).toBe("ftp");
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
    expect(token.provider).toBe("ftp");

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

  test("a retried chunk whose append landed is not appended twice", async () => {
    // The server persists the append but the success reply is lost: the
    // orchestrator retries the chunk. APPE writes at EOF, so a blind retry
    // would duplicate the chunk's bytes mid-file — uploadAt must notice the
    // remote size already advanced and skip the write.
    const client = makeFakeClient();
    const realAppend = client.appendFrom.bind(client);
    let failNext = true;
    client.appendFrom = async (source: Readable, path: string) => {
      const result = await realAppend(source, path);
      if (failNext && path.includes("lost.bin")) {
        failNext = false;
        throw ftpError(421, "421 reply lost");
      }
      return result;
    };
    const files = new Files({ adapter: ftp({ client }) });
    const result = await files.upload("lost.bin", "abcdefghijkl", {
      control: new UploadControl(),
      multipart: { concurrency: 1, partSize: 4 },
      retries: 2,
    });
    expect(result.size).toBe(12);
    const got = await files.download("lost.bin");
    expect(await got.text()).toBe("abcdefghijkl");
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

  test("resuming a non-ftp token throws", async () => {
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
    const token: ResumableUploadSession = { key: "other.bin", provider: "ftp" };
    await expect(
      files.upload("x.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/does not match/u);
  });
});
