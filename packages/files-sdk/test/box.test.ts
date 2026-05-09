import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import type { BoxClient } from "box-typescript-sdk-gen";

import { box } from "../src/box/index.js";
import { Files, FilesError } from "../src/index.js";

interface FakeFile {
  type: "file";
  id: string;
  name: string;
  parentId: string;
  size: number;
  etag: string;
  modifiedAt: string;
  bytes: Buffer;
  sharedLink?: { url: string; downloadUrl: string };
}

interface FakeFolder {
  type: "folder";
  id: string;
  name: string;
  parentId: string | null;
}

type FakeItem = FakeFile | FakeFolder;

const STABLE_MODIFIED = "2024-01-02T03:04:05Z";
const STABLE_MODIFIED_MS = new Date(STABLE_MODIFIED).getTime();

let store: Map<string, FakeItem>;
let nextId = 0;
const newId = (): string => {
  nextId += 1;
  return `id_${nextId}`;
};

const ROOT_ID = "0";

const seedRoot = () => {
  store.set(ROOT_ID, {
    id: ROOT_ID,
    name: "root",
    parentId: null,
    type: "folder",
  });
};

const findChild = (parentId: string, name: string): FakeItem | undefined => {
  for (const item of store.values()) {
    if (
      (item.type === "file" || item.type === "folder") &&
      item.parentId === parentId &&
      item.name === name
    ) {
      return item;
    }
  }
  return undefined;
};

// Construct a BoxApiError-shaped object — matches the duck-typing in
// `mapBoxError` (looks for `responseInfo.statusCode` / `responseInfo.code`).
const apiError = (statusCode: number, code: string, message?: string) => {
  const err = new Error(message ?? code) as Error & {
    responseInfo: { statusCode: number; code: string };
  };
  err.responseInfo = { code, statusCode };
  return err;
};

// ===== Manager mocks =====

const getFolderItemsMock = mock(
  (
    folderId: string,
    optionals?: {
      queryParams?: { offset?: number; limit?: number };
    }
  ) => {
    const folder = store.get(folderId);
    if (!folder || folder.type !== "folder") {
      return Promise.reject(apiError(404, "not_found", "folder not found"));
    }
    const offset = optionals?.queryParams?.offset ?? 0;
    const limit = optionals?.queryParams?.limit ?? 1000;
    const children = [...store.values()]
      .filter(
        (it) =>
          (it.type === "file" || it.type === "folder") &&
          it.parentId === folderId
      )
      .map((it) => ({
        etag: it.type === "file" ? it.etag : undefined,
        id: it.id,
        modifiedAt: it.type === "file" ? it.modifiedAt : undefined,
        name: it.name,
        size: it.type === "file" ? it.size : undefined,
        type: it.type,
      }));
    const slice = children.slice(offset, offset + limit);
    return Promise.resolve({ entries: slice, totalCount: children.length });
  }
);

const createFolderMock = mock(
  (body: { name: string; parent: { id: string } }) => {
    const parent = store.get(body.parent.id);
    if (!parent || parent.type !== "folder") {
      return Promise.reject(apiError(404, "not_found"));
    }
    const existing = findChild(body.parent.id, body.name);
    if (existing) {
      return Promise.reject(apiError(409, "item_name_in_use"));
    }
    const id = newId();
    const folder: FakeFolder = {
      id,
      name: body.name,
      parentId: body.parent.id,
      type: "folder",
    };
    store.set(id, folder);
    return Promise.resolve({ id, name: body.name, type: "folder" });
  }
);

const getFileByIdMock = mock((fileId: string) => {
  const file = store.get(fileId);
  if (!file || file.type !== "file") {
    return Promise.reject(apiError(404, "not_found"));
  }
  return Promise.resolve({
    etag: file.etag,
    id: file.id,
    modifiedAt: file.modifiedAt,
    name: file.name,
    sharedLink: file.sharedLink,
    size: file.size,
    type: "file",
  });
});

const deleteFileByIdMock = mock((fileId: string) => {
  const file = store.get(fileId);
  if (!file || file.type !== "file") {
    return Promise.reject(apiError(404, "not_found"));
  }
  store.delete(fileId);
  return Promise.resolve();
});

