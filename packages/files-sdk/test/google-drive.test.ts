import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import { Files, FilesError, UploadControl } from "../src/index.js";
import type { ResumableUploadSession } from "../src/index.js";

const reqOptsOf = (m: { mock: { calls: unknown[][] } }) =>
  m.mock.calls.at(-1)?.[1] as { signal?: AbortSignal } | undefined;

interface FakeFile {
  id: string;
  name: string;
  size?: string;
  mimeType?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
  parents?: string[];
}

const STABLE_MODIFIED = "2024-01-02T03:04:05.000Z";
const STABLE_MODIFIED_MS = new Date(STABLE_MODIFIED).getTime();

let store: Map<string, FakeFile>;
let nextId = 0;
const newId = (): string => {
  nextId += 1;
  return `id-${nextId}`;
};

// Per-call lookup mocks. Tests can override the impl per-test via .mockImpl().
const filesCreateMock = mock(async (params: unknown) => {
  const p = params as {
    requestBody: {
      name: string;
      parents?: string[];
      appProperties?: Record<string, string>;
      mimeType?: string;
    };
    media?: { body: Readable; mimeType?: string };
  };
  // Drain the media so tests can inspect uploaded bytes if needed.
  let size = 0;
  if (p.media?.body) {
    for await (const chunk of p.media.body as AsyncIterable<Buffer>) {
      size += (chunk as Buffer).byteLength ?? 0;
    }
  }
  const id = newId();
  const file: FakeFile = {
    appProperties: p.requestBody.appProperties,
    id,
    md5Checksum: `etag-${id}`,
    mimeType: p.requestBody.mimeType,
    modifiedTime: STABLE_MODIFIED,
    name: p.requestBody.name,
    parents: p.requestBody.parents,
    size: String(size),
  };
  store.set(id, file);
  return { data: file };
});

const filesUpdateMock = mock(async (params: unknown) => {
  const p = params as {
    fileId: string;
    requestBody: {
      name: string;
      parents?: string[];
      appProperties?: Record<string, string>;
      mimeType?: string;
    };
    media?: { body: Readable; mimeType?: string };
  };
  const existing = store.get(p.fileId);
  if (!existing) {
    throw Object.assign(new Error("Not Found"), { code: 404 });
  }
  if (p.requestBody.parents) {
    throw Object.assign(
      new Error(
        "The parents field is not directly writable in update requests."
      ),
      { code: 403 }
    );
  }
  let size = 0;
  if (p.media?.body) {
    for await (const chunk of p.media.body as AsyncIterable<Buffer>) {
      size += (chunk as Buffer).byteLength ?? 0;
    }
  }
  const file: FakeFile = {
    ...existing,
    appProperties: p.requestBody.appProperties ?? existing.appProperties,
    md5Checksum: `etag-${existing.id}-${size}`,
    mimeType: p.requestBody.mimeType ?? existing.mimeType,
    modifiedTime: STABLE_MODIFIED,
    name: p.requestBody.name ?? existing.name,
    size: String(size),
  };
  store.set(existing.id, file);
  return { data: file };
});

const filesListMock = mock((params: unknown) => {
  const p = params as { q?: string; pageSize?: number; pageToken?: string };
  const q = p.q ?? "";
  let matches: FakeFile[] = [...store.values()];
  // Very small subset of Drive's q syntax for the tests:
  // 1) `appProperties has { key='K' and value='V' } and trashed=false`
  // 2) `'<folderId>' in parents and trashed=false`
  const propMatch =
    /appProperties has \{ key='(?<key>[^']+)' and value='(?<value>[^']*(?:\\'[^']*)*)' \}/u.exec(
      q
    );
  if (propMatch) {
    const [, wantKey = "", rawValue = ""] = propMatch;
    const wantValue = rawValue.replaceAll("\\'", "'").replaceAll("\\\\", "\\");
    matches = matches.filter(
      (f) => (f.appProperties ?? {})[wantKey] === wantValue
    );
  }
  const parentsMatch = /'(?<parent>[^']+)' in parents/u.exec(q);
  if (parentsMatch) {
    const [, wantParent = ""] = parentsMatch;
    matches = matches.filter((f) => (f.parents ?? []).includes(wantParent));
  }
  return Promise.resolve({ data: { files: matches } });
});

const filesGetMock = mock((params: unknown, requestOpts?: unknown) => {
  const p = params as { fileId: string; alt?: string };
  const file = store.get(p.fileId);
  if (!file) {
    throw Object.assign(new Error("Not Found"), { code: 404 });
  }
  if (p.alt === "media") {
    const opts = requestOpts as
      | { responseType?: string; headers?: Record<string, string> }
      | undefined;
    const rangeHeader = opts?.headers?.Range;
    const full = Buffer.from(`body-${file.id}`);
    let body = full;
    if (rangeHeader) {
      const m = /bytes=(?<start>\d+)-(?<end>\d*)/u.exec(rangeHeader);
      const start = Number(m?.[1] ?? 0);
      const end = m?.[2] ? Number(m[2]) : full.length - 1;
      body = full.subarray(start, end + 1);
    }
    // A ranged request gets 206 Partial Content, matching real Drive.
    const status = rangeHeader ? 206 : 200;
    if (opts?.responseType === "stream") {
      return Promise.resolve({ data: Readable.from(body), status });
    }
    return Promise.resolve({
      data: body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength
      ),
      status,
    });
  }
  return Promise.resolve({ data: file });
});

