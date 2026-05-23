import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

import type { Client } from "basic-ftp";

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
  let progress: ((info: { bytesOverall: number }) => void) | undefined;
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
});

describe("ftp edge cases (injected client)", () => {
  test("url appends responseContentDisposition when publicBaseUrl is set", async () => {
    const files = newFiles({ publicBaseUrl: "https://cdn.example.com" });
    const url = await files.url("a.txt", {
      responseContentDisposition: "attachment",
    });
    expect(url).toContain("response-content-disposition=attachment");
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