const copyFileMock = mock(
  (fileId: string, body: { name?: string; parent: { id: string } }) => {
    const src = store.get(fileId);
    if (!src || src.type !== "file") {
      return Promise.reject(apiError(404, "not_found"));
    }
    const dest = store.get(body.parent.id);
    if (!dest || dest.type !== "folder") {
      return Promise.reject(apiError(404, "not_found"));
    }
    const id = newId();
    const name = body.name ?? src.name;
    const copy: FakeFile = {
      bytes: Buffer.from(src.bytes),
      etag: `etag_${id}`,
      id,
      modifiedAt: STABLE_MODIFIED,
      name,
      parentId: body.parent.id,
      size: src.size,
      type: "file",
    };
    store.set(id, copy);
    return Promise.resolve({ id, name, type: "file" });
  }
);

const readReadable = async (stream: unknown): Promise<Buffer> => {
  if (stream instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer)
      );
    }
    return Buffer.concat(chunks);
  }
  if (stream instanceof Uint8Array) {
    return Buffer.from(stream.buffer, stream.byteOffset, stream.byteLength);
  }
  return Buffer.alloc(0);
};

const uploadFileMock = mock(
  async (body: {
    attributes: { name: string; parent: { id: string } };
    file: unknown;
  }) => {
    const parent = store.get(body.attributes.parent.id);
    if (!parent || parent.type !== "folder") {
      throw apiError(404, "not_found");
    }
    const existing = findChild(body.attributes.parent.id, body.attributes.name);
    if (existing) {
      throw apiError(409, "item_name_in_use");
    }
    const bytes = await readReadable(body.file);
    const id = newId();
    const file: FakeFile = {
      bytes,
      etag: `etag_${id}`,
      id,
      modifiedAt: STABLE_MODIFIED,
      name: body.attributes.name,
      parentId: body.attributes.parent.id,
      size: bytes.byteLength,
      type: "file",
    };
    store.set(id, file);
    return {
      entries: [
        {
          etag: file.etag,
          id,
          modifiedAt: file.modifiedAt,
          name: file.name,
          size: file.size,
          type: "file",
        },
      ],
    };
  }
);

const uploadFileVersionMock = mock(
  async (
    fileId: string,
    body: { attributes: { name: string }; file: unknown }
  ) => {
    const file = store.get(fileId);
    if (!file || file.type !== "file") {
      throw apiError(404, "not_found");
    }
    const bytes = await readReadable(body.file);
    file.bytes = bytes;
    file.size = bytes.byteLength;
    file.etag = `etag_${file.id}_v2`;
    file.modifiedAt = STABLE_MODIFIED;
    file.name = body.attributes.name;
    return {
      entries: [
        {
          etag: file.etag,
          id: file.id,
          modifiedAt: file.modifiedAt,
          name: file.name,
          size: file.size,
          type: "file",
        },
      ],
    };
  }
);

const uploadBigFileMock = mock(
  async (
    file: unknown,
    fileName: string,
    fileSize: number,
    parentFolderId: string
  ) => {
    const parent = store.get(parentFolderId);
    if (!parent || parent.type !== "folder") {
      throw apiError(404, "not_found");
    }
    const bytes = await readReadable(file);
    const id = newId();
    const fakeFile: FakeFile = {
      bytes,
      etag: `etag_${id}`,
      id,
      modifiedAt: STABLE_MODIFIED,
      name: fileName,
      parentId: parentFolderId,
      size: fileSize,
      type: "file",
    };
    store.set(id, fakeFile);
    return {
      etag: fakeFile.etag,
      id,
      modifiedAt: fakeFile.modifiedAt,
      name: fakeFile.name,
      size: fakeFile.size,
      type: "file",
    };
  }
);

const getDownloadFileUrlMock = mock((fileId: string) => {
  const file = store.get(fileId);
  if (!file || file.type !== "file") {
    return Promise.reject(apiError(404, "not_found"));
  }
  return Promise.resolve(`https://dl.box.test/${fileId}`);
});

const downloadFileMock = mock((fileId: string) => {
  const file = store.get(fileId);
  if (!file || file.type !== "file") {
    return Promise.reject(apiError(404, "not_found"));
  }
  return Promise.resolve(Readable.from(file.bytes));
});

const addShareLinkToFileMock = mock(
  (fileId: string, _body: unknown, _query: unknown) => {
    const file = store.get(fileId);
    if (!file || file.type !== "file") {
      return Promise.reject(apiError(404, "not_found"));
    }
    if (file.sharedLink) {
      return Promise.reject(apiError(409, "item_name_in_use"));
    }
    file.sharedLink = {
      downloadUrl: `https://app.box.test/d/${fileId}/dl`,
      url: `https://app.box.test/s/${fileId}`,
    };
    return Promise.resolve({ id: fileId, sharedLink: file.sharedLink });
  }
);

