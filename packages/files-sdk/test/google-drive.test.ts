import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import { Files, FilesError } from "../src/index.js";

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

const filesListMock = mock((params: unknown) => {
  const p = params as { q?: string; pageSize?: number; pageToken?: string };
  const q = p.q ?? "";
  let matches: FakeFile[] = [...store.values()];
  // Very small subset of Drive's q syntax for the tests:
  // 1) `appProperties has { key='K' and value='V' } and trashed=false`
  // 2) `'<folderId>' in parents and trashed=false`
  const propMatch =
    /appProperties has \{ key='([^']+)' and value='([^']*(?:\\'[^']*)*)' \}/u.exec(
      q
    );
  if (propMatch) {
    const [, wantKey = "", rawValue = ""] = propMatch;
    const wantValue = rawValue.replaceAll("\\'", "'").replaceAll("\\\\", "\\");
    matches = matches.filter(
      (f) => (f.appProperties ?? {})[wantKey] === wantValue
    );
  }
  const parentsMatch = /'([^']+)' in parents/u.exec(q);
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
    const opts = requestOpts as { responseType?: string } | undefined;
    if (opts?.responseType === "stream") {
      return Promise.resolve({
        data: Readable.from(Buffer.from(`body-${file.id}`)),
      });
    }
    // arraybuffer
    const buf = Buffer.from(`body-${file.id}`);
    return Promise.resolve({
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
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
  filesListMock.mockClear();
  filesGetMock.mockClear();
  filesDeleteMock.mockClear();
  filesCopyMock.mockClear();
  permissionsCreateMock.mockClear();
  driveFactoryMock.mockClear();
  globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(
      new Response(null, {
        headers: { Location: "https://upload.example.com/session/abc" },
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

  test("delete is idempotent on missing keys", async () => {
    const files = new Files({ adapter: googleDrive(baseOpts) });
    // Should not throw — no file with that fsdkKey exists.
    await files.delete("ghost.txt");
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
          headers: { Location: "https://upload.example.com/session/xyz" },
          status: 200,
        })
      );
    }) as typeof fetch;

    const files = new Files({ adapter: googleDrive(baseOpts) });
    const out = await files.signedUploadUrl("a.txt", {
      contentType: "text/plain",
      expiresIn: 3600,
      maxSize: 1024,
    });

    expect(out).toEqual({
      headers: { "Content-Type": "text/plain" },
      method: "PUT",
      url: "https://upload.example.com/session/xyz",
    });
    expect(captured?.url).toContain("uploadType=resumable");
    expect(captured?.url).toContain("supportsAllDrives=true");
    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-access-token");
    expect(headers["X-Upload-Content-Type"]).toBe("text/plain");
    expect(headers["X-Upload-Content-Length"]).toBe("1024");
    const body = JSON.parse(captured?.init?.body as string);
    expect(body.name).toBe("a.txt");
    expect(body.parents).toEqual(["rootX"]);
    expect(body.appProperties.fsdkKey).toBe("a.txt");
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
});