const filesDeleteMock = mock((params: unknown) => {
  const p = params as { fileId: string };
  if (!store.has(p.fileId)) {
    throw Object.assign(new Error("Not Found"), { code: 404 });
  }
  store.delete(p.fileId);
  return Promise.resolve({ data: undefined });
});

const filesCopyMock = mock((params: unknown) => {
  const p = params as {
    fileId: string;
    requestBody: {
      name: string;
      parents?: string[];
      appProperties?: Record<string, string>;
    };
  };
  const src = store.get(p.fileId);
  if (!src) {
    throw Object.assign(new Error("Not Found"), { code: 404 });
  }
  const id = newId();
  const file: FakeFile = {
    appProperties: p.requestBody.appProperties,
    id,
    md5Checksum: src.md5Checksum,
    mimeType: src.mimeType,
    modifiedTime: STABLE_MODIFIED,
    name: p.requestBody.name,
    parents: p.requestBody.parents,
    size: src.size,
  };
  store.set(id, file);
  return Promise.resolve({ data: file });
});

const permissionsCreateMock = mock((_params: unknown) =>
  Promise.resolve({ data: { id: "perm-1" } })
);

const fakeDriveClient = {
  files: {
    copy: filesCopyMock,
    create: filesCreateMock,
    delete: filesDeleteMock,
    get: filesGetMock,
    list: filesListMock,
    update: filesUpdateMock,
  },
  permissions: { create: permissionsCreateMock },
};

const driveFactoryMock = mock((_opts?: unknown) => fakeDriveClient);

mock.module("@googleapis/drive", () => ({
  drive: driveFactoryMock,
}));

class FakeAuthClient {
  creds: unknown = null;
  readonly token = "test-access-token";
  setCredentials(creds: unknown): void {
    this.creds = creds;
  }
  getAccessToken(): { token: string } {
    return { token: this.token };
  }
}

mock.module("google-auth-library", () => ({
  GoogleAuth: FakeAuthClient,
  JWT: FakeAuthClient,
  OAuth2Client: FakeAuthClient,
}));

const { googleDrive } = await import("../src/google-drive/index.js");

const baseOpts = {
  credentials: { client_email: "svc@example.iam", private_key: "k" },
  rootFolderId: "rootX",
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  store = new Map();
  nextId = 0;
  filesCreateMock.mockClear();
  filesUpdateMock.mockClear();
  filesListMock.mockClear();
  filesGetMock.mockClear();
  filesDeleteMock.mockClear();
  filesCopyMock.mockClear();
  permissionsCreateMock.mockClear();
  driveFactoryMock.mockClear();
  globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(
      new Response(null, {
        headers: {
          Location:
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc",
        },
        status: 200,
      })
    )) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
};