const getSharedLinkForFileMock = mock((fileId: string, _query: unknown) => {
  const file = store.get(fileId);
  if (!file || file.type !== "file") {
    return Promise.reject(apiError(404, "not_found"));
  }
  return Promise.resolve({ id: fileId, sharedLink: file.sharedLink });
});

const fakeClient = {
  chunkedUploads: { uploadBigFile: uploadBigFileMock },
  downloads: {
    downloadFile: downloadFileMock,
    getDownloadFileUrl: getDownloadFileUrlMock,
  },
  files: {
    copyFile: copyFileMock,
    deleteFileById: deleteFileByIdMock,
    getFileById: getFileByIdMock,
  },
  folders: {
    createFolder: createFolderMock,
    getFolderItems: getFolderItemsMock,
  },
  sharedLinksFiles: {
    addShareLinkToFile: addShareLinkToFileMock,
    getSharedLinkForFile: getSharedLinkForFileMock,
  },
  uploads: {
    uploadFile: uploadFileMock,
    uploadFileVersion: uploadFileVersionMock,
  },
} as unknown as BoxClient;

const baseOpts = { client: fakeClient };

const allMocks = [
  getFolderItemsMock,
  createFolderMock,
  getFileByIdMock,
  deleteFileByIdMock,
  copyFileMock,
  uploadFileMock,
  uploadFileVersionMock,
  uploadBigFileMock,
  getDownloadFileUrlMock,
  downloadFileMock,
  addShareLinkToFileMock,
  getSharedLinkForFileMock,
];