describe("google-drive adapter", () => {
  test("missing auth throws at construction", () => {
    expect(() => googleDrive({} as never)).toThrow(/missing auth/iu);
  });

  test("env-var fallback uses GOOGLE_DRIVE_CLIENT_EMAIL + GOOGLE_DRIVE_PRIVATE_KEY", () => {
    const prevEmail = process.env.GOOGLE_DRIVE_CLIENT_EMAIL;
    const prevKey = process.env.GOOGLE_DRIVE_PRIVATE_KEY;
    process.env.GOOGLE_DRIVE_CLIENT_EMAIL = "env-svc@example.iam";
    process.env.GOOGLE_DRIVE_PRIVATE_KEY = "env-key";
    try {
      const adapter = googleDrive();
      expect(adapter.rootFolderId).toBe("root");
    } finally {
      restoreEnv("GOOGLE_DRIVE_CLIENT_EMAIL", prevEmail);
      restoreEnv("GOOGLE_DRIVE_PRIVATE_KEY", prevKey);
    }
  });

  test("env-var fallback uses GOOGLE_DRIVE_KEY_FILE", () => {
    const prevFile = process.env.GOOGLE_DRIVE_KEY_FILE;
    process.env.GOOGLE_DRIVE_KEY_FILE = "/tmp/sa.json";
    try {
      expect(() => googleDrive()).not.toThrow();
    } finally {
      restoreEnv("GOOGLE_DRIVE_KEY_FILE", prevFile);
    }
  });

  test("env GOOGLE_DRIVE_ID populates driveId and rootFolderId by default", () => {
    const prevEmail = process.env.GOOGLE_DRIVE_CLIENT_EMAIL;
    const prevKey = process.env.GOOGLE_DRIVE_PRIVATE_KEY;
    const prevId = process.env.GOOGLE_DRIVE_ID;
    process.env.GOOGLE_DRIVE_CLIENT_EMAIL = "env-svc@example.iam";
    process.env.GOOGLE_DRIVE_PRIVATE_KEY = "env-key";
    process.env.GOOGLE_DRIVE_ID = "shared-drive-123";
    try {
      const adapter = googleDrive();
      expect(adapter.rootFolderId).toBe("shared-drive-123");
    } finally {
      restoreEnv("GOOGLE_DRIVE_CLIENT_EMAIL", prevEmail);
      restoreEnv("GOOGLE_DRIVE_PRIVATE_KEY", prevKey);
      restoreEnv("GOOGLE_DRIVE_ID", prevId);
    }
  });

  test("env GOOGLE_DRIVE_ROOT_FOLDER_ID overrides the driveId fallback", () => {
    const prevEmail = process.env.GOOGLE_DRIVE_CLIENT_EMAIL;
    const prevKey = process.env.GOOGLE_DRIVE_PRIVATE_KEY;
    const prevId = process.env.GOOGLE_DRIVE_ID;
    const prevRoot = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    process.env.GOOGLE_DRIVE_CLIENT_EMAIL = "env-svc@example.iam";
    process.env.GOOGLE_DRIVE_PRIVATE_KEY = "env-key";
    process.env.GOOGLE_DRIVE_ID = "shared-drive-123";
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = "folder-abc";
    try {
      const adapter = googleDrive();
      expect(adapter.rootFolderId).toBe("folder-abc");
    } finally {
      restoreEnv("GOOGLE_DRIVE_CLIENT_EMAIL", prevEmail);
      restoreEnv("GOOGLE_DRIVE_PRIVATE_KEY", prevKey);
      restoreEnv("GOOGLE_DRIVE_ID", prevId);
      restoreEnv("GOOGLE_DRIVE_ROOT_FOLDER_ID", prevRoot);
    }
  });

  test("upload sets fsdkKey, returns size+etag, caches fileId", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    const result = await files.upload("docs/a.txt", "hello", {
      contentType: "text/plain",
    });
    expect(result.key).toBe("docs/a.txt");
    expect(result.size).toBe(5);
    expect(result.etag).toBe("etag-id-1");
    expect(filesCreateMock).toHaveBeenCalledTimes(1);
    const createArgs = filesCreateMock.mock.calls[0]?.[0] as {
      requestBody: { appProperties: Record<string, string>; name: string };
    };
    expect(createArgs.requestBody.appProperties.fsdkKey).toBe("docs/a.txt");
    expect(createArgs.requestBody.appProperties.fsdkContentType).toBe(
      "text/plain"
    );
    expect(createArgs.requestBody.name).toBe("a.txt");

    // Subsequent head() should hit cache: zero extra files.list calls.
    const before = filesListMock.mock.calls.length;
    await files.head("docs/a.txt");
    expect(filesListMock.mock.calls.length).toBe(before);
  });

  test("upload rejects reserved fsdk* metadata keys", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await expect(
      files.upload("a.txt", "hi", { metadata: { fsdkInjected: "bad" } })
    ).rejects.toThrow(/reserved/iu);
  });

  test("upload with publicByDefault grants anyone-reader permission", async () => {
    const files = new Files({
      adapter: googleDrive({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hello");
    expect(permissionsCreateMock).toHaveBeenCalledTimes(1);
    const args = permissionsCreateMock.mock.calls[0]?.[0] as {
      requestBody: { role: string; type: string };
    };
    expect(args.requestBody).toEqual({ role: "reader", type: "anyone" });
  });

  test("download (buffer) returns bytes and metadata", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("a.txt", "hi");
    const f = await files.download("a.txt");
    expect(await f.text()).toBe("body-id-1");
    expect(f.etag).toBe("etag-id-1");
    expect(f.lastModified).toBe(STABLE_MODIFIED_MS);
  });

  test("download (stream) returns a web stream", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("a.txt", "hi");
    const f = await files.download("a.txt", { as: "stream" });
    const reader = f.stream().getReader();
    let total = 0;
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- sequentially draining a stream reader
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
      }
    }
    expect(total).toBe("body-id-1".length);
  });

  test("download (buffer) with a range sends a Range header and returns the slice", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("a.txt", "0123456789");
    const f = await files.download("a.txt", { range: { end: 3, start: 0 } });
    // Synthetic body is `body-<id>`; bytes 0..3 inclusive → "body".
    expect(await f.text()).toBe("body");
    expect(f.size).toBe(4);
  });

  test("download (stream) with a range reports the slice length from metadata", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("a.txt", "0123456789");
    const f = await files.download("a.txt", {
      as: "stream",
      range: { start: 7 },
    });
    // Metadata size is 10 (the uploaded bytes), so bytes 7..EOF → 3.
    expect(f.size).toBe(3);
  });

  test("head returns metadata with lazy body factory", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("a.txt", "hi", { contentType: "text/plain" });
    const f = await files.head("a.txt");
    expect(f.type).toBe("text/plain");
    expect(f.etag).toBe("etag-id-1");
    // Body accessor lazily issues alt=media.
    const before = filesGetMock.mock.calls.length;
    expect(await f.text()).toBe("body-id-1");
    expect(filesGetMock.mock.calls.length).toBeGreaterThan(before);
  });

  test("exists returns true for present keys and false for missing keys", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("a.txt", "hi");
    await expect(files.exists("a.txt")).resolves.toBe(true);
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("list filters to files with fsdkKey and applies prefix client-side", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("docs/a.txt", "x");
    await files.upload("docs/b.txt", "x");
    await files.upload("other/c.txt", "x");
    // Inject a foreign Drive file (no fsdkKey, same root) — should not show up.
    store.set("foreign", {
      appProperties: {},
      id: "foreign",
      mimeType: "text/plain",
      name: "foreign.txt",
      parents: ["rootX"],
      size: "1",
    });

    const all = await files.list();
    expect(all.items.map((i) => i.key).toSorted()).toEqual([
      "docs/a.txt",
      "docs/b.txt",
      "other/c.txt",
    ]);

    const docs = await files.list({ prefix: "docs/" });
    expect(docs.items.map((i) => i.key).toSorted()).toEqual([
      "docs/a.txt",
      "docs/b.txt",
    ]);
  });

  test("list with a delimiter synthesizes common prefixes from fsdkKeys", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("photos/cover.jpg", "x");
    await files.upload("photos/2023/a.jpg", "x");
    await files.upload("photos/2024/b.jpg", "x");
    const { items, prefixes } = await files.list({
      delimiter: "/",
      prefix: "photos/",
    });
    expect(items.map((i) => i.key)).toEqual(["photos/cover.jpg"]);
    expect(prefixes).toEqual(["photos/2023/", "photos/2024/"]);
  });

  test("copy creates new file with the new fsdkKey and caches id", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("from.txt", "hi");
    await files.copy("from.txt", "to.txt");
    expect(filesCopyMock).toHaveBeenCalledTimes(1);
    const args = filesCopyMock.mock.calls[0]?.[0] as {
      requestBody: { appProperties: Record<string, string>; name: string };
    };
    expect(args.requestBody.appProperties.fsdkKey).toBe("to.txt");
    expect(args.requestBody.name).toBe("to.txt");

    // 'to.txt' should now resolve from cache (no extra files.list).
    const before = filesListMock.mock.calls.length;
    await files.head("to.txt");
    expect(filesListMock.mock.calls.length).toBe(before);
  });

  test("upload to an existing key updates it in place (no duplicate)", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("over.txt", "v1");
    await files.upload("over.txt", "v2-longer");

    expect(filesCreateMock).toHaveBeenCalledTimes(1);
    expect(filesUpdateMock).toHaveBeenCalledTimes(1);
    // The update body must not write `parents` (a create-only field).
    const updateArgs = filesUpdateMock.mock.calls[0]?.[0] as {
      requestBody: { parents?: string[] };
    };
    expect(updateArgs.requestBody.parents).toBeUndefined();
    // Exactly one Drive file carries the virtual key.
    const carriers = [...store.values()].filter(
      (f) => f.appProperties?.fsdkKey === "over.txt"
    );
    expect(carriers).toHaveLength(1);
    // A fresh instance (cold id cache) resolves the key cleanly — this is
    // what used to throw Conflict once a duplicate existed.
    const fresh = new Files({ adapter: googleDrive(baseOpts) });
    await expect(fresh.head("over.txt")).resolves.toMatchObject({
      key: "over.txt",
      size: "v2-longer".length,
    });
  });

  test("copy onto an existing key replaces it (no duplicate)", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("src.txt", "hi");
    await files.upload("dst.txt", "old");
    await files.copy("src.txt", "dst.txt");

    const carriers = [...store.values()].filter(
      (f) => f.appProperties?.fsdkKey === "dst.txt"
    );
    expect(carriers).toHaveLength(1);
    const fresh = new Files({ adapter: googleDrive(baseOpts) });
    const body = await fresh.download("dst.txt").then((f) => f.text());
    expect(body).toBe(`body-${carriers[0]?.id}`);
  });

  test("delete is idempotent on missing keys", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    // Should not throw — no file with that fsdkKey exists.
    await files.delete("ghost.txt");
  });

  test("delete removes an existing file and evicts its cached fileId", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("a.txt", "hi");
    expect(filesDeleteMock).not.toHaveBeenCalled();
    await files.delete("a.txt");
    expect(filesDeleteMock).toHaveBeenCalledTimes(1);
    // The file is gone — head() now re-resolves via files.list and 404s.
    const err = await files.head("a.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("NotFound");
  });

  test("resolve fileId is scoped to rootFolderId", async () => {
    store.set("outside-1", {
      appProperties: { fsdkKey: "secret.txt" },
      id: "outside-1",
      md5Checksum: "etag-outside-1",
      mimeType: "text/plain",
      modifiedTime: STABLE_MODIFIED,
      name: "secret.txt",
      parents: ["outsideRoot"],
      size: "6",
    });
    const files = new Files({ adapter: googleDrive(baseOpts) });

    const missing = await files
      .head("secret.txt")
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(FilesError);
    expect((missing as FilesError).code).toBe("NotFound");

    const [listArgs] = filesListMock.mock.calls.at(-1) ?? [];
    expect((listArgs as { q?: string }).q).toContain("'rootX' in parents");

    await files.upload("scoped.txt", "inside");
    store.set("outside-2", {
      appProperties: { fsdkKey: "scoped.txt" },
      id: "outside-2",
      md5Checksum: "etag-outside-2",
      mimeType: "text/plain",
      modifiedTime: STABLE_MODIFIED,
      name: "scoped.txt",
      parents: ["outsideRoot"],
      size: "7",
    });
    const fresh = new Files({ adapter: googleDrive(baseOpts) });
    await expect(fresh.head("scoped.txt")).resolves.toMatchObject({
      key: "scoped.txt",
    });
  });

  test("resolve fileId throws Conflict when two files share a virtual key", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("dup.txt", "hi");
    // Inject a duplicate via the store directly.
    const dup: FakeFile = {
      appProperties: { fsdkKey: "dup.txt" },
      id: "dup-2",
      md5Checksum: "etag-dup-2",
      mimeType: "text/plain",
      modifiedTime: STABLE_MODIFIED,
      name: "dup.txt",
      parents: ["rootX"],
      size: "2",
    };
    store.set("dup-2", dup);
    // Bust the cache so the next resolve actually queries.
    // Removes one entry + cache; second remains.
    await files.delete("dup.txt");
    await expect(files.head("dup.txt")).resolves.toBeDefined();
    // Re-add duplicates and bust cache again.
    store.set("dup-3", { ...dup, id: "dup-3" });
    // Force a fresh resolve: instantiate a new adapter (cache is per-instance).
    const fresh = new Files({ adapter: googleDrive(baseOpts) });
    const err = await fresh.head("dup.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("Conflict");
  });

  test("url throws when publicByDefault is false", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("a.txt", "hi");
    await expect(files.url("a.txt")).rejects.toThrow(/publicByDefault/u);
  });

  test("url throws on responseContentDisposition (always unsupported)", async () => {
    const files = new Files({
      adapter: googleDrive({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hi");
    await expect(
      files.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toThrow(/responseContentDisposition/u);
  });

  test("url returns drive.google.com URL when publicByDefault is true", async () => {
    const files = new Files({
      adapter: googleDrive({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hi");
    const url = await files.url("a.txt");
    expect(url).toBe("https://drive.google.com/uc?export=download&id=id-1");
  });

  test("signedUploadUrl POSTs resumable initiation and returns Location URL", async () => {
    let captured: { url: string; init: RequestInit | undefined } | undefined;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      captured = {
        init,
        url: typeof input === "string" ? input : input.toString(),
      };
      return Promise.resolve(
        new Response(null, {
          headers: {
            Location:
              "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=xyz",
          },
          status: 200,
        })
      );
    }) as typeof fetch;

    const files = new Files({ adapter: googleDrive(baseOpts) });
    const out = await files.signedUploadUrl("a.txt", {
      contentType: "text/plain",
      expiresIn: 3600,
    });

    expect(out).toEqual({
      headers: { "Content-Type": "text/plain" },
      method: "PUT",
      url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=xyz",
    });
    expect(captured?.url).toContain("uploadType=resumable");
    expect(captured?.url).toContain("supportsAllDrives=true");
    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-access-token");
    expect(headers["X-Upload-Content-Type"]).toBe("text/plain");
    expect(headers["X-Upload-Content-Length"]).toBeUndefined();
    const body = JSON.parse(captured?.init?.body as string);
    expect(body.name).toBe("a.txt");
    expect(body.parents).toEqual(["rootX"]);
    expect(body.appProperties.fsdkKey).toBe("a.txt");
  });

  test("signedUploadUrl PATCHes the existing file id when the key exists", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("a.txt", "old");

    let captured: { url: string; init: RequestInit | undefined } | undefined;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      captured = {
        init,
        url: typeof input === "string" ? input : input.toString(),
      };
      return Promise.resolve(
        new Response(null, {
          headers: {
            Location:
              "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=upd",
          },
          status: 200,
        })
      );
    }) as typeof fetch;

    const out = await files.signedUploadUrl("a.txt", { expiresIn: 3600 });
    expect(out.url).toBe(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=upd"
    );
    expect(captured?.init?.method).toBe("PATCH");
    expect(captured?.url).toContain("/files/id-1?uploadType=resumable");
    const body = JSON.parse(captured?.init?.body as string);
    // `parents` is create-only and must be absent on an update session.
    expect(body.parents).toBeUndefined();
    expect(body.appProperties.fsdkKey).toBe("a.txt");
  });

  test("signedUploadUrl rejects maxSize because Drive sessions cannot enforce it", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60, maxSize: 1024 })
    ).rejects.toThrow(/maxSize.*minSize|content-length-range/iu);
  });

  test("signedUploadUrl rejects minSize because Drive sessions cannot enforce it", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60, minSize: 1 })
    ).rejects.toThrow(/maxSize.*minSize|content-length-range/iu);
  });

  test("signedUploadUrl throws when adapter constructed with `client` escape hatch", async () => {
    const files = new Files({
      adapter: googleDrive({
        client: fakeDriveClient as never,
        rootFolderId: "rootX",
      }),
    });
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toThrow(/escape hatch|client/iu);
  });

  test("signedUploadUrl maps a non-OK resumable initiation to a provider error", async () => {
    // The non-OK branch reads the response body for context but guards it
    // with `.catch(() => "")`; force `text()` to reject so that fallback
    // arrow fires and the resulting error still classifies by status.
    globalThis.fetch = (() =>
      Promise.resolve({
        headers: new Headers(),
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: () => Promise.reject(new Error("body stream errored")),
      })) as unknown as typeof fetch;
    const files = new Files({ adapter: googleDrive(baseOpts) });
    const err = await files
      .signedUploadUrl("a.txt", { expiresIn: 60 })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("Unauthorized");
    expect((err as FilesError).message).toMatch(
      /resumable session initiation/u
    );
  });

  test("signedUploadUrl throws when the resumable response has no Location header", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(null, { headers: {}, status: 200 })
      )) as unknown as typeof fetch;
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toThrow(/missing Location header/u);
  });

  test("download propagates 404 as NotFound", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    const err = await files
      .download("nope.txt")
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("NotFound");
  });

  // Drive returns its HTTP status on `error.code` (number); each Set in
  // classifyDriveError maps a slice of those statuses to a FilesErrorCode.
  // Force `files.get` to throw with each representative status and verify
  // the mapped code so every branch in classifyDriveError is exercised.
  test.each([
    [404, "NotFound"],
    [401, "Unauthorized"],
    [403, "Unauthorized"],
    [409, "Conflict"],
    [412, "Conflict"],
    [500, "Provider"],
    [undefined, "Provider"],
  ] as const)(
    "mapDriveError classifies status %p as %s",
    async (status, expectedCode) => {
      const files = new Files({ adapter: googleDrive(baseOpts) });
      // Upload first so the fileId cache is warm — the next head() goes
      // straight to files.get without hitting files.list (which would
      // re-throw a different error path).
      await files.upload("a.txt", "hi");
      filesGetMock.mockImplementationOnce(() => {
        const err = new Error(`status ${String(status)}`);
        if (status !== undefined) {
          Object.assign(err, { code: status });
        }
        throw err;
      });
      const err = await files.head("a.txt").catch((error: unknown) => error);
      expect(err).toBeInstanceOf(FilesError);
      expect((err as FilesError).code).toBe(expectedCode);
    }
  );

  test("mapDriveError prefers response.status over top-level code", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("a.txt", "hi");
    filesGetMock.mockImplementationOnce(() => {
      // Some googleapis wrappers surface the HTTP status under
      // `error.response.status` instead of `error.code` — make sure that
      // fallback path classifies correctly too.
      throw Object.assign(new Error("forbidden"), {
        response: {
          data: { error: { message: "Permission denied on file" } },
          status: 403,
        },
      });
    });
    const err = await files.head("a.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("Unauthorized");
    expect((err as FilesError).message).toBe("Permission denied on file");
  });

  describe("signal forwarding", () => {
    test("upload forwards the signal to files.create", async () => {
      const files = new Files({ adapter: googleDrive(baseOpts) });
      const { signal } = new AbortController();
      await files.upload("a.txt", "hello", { signal });
      expect(reqOptsOf(filesCreateMock)?.signal).toBe(signal);
    });

    test("upload forwards the signal to permissions.create when public", async () => {
      const files = new Files({
        adapter: googleDrive({ ...baseOpts, publicByDefault: true }),
      });
      const { signal } = new AbortController();
      await files.upload("a.txt", "hello", { signal });
      expect(reqOptsOf(permissionsCreateMock)?.signal).toBe(signal);
    });

    test("download forwards the signal to files.get (meta + media)", async () => {
      const seed = new Files({ adapter: googleDrive(baseOpts) });
      await seed.upload("a.txt", "hello");
      filesGetMock.mockClear();
      const { signal } = new AbortController();
      await new Files({ adapter: googleDrive(baseOpts) }).download("a.txt", {
        signal,
      });
      expect(filesGetMock.mock.calls.length).toBeGreaterThan(0);
      expect(
        filesGetMock.mock.calls.every(
          (c) =>
            (c[1] as { signal?: AbortSignal } | undefined)?.signal === signal
        )
      ).toBe(true);
    });

    test("head forwards the signal to files.get", async () => {
      const files = new Files({ adapter: googleDrive(baseOpts) });
      await files.upload("a.txt", "hello");
      filesGetMock.mockClear();
      const { signal } = new AbortController();
      await files.head("a.txt", { signal });
      expect(reqOptsOf(filesGetMock)?.signal).toBe(signal);
    });

    test("delete forwards the signal to files.delete", async () => {
      const files = new Files({ adapter: googleDrive(baseOpts) });
      await files.upload("a.txt", "hello");
      const { signal } = new AbortController();
      await files.delete("a.txt", { signal });
      expect(reqOptsOf(filesDeleteMock)?.signal).toBe(signal);
    });

    test("copy forwards the signal to files.copy", async () => {
      const files = new Files({ adapter: googleDrive(baseOpts) });
      await files.upload("a.txt", "hello");
      const { signal } = new AbortController();
      await files.copy("a.txt", "b.txt", { signal });
      expect(reqOptsOf(filesCopyMock)?.signal).toBe(signal);
    });

    test("list forwards the signal to files.list", async () => {
      const files = new Files({ adapter: googleDrive(baseOpts) });
      const { signal } = new AbortController();
      await files.list({ signal });
      expect(reqOptsOf(filesListMock)?.signal).toBe(signal);
    });

    test("signedUploadUrl forwards the signal to the resumable fetch", async () => {
      let seenSignal: AbortSignal | undefined;
      globalThis.fetch = ((
        _input: string | URL | Request,
        init?: RequestInit
      ) => {
        seenSignal = init?.signal ?? undefined;
        return Promise.resolve(
          new Response(null, {
            headers: {
              Location:
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc",
            },
            status: 200,
          })
        );
      }) as typeof fetch;
      const files = new Files({ adapter: googleDrive(baseOpts) });
      const { signal } = new AbortController();
      await files.signedUploadUrl("a.txt", { expiresIn: 60, signal });
      expect(seenSignal).toBe(signal);
    });
  });
});