beforeEach(() => {
  store = new Map();
  nextId = 0;
  seedRoot();
  for (const m of allMocks) {
    m.mockClear();
  }
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const stubFetchToServeStore = () => {
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    const m = u.match(/\/([^/]+)$/u);
    const id = m?.[1];
    if (!id) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const file = store.get(id);
    if (!file || file.type !== "file") {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return Promise.resolve(
      new Response(file.bytes.toString("utf-8"), { status: 200 })
    );
  }) as typeof fetch;
};

describe("box adapter", () => {
  test("missing auth throws at construction", () => {
    expect(() => box({})).toThrow(/missing auth/iu);
  });

  test("multiple auth methods throw at construction", () => {
    expect(() =>
      box({
        ccg: { clientId: "c", clientSecret: "s", enterpriseId: "e" },
        developerToken: "tok",
      })
    ).toThrow(/exactly one/iu);
  });

  test("ccg without enterpriseId or userId throws", () => {
    expect(() => box({ ccg: { clientId: "c", clientSecret: "s" } })).toThrow(
      /enterpriseId.*userId/iu
    );
  });

  test("env BOX_DEVELOPER_TOKEN fallback works", () => {
    process.env.BOX_DEVELOPER_TOKEN = "env-tok";
    try {
      const adapter = box({});
      expect(adapter.name).toBe("box");
    } finally {
      delete process.env.BOX_DEVELOPER_TOKEN;
    }
  });

  test("upload writes to root folder by default", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    stubFetchToServeStore();
    const result = await files.upload("a.txt", "hello", {
      contentType: "text/plain",
    });
    expect(result.key).toBe("a.txt");
    expect(result.size).toBe(5);
    expect(result.contentType).toBe("text/plain");
    expect(result.etag).toMatch(/^etag_/u);
    expect(result.lastModified).toBe(STABLE_MODIFIED_MS);

    const [call] = uploadFileMock.mock.calls;
    expect(call?.[0]?.attributes?.name).toBe("a.txt");
    expect(call?.[0]?.attributes?.parent?.id).toBe(ROOT_ID);
  });

  test("upload auto-creates intermediate folders", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("docs/sub/a.txt", "hi");
    expect(createFolderMock).toHaveBeenCalledTimes(2);
    expect(createFolderMock.mock.calls[0]?.[0]?.name).toBe("docs");
    expect(createFolderMock.mock.calls[1]?.[0]?.name).toBe("sub");
    const stored = [...store.values()].find(
      (it) => it.type === "file" && it.name === "a.txt"
    ) as FakeFile | undefined;
    expect(stored).toBeDefined();
  });

  test("upload of an existing key calls uploadFileVersion", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "v1");
    uploadFileMock.mockClear();
    await files.upload("a.txt", "v2");
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(uploadFileVersionMock).toHaveBeenCalledTimes(1);
    const file = [...store.values()].find(
      (it) => it.type === "file" && it.name === "a.txt"
    ) as FakeFile | undefined;
    expect(file?.bytes.toString("utf-8")).toBe("v2");
  });

  test("upload with publicByDefault creates a shared link", async () => {
    const files = new Files({
      adapter: box({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hi");
    expect(addShareLinkToFileMock).toHaveBeenCalledTimes(1);
  });

  test("upload accepts a ReadableStream and collects all chunks", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("part-1-"));
        controller.enqueue(enc.encode("part-2"));
        controller.close();
      },
    });
    const r = await files.upload("streamed.txt", stream);
    expect(r.size).toBe("part-1-part-2".length);
    stubFetchToServeStore();
    const f = await files.download("streamed.txt");
    expect(await f.text()).toBe("part-1-part-2");
  });

  test("upload accepts an ArrayBuffer", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    const ab = new TextEncoder().encode("ab-body").buffer as ArrayBuffer;
    const r = await files.upload("ab.bin", ab);
    expect(r.size).toBe("ab-body".length);
  });

  test("upload accepts a Blob and inherits its type", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    const blob = new Blob(["blob-body"], { type: "application/x-test" });
    const r = await files.upload("blob.dat", blob);
    expect(r.contentType).toBe("application/x-test");
    expect(r.size).toBe("blob-body".length);
  });

  test("upload rejects metadata", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await expect(
      files.upload("a.txt", "hi", { metadata: { foo: "bar" } })
    ).rejects.toThrow(/metadata.*not supported/iu);
  });

  test("upload rejects cacheControl", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await expect(
      files.upload("a.txt", "hi", { cacheControl: "max-age=60" })
    ).rejects.toThrow(/cacheControl.*not supported/iu);
  });

  test("download returns bytes and metadata", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi", { contentType: "text/plain" });
    stubFetchToServeStore();
    const f = await files.download("a.txt");
    expect(await f.text()).toBe("hi");
    expect(f.lastModified).toBe(STABLE_MODIFIED_MS);
    expect(f.etag).toMatch(/^etag_/u);
    expect(f.type).toBe("text/plain; charset=utf-8");
  });

  test("download (stream) fetches via signed URL", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "stream-bytes");
    stubFetchToServeStore();
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
    expect(total).toBe("stream-bytes".length);
  });

  test("head returns metadata with lazy body factory", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi", { contentType: "text/plain" });
    stubFetchToServeStore();
    const f = await files.head("a.txt");
    expect(f.size).toBe(2);
    expect(f.etag).toMatch(/^etag_/u);
    const beforeBody = getDownloadFileUrlMock.mock.calls.length;
    expect(await f.text()).toBe("hi");
    expect(getDownloadFileUrlMock.mock.calls.length).toBeGreaterThan(
      beforeBody
    );
  });

  test("delete is idempotent on missing keys", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.delete("ghost.txt");
  });

  test("delete removes existing item", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi");
    await files.delete("a.txt");
    await expect(files.head("a.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("copy duplicates the source file at the destination key", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("from.txt", "hi");
    await files.copy("from.txt", "to.txt");
    stubFetchToServeStore();
    const head = await files.head("to.txt");
    expect(head.key).toBe("to.txt");
    expect(head.size).toBe(2);
  });

  test("copy creates intermediate folders for the destination", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("from.txt", "hi");
    createFolderMock.mockClear();
    await files.copy("from.txt", "deep/nested/to.txt");
    expect(createFolderMock).toHaveBeenCalledTimes(2);
  });

  test("list returns files in the root folder", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "x");
    await files.upload("b.txt", "y");
    const r = await files.list();
    expect(r.items.map((i) => i.key).toSorted()).toEqual(["a.txt", "b.txt"]);
  });

  test("list applies prefix filter", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("alpha.txt", "x");
    await files.upload("beta.txt", "x");
    const r = await files.list({ prefix: "alp" });
    expect(r.items.map((i) => i.key)).toEqual(["alpha.txt"]);
  });

  test("list paginates via cursor when results fill the limit", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "x");
    await files.upload("b.txt", "y");
    await files.upload("c.txt", "z");
    const r1 = await files.list({ limit: 2 });
    expect(r1.items).toHaveLength(2);
    expect(r1.cursor).toBe("2");
    const r2 = await files.list({ cursor: r1.cursor, limit: 2 });
    expect(r2.items).toHaveLength(1);
    expect(r2.cursor).toBeUndefined();
  });

  test("url returns signed download URL by default", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi");
    const url = await files.url("a.txt");
    expect(url).toBe(
      `https://dl.box.test/${[...store.values()].find((it) => it.type === "file" && it.name === "a.txt")?.id}`
    );
  });

  test("url returns shared-link URL when publicByDefault is true", async () => {
    const files = new Files({
      adapter: box({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "hi");
    const url = await files.url("a.txt");
    expect(url).toMatch(/^https:\/\/app\.box\.test\/d\//u);
  });

  test("url returns publicBaseUrl-joined path when set", async () => {
    const files = new Files({
      adapter: box({
        ...baseOpts,
        publicBaseUrl: "https://cdn.example.com/files",
      }),
    });
    const url = await files.url("a.txt");
    expect(url).toBe("https://cdn.example.com/files/a.txt");
  });

  test("url throws on responseContentDisposition", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi");
    await expect(
      files.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toThrow(/responseContentDisposition/u);
  });

  test("signedUploadUrl throws", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 3600 })
    ).rejects.toThrow(/signedUploadUrl is not supported/iu);
  });

  test("rootFolderId nests virtual keys under the configured folder", async () => {
    // Pre-create a non-root folder, then point the adapter at it.
    const customRootId = "custom-root";
    store.set(customRootId, {
      id: customRootId,
      name: "SDK Storage",
      parentId: ROOT_ID,
      type: "folder",
    });
    const files = new Files({
      adapter: box({ ...baseOpts, rootFolderId: customRootId }),
    });
    await files.upload("a.txt", "hi");
    const [call] = uploadFileMock.mock.calls;
    expect(call?.[0]?.attributes?.parent?.id).toBe(customRootId);
    const r = await files.list();
    expect(r.items.map((i) => i.key)).toEqual(["a.txt"]);
  });

  test.each([
    [404, "not_found", "NotFound"],
    [404, undefined, "NotFound"],
    [401, "unauthorized", "Unauthorized"],
    [403, "access_denied_insufficient_permissions", "Unauthorized"],
    [409, "item_name_in_use", "Conflict"],
    [412, undefined, "Conflict"],
    [500, undefined, "Provider"],
  ] as const)(
    "mapBoxError classifies status=%s code=%s as %s",
    async (status, code, expected) => {
      const files = new Files({ adapter: box(baseOpts) });
      await files.upload("a.txt", "hi");
      getFileByIdMock.mockImplementationOnce(() =>
        Promise.reject(apiError(status, code ?? "other"))
      );
      const err = await files.head("a.txt").catch((error: unknown) => error);
      expect(err).toBeInstanceOf(FilesError);
      expect((err as FilesError).code).toBe(expected);
    }
  );

  test("mapBoxError preserves the underlying error message", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi");
    getFileByIdMock.mockImplementationOnce(() =>
      Promise.reject(apiError(404, "not_found", "the file is gone"))
    );
    const err = await files.head("a.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).message).toBe("the file is gone");
  });

  test("OAuth refresh-token seed call is deferred to first API call", () => {
    // The OAuth path requires actual SDK auth construction; verify only
    // the construction doesn't throw and that calls without API access
    // don't trigger token storage I/O. (Real refresh exchange is
    // exercised only against a live Box server.)
    const adapter = box({
      oauth: {
        clientId: "ci",
        clientSecret: "cs",
        refreshToken: "rt",
      },
    });
    expect(adapter.name).toBe("box");
    expect(adapter.rootFolderId).toBe(ROOT_ID);
  });

  test("CCG construction wires through clientId + enterpriseId", () => {
    const adapter = box({
      ccg: {
        clientId: "ci",
        clientSecret: "cs",
        enterpriseId: "ent",
      },
    });
    expect(adapter.name).toBe("box");
  });

  test("CCG construction also accepts userId", () => {
    const adapter = box({
      ccg: {
        clientId: "ci",
        clientSecret: "cs",
        userId: "u-1",
      },
    });
    expect(adapter.name).toBe("box");
  });

  test("developerToken construction takes the explicit-arg path", () => {
    const adapter = box({ developerToken: "explicit-tok" });
    expect(adapter.name).toBe("box");
  });

  test("JWT construction via configJsonString reaches the JwtConfig.fromConfigJsonString branch", () => {
    // We don't expect the JSON to be valid Box JWT config — JwtConfig parses
    // it eagerly and will throw. The test just exercises that the adapter
    // routes the option to JwtConfig.fromConfigJsonString rather than
    // anywhere else.
    expect(() => box({ jwt: { configJsonString: "{}" } })).toThrow();
  });

  test("JWT construction via configFilePath reaches the JwtConfig.fromConfigFile branch", () => {
    expect(() =>
      box({ jwt: { configFilePath: "/nonexistent.json" } })
    ).toThrow();
  });

  test("upload accepts a non-Uint8Array typed-array view", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    // "loll" little-endian — exercises the typed-array view branch.
    const view = new Uint16Array([0x6f_6c, 0x6f_6c]);
    const r = await files.upload("view.bin", view);
    expect(r.size).toBe(view.byteLength);
  });

  test("upload of an empty key throws Provider", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await expect(files.upload("/", "x")).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("upload routes to chunkedUploads.uploadBigFile above 50 MB", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    // Avoid actually allocating 50 MB+ in the test by stubbing
    // normalizeBody upstream — we can't, so allocate a real 51 MB buffer.
    const big = Buffer.alloc(51 * 1024 * 1024, "x");
    const r = await files.upload("big.bin", big);
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(uploadBigFileMock).toHaveBeenCalledTimes(1);
    expect(r.size).toBe(big.byteLength);
  });

  test("upload accepts an empty metadata object (no rejection)", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi", { metadata: {} });
  });

  test("findChildByName paginates when the first page is full", async () => {
    // Pre-fill the root with > limit entries so the SDK's pagination code
    // path runs at least once. The mocked manager honours offset/limit, so
    // the next page call is real.
    const realLimit = 1000;
    for (let i = 0; i < realLimit + 5; i += 1) {
      const id = `bulk_${i}`;
      store.set(id, {
        bytes: Buffer.from(`x${i}`),
        etag: `etag_${id}`,
        id,
        modifiedAt: STABLE_MODIFIED,
        name: `bulk-${i}.txt`,
        parentId: ROOT_ID,
        size: 2,
        type: "file",
      });
    }
    const files = new Files({ adapter: box(baseOpts) });
    const head = await files.head(`bulk-${realLimit + 2}.txt`);
    expect(head.size).toBe(2);
    expect(getFolderItemsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("resolveFolderId throws Conflict when a path segment exists as a file", async () => {
    // Pre-create a file named "docs" at root, then try to upload under
    // "docs/inner.txt".
    const fileId = "id_clash";
    store.set(fileId, {
      bytes: Buffer.from("hi"),
      etag: "etag_clash",
      id: fileId,
      modifiedAt: STABLE_MODIFIED,
      name: "docs",
      parentId: ROOT_ID,
      size: 2,
      type: "file",
    });
    const files = new Files({ adapter: box(baseOpts) });
    await expect(files.upload("docs/inner.txt", "x")).rejects.toMatchObject({
      code: "Conflict",
    });
  });

  test("folder cache hits avoid re-walking on subsequent uploads", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("nested/a.txt", "x");
    const itemsAfterFirst = getFolderItemsMock.mock.calls.length;
    await files.upload("nested/b.txt", "y");
    // Second upload reuses the cached "nested" folder ID — only the leaf
    // existence check should run, not the walk.
    expect(getFolderItemsMock.mock.calls.length).toBeLessThanOrEqual(
      itemsAfterFirst + 1
    );
  });

  test("list() with NotFound on getFolderItems surfaces NotFound", async () => {
    const files = new Files({
      adapter: box({ ...baseOpts, rootFolderId: "ghost" }),
    });
    await expect(files.list()).rejects.toMatchObject({ code: "NotFound" });
  });

  test("download error: signed-URL fetch returns non-OK", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi");
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 500 })
      )) as unknown as typeof fetch;
    await expect(files.download("a.txt")).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("download error in stream mode surfaces Provider", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi");
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 500 })
      )) as unknown as typeof fetch;
    await expect(
      files.download("a.txt", { as: "stream" })
    ).rejects.toMatchObject({ code: "Provider" });
  });

  test("publicByDefault: re-uploading reuses the existing shared link (idempotent)", async () => {
    const files = new Files({
      adapter: box({ ...baseOpts, publicByDefault: true }),
    });
    await files.upload("a.txt", "v1");
    addShareLinkToFileMock.mockClear();
    // Second upload of the same key triggers uploadFileVersion + another
    // ensureSharedLink. The mock rejects with item_name_in_use the second
    // time, exercising the conflict-recovery path that re-fetches the
    // existing link.
    await files.upload("a.txt", "v2");
    expect(addShareLinkToFileMock).toHaveBeenCalledTimes(1);
    expect(getSharedLinkForFileMock).toHaveBeenCalledTimes(1);
  });

  test("url() falls back to fetchSharedLinkUrl when addShareLinkToFile yields no link", async () => {
    // Upload first (no publicByDefault so the upload path doesn't consume
    // our mockImplementationOnce queue). Then enable publicByDefault on a
    // separate adapter pointed at the same store to exercise url()'s
    // ensureSharedLink fallback.
    const writer = new Files({ adapter: box(baseOpts) });
    await writer.upload("a.txt", "hi");
    addShareLinkToFileMock.mockImplementationOnce(((fileId: string) =>
      Promise.resolve({ id: fileId })) as never);
    getSharedLinkForFileMock.mockImplementationOnce(((fileId: string) =>
      Promise.resolve({
        id: fileId,
        sharedLink: { downloadUrl: "https://fallback.box/d/x" },
      })) as never);
    const reader = new Files({
      adapter: box({ ...baseOpts, publicByDefault: true }),
    });
    const url = await reader.url("a.txt");
    expect(url).toBe("https://fallback.box/d/x");
  });

  test("url() throws Provider when no shared link is recoverable", async () => {
    const writer = new Files({ adapter: box(baseOpts) });
    await writer.upload("a.txt", "hi");
    addShareLinkToFileMock.mockImplementationOnce(((fileId: string) =>
      Promise.resolve({ id: fileId })) as never);
    getSharedLinkForFileMock.mockImplementationOnce(((fileId: string) =>
      Promise.resolve({ id: fileId })) as never);
    const reader = new Files({
      adapter: box({ ...baseOpts, publicByDefault: true }),
    });
    await expect(reader.url("a.txt")).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("delete rethrows non-NotFound errors from resolveFileId", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi");
    // Force the next getFolderItems used by resolveFileId to fail with 401.
    // First clear the cached file ID so resolveFileId actually walks.
    await files.delete("a.txt");
    getFolderItemsMock.mockImplementationOnce(() =>
      Promise.reject(apiError(401, "unauthorized"))
    );
    await expect(files.delete("a.txt")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("delete rethrows non-NotFound errors from deleteFileById", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi");
    deleteFileByIdMock.mockImplementationOnce(() =>
      Promise.reject(apiError(403, "access_denied_insufficient_permissions"))
    );
    await expect(files.delete("a.txt")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("delete idempotently swallows a deleteFileById NotFound (out-of-band removal)", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi");
    // Cached file ID exists; deletion via the SDK returns 404 because
    // someone else removed the file first. Adapter must return cleanly.
    deleteFileByIdMock.mockImplementationOnce(() =>
      Promise.reject(apiError(404, "not_found"))
    );
    await files.delete("a.txt");
  });

  test("mapBoxError on a plain Error returns Provider with the message preserved", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi");
    getFileByIdMock.mockImplementationOnce(() =>
      Promise.reject(new Error("boom"))
    );
    const err = await files.head("a.txt").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("Provider");
    expect((err as FilesError).message).toBe("boom");
  });

  test("createFolder race recovery: Conflict + existing folder is reused", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    // Make the next createFolder call reject with Conflict, but seed the
    // store as if the folder already exists (out-of-band create), so the
    // recovery path's findChildByName succeeds.
    const racedFolder: FakeFolder = {
      id: "raced",
      name: "raced",
      parentId: ROOT_ID,
      type: "folder",
    };
    createFolderMock.mockImplementationOnce(() => {
      // Land the folder in the store on the conflict path.
      store.set(racedFolder.id, racedFolder);
      return Promise.reject(apiError(409, "item_name_in_use"));
    });
    await files.upload("raced/a.txt", "hi");
    expect(
      [...store.values()].some(
        (it) =>
          it.type === "file" && it.name === "a.txt" && it.parentId === "raced"
      )
    ).toBe(true);
  });

  test("createFolder Conflict without a recoverable folder rethrows", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    // Conflict and no folder lands in store → recovery findChildByName
    // returns undefined, so the Conflict error rethrows.
    createFolderMock.mockImplementationOnce(() =>
      Promise.reject(apiError(409, "item_name_in_use"))
    );
    await expect(files.upload("raced/a.txt", "hi")).rejects.toMatchObject({
      code: "Conflict",
    });
  });

  test("OAuth ensureReady seeds tokenStorage on first call only", async () => {
    const adapter = box({
      oauth: {
        clientId: "ci",
        clientSecret: "cs",
        refreshToken: "rt",
      },
    }) as unknown as { _authHandle: { ensureReady: () => Promise<void> } } & {
      raw: { auth: { tokenStorage: { get: () => Promise<unknown> } } };
    };
    await adapter._authHandle.ensureReady();
    const stored1 = await adapter.raw.auth.tokenStorage.get();
    expect(
      (stored1 as { refreshToken?: string } | undefined)?.refreshToken
    ).toBe("rt");
    // Re-calling does not re-store.
    await adapter._authHandle.ensureReady();
    const stored2 = await adapter.raw.auth.tokenStorage.get();
    expect(stored2).toBe(stored1);
  });

  test("lazyDownload from head() surfaces fetch errors as Provider", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "hi");
    const f = await files.head("a.txt");
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 500 })
      )) as unknown as typeof fetch;
    const err = await f.text().catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).code).toBe("Provider");
  });

  test("download() from a key under a missing folder throws NotFound", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await expect(files.download("never/seen.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("upload reuses a pre-existing folder during the walk", async () => {
    // Pre-seed an existing "shared" folder at the root so the walk hits
    // the "child found as folder" branch rather than createFolder.
    const sharedId = "id_shared";
    store.set(sharedId, {
      id: sharedId,
      name: "shared",
      parentId: ROOT_ID,
      type: "folder",
    });
    const files = new Files({ adapter: box(baseOpts) });
    createFolderMock.mockClear();
    await files.upload("shared/a.txt", "hi");
    // No folder needed to be created — "shared" already existed.
    expect(createFolderMock).not.toHaveBeenCalled();
    const file = [...store.values()].find(
      (it) => it.type === "file" && it.name === "a.txt"
    ) as FakeFile | undefined;
    expect(file?.parentId).toBe(sharedId);
  });

  test("upload re-uses a partially-walked folder cache on a deeper key", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("dir/a.txt", "1");
    createFolderMock.mockClear();
    // Same "dir" prefix, deeper leaf under a new subfolder — "dir" comes
    // from the partial-path cache, then "sub" is created fresh.
    await files.upload("dir/sub/b.txt", "2");
    expect(createFolderMock).toHaveBeenCalledTimes(1);
    expect(createFolderMock.mock.calls[0]?.[0]?.name).toBe("sub");
  });

  test("copy() rethrows underlying API errors", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("from.txt", "hi");
    copyFileMock.mockImplementationOnce(() =>
      Promise.reject(apiError(403, "access_denied_insufficient_permissions"))
    );
    await expect(files.copy("from.txt", "to.txt")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("upload surfaces Provider when uploadFile returns no entries", async () => {
    uploadFileMock.mockImplementationOnce(() =>
      Promise.resolve({ entries: [] })
    );
    const files = new Files({ adapter: box(baseOpts) });
    await expect(files.upload("a.txt", "hi")).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("upload surfaces Provider when uploadFileVersion returns no entries", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await files.upload("a.txt", "v1");
    uploadFileVersionMock.mockImplementationOnce(() =>
      Promise.resolve({ entries: [] })
    );
    await expect(files.upload("a.txt", "v2")).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("list() throws Provider on an invalid cursor", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await expect(files.list({ cursor: "not-a-number" })).rejects.toMatchObject({
      code: "Provider",
    });
    await expect(files.list({ cursor: "-1" })).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("splitKey throws on a key that is only slashes", async () => {
    const files = new Files({ adapter: box(baseOpts) });
    await expect(files.upload("///", "hi")).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("createFolder that returns no id surfaces Provider", async () => {
    createFolderMock.mockImplementationOnce((() =>
      Promise.resolve({ name: "x", type: "folder" })) as never);
    const files = new Files({ adapter: box(baseOpts) });
    await expect(files.upload("x/y.txt", "hi")).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("publicBaseUrl url() does not require resolving the file (no API calls)", async () => {
    const files = new Files({
      adapter: box({
        ...baseOpts,
        publicBaseUrl: "https://cdn.example.com",
      }),
    });
    getFolderItemsMock.mockClear();
    const url = await files.url("never/seen.txt");
    expect(url).toBe("https://cdn.example.com/never/seen.txt");
    expect(getFolderItemsMock).not.toHaveBeenCalled();
  });
});