describe("google-drive resumable uploads", () => {
  const CHUNK = 256 * 1024;
  const driveResult = () =>
    Response.json({
      id: "file-1",
      md5Checksum: "md5abc",
      mimeType: "application/octet-stream",
      modifiedTime: "2024-01-02T03:04:05.000Z",
      size: String(CHUNK + 10),
    });

  test("fresh upload opens a session, PUTs chunks, and finalizes", async () => {
    const ranges: string[] = [];
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        return Promise.resolve(
          new Response(null, {
            headers: {
              Location:
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc",
            },
            status: 200,
          })
        );
      }
      const range =
        ((init?.headers ?? {}) as Record<string, string>)["Content-Range"] ??
        "";
      ranges.push(range);
      return Promise.resolve(
        range.endsWith("/*")
          ? new Response(null, {
              headers: { Range: `bytes=0-${CHUNK - 1}` },
              status: 308,
            })
          : driveResult()
      );
    }) as typeof fetch;

    const files = new Files({ adapter: googleDrive(baseOpts) });
    const control = new UploadControl();
    const result = await files.upload("big.bin", new Uint8Array(CHUNK + 10), {
      control,
      multipart: { partSize: CHUNK },
    });
    expect(result.etag).toBe("md5abc");
    expect(result.size).toBe(CHUNK + 10);
    expect(control.status).toBe("completed");
    expect(control.session?.provider).toBe("google-drive");
    expect(ranges[0]).toBe(`bytes 0-${CHUNK - 1}/*`);
  });

  test("resumable upload to an existing key PATCHes its file id", async () => {
    const inits: { method: string; url: string; body?: string }[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" || method === "PATCH") {
        inits.push({
          body: init?.body as string,
          method,
          url: typeof input === "string" ? input : input.toString(),
        });
        return Promise.resolve(
          new Response(null, {
            headers: {
              Location:
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=upd",
            },
            status: 200,
          })
        );
      }
      const range =
        ((init?.headers ?? {}) as Record<string, string>)["Content-Range"] ??
        "";
      return Promise.resolve(
        range.endsWith("/*")
          ? new Response(null, {
              headers: { Range: `bytes=0-${CHUNK - 1}` },
              status: 308,
            })
          : driveResult()
      );
    }) as typeof fetch;

    const files = new Files({ adapter: googleDrive(baseOpts) });
    await files.upload("big.bin", "old-small");
    const result = await files.upload("big.bin", new Uint8Array(CHUNK + 10), {
      control: new UploadControl(),
      multipart: { partSize: CHUNK },
    });
    expect(result.size).toBe(CHUNK + 10);
    expect(inits).toHaveLength(1);
    expect(inits[0]?.method).toBe("PATCH");
    expect(inits[0]?.url).toContain("/files/id-1?uploadType=resumable");
    // `parents` is create-only and must be absent on an update session.
    expect(JSON.parse(inits[0]?.body ?? "{}").parents).toBeUndefined();
    // Still exactly one Drive file carries the key.
    const carriers = [...store.values()].filter(
      (f) => f.appProperties?.fsdkKey === "big.bin"
    );
    expect(carriers).toHaveLength(1);
  });

  test("resume reads the session offset, then sends the rest", async () => {
    const puts: string[] = [];
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      const range =
        ((init?.headers ?? {}) as Record<string, string>)["Content-Range"] ??
        "";
      if (range === "bytes */*") {
        return Promise.resolve(
          new Response(null, {
            headers: { Range: `bytes=0-${CHUNK - 1}` },
            status: 308,
          })
        );
      }
      puts.push(range);
      return Promise.resolve(driveResult());
    }) as typeof fetch;

    const files = new Files({ adapter: googleDrive(baseOpts) });
    const token: ResumableUploadSession = {
      key: "big.bin",
      provider: "google-drive",
      uri: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc",
    };
    const result = await files.upload("big.bin", new Uint8Array(CHUNK + 10), {
      control: UploadControl.from(token),
      multipart: { partSize: CHUNK },
    });
    expect(result.size).toBe(CHUNK + 10);
    expect(puts).toEqual([`bytes ${CHUNK}-${CHUNK + 9}/${CHUNK + 10}`]);
  });

  test("resuming an untrusted session uri is rejected", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(driveResult())) as unknown as typeof fetch;

    const files = new Files({ adapter: googleDrive(baseOpts) });
    const token: ResumableUploadSession = {
      key: "big.bin",
      provider: "google-drive",
      uri: "https://attacker.example/session/abc",
    };
    await expect(
      files.upload("big.bin", new Uint8Array(CHUNK + 10), {
        control: UploadControl.from(token),
        multipart: { partSize: CHUNK },
      })
    ).rejects.toThrow(/not trusted/u);
  });

  test("abort discards the session via DELETE", async () => {
    const methods: string[] = [];
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") {
        return Promise.resolve(
          new Response(null, {
            headers: {
              Location:
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc",
            },
            status: 200,
          })
        );
      }
      if (method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      const range =
        ((init?.headers ?? {}) as Record<string, string>)["Content-Range"] ??
        "";
      return Promise.resolve(
        range.endsWith("/*")
          ? new Response(null, {
              headers: { Range: `bytes=0-${CHUNK - 1}` },
              status: 308,
            })
          : driveResult()
      );
    }) as typeof fetch;

    const files = new Files({ adapter: googleDrive(baseOpts) });
    const control = new UploadControl();
    let aborting: Promise<void> | undefined;
    const promise = files.upload("ab.bin", new Uint8Array(CHUNK * 2 + 5), {
      control,
      multipart: { partSize: CHUNK },
      onProgress: ({ loaded }) => {
        if (loaded >= CHUNK && !aborting) {
          aborting = control.abort();
        }
      },
    });
    await expect(promise).rejects.toMatchObject({ aborted: true });
    await aborting;
    expect(methods).toContain("DELETE");
  });

  test("a failed session initiation is wrapped", async () => {
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        return Promise.resolve(new Response("nope", { status: 500 }));
      }
      return Promise.resolve(driveResult());
    }) as typeof fetch;
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await expect(
      files.upload("x.bin", "data", { control: new UploadControl() })
    ).rejects.toBeInstanceOf(FilesError);
  });

  test("a failed chunk PUT throws", async () => {
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      if ((init?.method ?? "GET") === "POST") {
        return Promise.resolve(
          new Response(null, {
            headers: {
              Location:
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc",
            },
            status: 200,
          })
        );
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    }) as typeof fetch;
    const files = new Files({ adapter: googleDrive(baseOpts) });
    await expect(
      files.upload("x.bin", new Uint8Array(CHUNK + 10), {
        control: new UploadControl(),
        multipart: { partSize: CHUNK },
        retries: 0,
      })
    ).rejects.toThrow(/chunk upload failed|upload failed/u);
  });

  test("resuming a non-google-drive token throws", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
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
    const files = new Files({ adapter: googleDrive(baseOpts) });
    const token: ResumableUploadSession = {
      key: "other.bin",
      provider: "google-drive",
      uri: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc",
    };
    await expect(
      files.upload("x.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/does not match/u);
  });
});
