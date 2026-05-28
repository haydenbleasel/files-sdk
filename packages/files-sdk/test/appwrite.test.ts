import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { AppwriteException, Client, Storage } from "node-appwrite";

import { appwrite, mapAppwriteError } from "../src/appwrite/index.js";
import { Files, FilesError, UploadControl } from "../src/index.js";
import type { ResumableUploadSession } from "../src/index.js";

const ENDPOINT = "https://cloud.appwrite.io/v1";
const PROJECT_ID = "proj123";
const BUCKET = "uploads";

const createFileMock = mock(() =>
  Promise.resolve({
    $id: "file-id-123",
    mimeType: "text/plain",
    sizeOriginal: 5,
  })
);

const getFileDownloadMock = mock(() =>
  Promise.resolve(Buffer.from("hello").buffer as ArrayBuffer)
);

const getFileMock = mock(() =>
  Promise.resolve({
    $id: "file-id-123",
    mimeType: "text/plain",
    sizeOriginal: 5,
  })
);

const deleteFileMock = mock(() => Promise.resolve({}));

const listFilesMock = mock(() =>
  Promise.resolve({
    files: [
      {
        $id: "file-1",
        mimeType: "text/plain",
        sizeOriginal: 5,
      },
      {
        $id: "file-2",
        mimeType: "image/png",
        sizeOriginal: 1024,
      },
    ],
    total: 2,
  })
);

/* eslint-disable max-classes-per-file */
class MockAppwriteExceptionError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
    this.name = "MockAppwriteExceptionError";
  }
}

class MockClient {
  config = { endpoint: ENDPOINT, project: PROJECT_ID };
  setEndpoint() {
    return this;
  }
  setKey() {
    return this;
  }
  setProject() {
    return this;
  }
}

class MockStorage {
  client?: MockClient;
  createFile = createFileMock;
  deleteFile = deleteFileMock;
  getFile = getFileMock;
  getFileDownload = getFileDownloadMock;
  listFiles = listFilesMock;
  constructor(client?: MockClient) {
    this.client = client;
  }
}

const MockQuery = {
  cursorAfter: (id: string) => `cursorAfter("${id}")`,
  limit: (n: number) => `limit(${n})`,
  startsWith: (attr: string, value: string) =>
    `startsWith("${attr}", "${value}")`,
};

mock.module("node-appwrite", () => ({
  AppwriteException: MockAppwriteExceptionError,
  Client: MockClient,
  Query: MockQuery,
  Storage: MockStorage,
}));

describe("appwrite adapter", () => {
  beforeEach(() => {
    createFileMock.mockClear();
    getFileDownloadMock.mockClear();
    getFileMock.mockClear();
    deleteFileMock.mockClear();
    listFilesMock.mockClear();

    delete process.env.APPWRITE_ENDPOINT;
    delete process.env.APPWRITE_PROJECT_ID;
    delete process.env.APPWRITE_API_KEY;
  });

  test("construction > missing projectId throws", () => {
    expect(
      () =>
        new Files({
          adapter: appwrite({
            bucket: BUCKET,
          }),
        })
    ).toThrow("Appwrite adapter requires a projectId or an existing client");
  });

  test("construction > initializes with env vars", () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    expect(files.adapter.name).toBe("appwrite");
  });

  test("upload > returns metadata", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });

    const result = await files.upload("test-file", "hello");
    expect(createFileMock).toHaveBeenCalled();
    expect(result.key).toBe("file-id-123");
    expect(result.size).toBe(5);
    expect(result.contentType).toBe("text/plain");
  });

  test("download > fetches the file and creates StoredFile", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });

    const file = await files.download("file-id-123");
    expect(getFileMock).toHaveBeenCalled();
    expect(getFileDownloadMock).toHaveBeenCalled();
    expect(file.key).toBe("file-id-123");
    expect(file.size).toBe(5);
    const text = await file.text();
    expect(text).toBe("hello");
  });

  test("delete > delegates to deleteFile", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });

    await files.delete("file-id-123");
    expect(deleteFileMock).toHaveBeenCalledWith({
      bucketId: BUCKET,
      fileId: "file-id-123",
    });
  });

  test("list > maps files to StoredFile items", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });

    const { items, cursor } = await files.list();
    expect(listFilesMock).toHaveBeenCalled();
    expect(items.length).toBe(2);
    expect(items.at(0)?.key).toBe("file-1");
    // limit defaults to 100, length is 2.
    expect(cursor).toBeUndefined();
  });

  test("url > throws when not public", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });

    await expect(files.url("file-123")).rejects.toThrow(
      /appwrite: url\(\) is not supported/u
    );
  });

  test("url > returns configured URL when public", async () => {
    const files = new Files({
      adapter: appwrite({
        bucket: BUCKET,
        endpoint: ENDPOINT,
        projectId: PROJECT_ID,
        public: true,
      }),
    });

    const url = await files.url("file-123");
    expect(url).toBe(
      `${ENDPOINT}/storage/buckets/${BUCKET}/files/file-123/view?project=${PROJECT_ID}`
    );
  });

  test("signedUploadUrl > throws unsupported", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });

    await expect(
      files.signedUploadUrl("file-123", {
        contentType: "text/plain",
        expiresIn: 3600,
      })
    ).rejects.toThrow(/appwrite: signedUploadUrl is not supported/u);
  });

  test("error mapping > 404 maps to NotFound", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });

    getFileMock.mockRejectedValueOnce(new AppwriteException("Not Found", 404));

    try {
      await files.head("missing");
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("error mapping > 401 maps to Unauthorized", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });

    getFileMock.mockRejectedValueOnce(new AppwriteException("No auth", 401));

    try {
      await files.head("file");
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Unauthorized");
    }
  });

  test("error mapping > 403 maps to Unauthorized", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });

    getFileMock.mockRejectedValueOnce(new AppwriteException("Forbidden", 403));

    try {
      await files.head("file");
      expect.unreachable();
    } catch (error: unknown) {
      expect((error as FilesError).code).toBe("Unauthorized");
    }
  });

  test("error mapping > 409 maps to Conflict", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });

    createFileMock.mockRejectedValueOnce(
      new AppwriteException("Already exists", 409)
    );

    try {
      await files.upload("file", "data");
      expect.unreachable();
    } catch (error: unknown) {
      expect((error as FilesError).code).toBe("Conflict");
    }
  });

  test("error mapping > unknown status falls back to Provider", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });

    getFileMock.mockRejectedValueOnce(new AppwriteException("Boom", 500));

    try {
      await files.head("file");
      expect.unreachable();
    } catch (error: unknown) {
      expect((error as FilesError).code).toBe("Provider");
    }
  });

  test("mapAppwriteError > passes through existing FilesError", () => {
    const original = new FilesError("NotFound", "already mapped", null);
    expect(mapAppwriteError(original)).toBe(original);
  });

  test("mapAppwriteError > non-AppwriteException becomes Provider", () => {
    const mapped = mapAppwriteError(new Error("plain"));
    expect(mapped).toBeInstanceOf(FilesError);
    expect(mapped.code).toBe("Provider");
    expect(mapped.message).toBe("Appwrite error");
  });

  test("mapAppwriteError > AppwriteException without message uses default", () => {
    const exception = new AppwriteException("", 404);
    exception.message = "";
    const mapped = mapAppwriteError(exception);
    expect(mapped.code).toBe("NotFound");
  });

  test("construction > accepts an existing Client instance", () => {
    const client = new Client();
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET, client }),
    });
    expect(files.adapter.name).toBe("appwrite");
  });

  test("construction > accepts an existing Storage instance", () => {
    const client = new Client();
    const storage = new Storage(client);
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET, client: storage }),
    });
    expect(files.adapter.name).toBe("appwrite");
  });

  test("construction > Storage instance allows public url derivation", async () => {
    const client = new Client();
    const storage = new Storage(client);
    const files = new Files({
      adapter: appwrite({
        bucket: BUCKET,
        client: storage,
        public: true,
      }),
    });
    const url = await files.url("file-123");
    expect(url).toBe(
      `${ENDPOINT}/storage/buckets/${BUCKET}/files/file-123/view?project=${PROJECT_ID}`
    );
  });

  test("construction > falls back to NEXT_PUBLIC_APPWRITE_* env vars", () => {
    process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID = "next-project";
    process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT = "https://next.example/v1";
    try {
      const files = new Files({
        adapter: appwrite({ bucket: BUCKET }),
      });
      expect(files.adapter.name).toBe("appwrite");
    } finally {
      delete process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID;
      delete process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT;
    }
  });

  test("construction > uses APPWRITE_KEY fallback", () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    process.env.APPWRITE_KEY = "fallback-key";
    try {
      const files = new Files({
        adapter: appwrite({ bucket: BUCKET }),
      });
      expect(files.adapter.name).toBe("appwrite");
    } finally {
      delete process.env.APPWRITE_KEY;
    }
  });

  test("upload > Uint8Array body", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    const result = await files.upload("k", new Uint8Array([1, 2, 3]));
    expect(createFileMock).toHaveBeenCalled();
    expect(result.key).toBe("file-id-123");
  });

  test("upload > ArrayBuffer body", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    const buf = new Uint8Array([4, 5, 6]).buffer;
    const result = await files.upload("k", buf);
    expect(result.key).toBe("file-id-123");
  });

  test("upload > ArrayBufferView body", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    const view = new DataView(new Uint8Array([7, 8, 9]).buffer);
    const result = await files.upload("k", view);
    expect(result.key).toBe("file-id-123");
  });

  test("upload > Blob body", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    const blob = new Blob(["abc"], { type: "text/plain" });
    const result = await files.upload("k", blob);
    expect(result.key).toBe("file-id-123");
  });

  test("upload > ReadableStream body", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    const result = await files.upload("k", stream);
    expect(result.key).toBe("file-id-123");
  });

  test("upload > unsupported body type throws Provider error", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    try {
      await files.upload("k", { not: "a body" } as unknown as string);
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toContain("Unsupported body type");
    }
  });

  test("upload > surfaces SDK errors via mapAppwriteError", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    createFileMock.mockRejectedValueOnce(new AppwriteException("nope", 404));
    await expect(files.upload("k", "data")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("download > surfaces SDK errors", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    getFileMock.mockRejectedValueOnce(new AppwriteException("nope", 404));
    await expect(files.download("missing")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("delete > surfaces SDK errors", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    deleteFileMock.mockRejectedValueOnce(new AppwriteException("nope", 404));
    await expect(files.delete("missing")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("head > returns lazy StoredFile that fetches on read", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    const file = await files.head("file-id-123");
    expect(file.key).toBe("file-id-123");
    expect(file.size).toBe(5);
    expect(getFileDownloadMock).not.toHaveBeenCalled();
    const text = await file.text();
    expect(text).toBe("hello");
    expect(getFileDownloadMock).toHaveBeenCalled();
  });

  test("exists > returns true when file exists", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    await expect(files.exists("file-id-123")).resolves.toBe(true);
  });

  test("exists > returns false on 404", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    getFileMock.mockRejectedValueOnce(new AppwriteException("missing", 404));
    await expect(files.exists("missing")).resolves.toBe(false);
  });

  test("exists > rethrows non-NotFound errors", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    getFileMock.mockRejectedValueOnce(new AppwriteException("forbidden", 403));
    await expect(files.exists("forbidden")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("copy > downloads source then re-uploads to destination", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    await files.copy("source", "destination");
    expect(getFileDownloadMock).toHaveBeenCalledWith({
      bucketId: BUCKET,
      fileId: "source",
    });
    expect(createFileMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ bucketId: BUCKET, fileId: "destination" })
    );
  });

  test("copy > surfaces SDK errors", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    getFileDownloadMock.mockRejectedValueOnce(
      new AppwriteException("missing source", 404)
    );
    await expect(files.copy("missing", "dest")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("list > returns next cursor when page fills the limit", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    listFilesMock.mockResolvedValueOnce({
      files: [
        { $id: "a", mimeType: "text/plain", sizeOriginal: 1 },
        { $id: "b", mimeType: "text/plain", sizeOriginal: 1 },
      ],
      total: 2,
    } as never);
    const { items, cursor } = await files.list({ limit: 2 });
    expect(items).toHaveLength(2);
    expect(cursor).toBe("b");
  });

  test("list > forwards prefix as startsWith($id) query", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    await files.list({ prefix: "user-123/" });
    expect(listFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bucketId: BUCKET,
        queries: expect.arrayContaining(['startsWith("$id", "user-123/")']),
      })
    );
  });

  test("upload > rejects cacheControl with Provider error", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    await expect(
      files.upload("k", "data", { cacheControl: "max-age=60" })
    ).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("`cacheControl` is not supported"),
    });
    expect(createFileMock).not.toHaveBeenCalled();
  });

  test("upload > rejects non-empty metadata with Provider error", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    await expect(
      files.upload("k", "data", { metadata: { owner: "alice" } })
    ).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("`metadata` is not supported"),
    });
    expect(createFileMock).not.toHaveBeenCalled();
  });

  test("upload > accepts empty metadata object", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    const result = await files.upload("k", "data", { metadata: {} });
    expect(result.key).toBe("file-id-123");
  });

  test("upload > rejects invalid Appwrite key", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    await expect(files.upload("has/slash", "data")).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("not a valid Appwrite file ID"),
    });
    expect(createFileMock).not.toHaveBeenCalled();
  });

  test("list > forwards cursor query when provided", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    await files.list({ cursor: "after-id", limit: 10 });
    expect(listFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bucketId: BUCKET,
        queries: expect.arrayContaining([
          "limit(10)",
          'cursorAfter("after-id")',
        ]),
      })
    );
  });

  test("list > paginates through a prefix using cursor + prefix together", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    listFilesMock.mockResolvedValueOnce({
      files: [
        { $id: "user-123/a", mimeType: "text/plain", sizeOriginal: 1 },
        { $id: "user-123/b", mimeType: "text/plain", sizeOriginal: 1 },
      ],
      total: 2,
    } as never);
    const first = await files.list({ limit: 2, prefix: "user-123/" });
    expect(first.cursor).toBe("user-123/b");

    listFilesMock.mockResolvedValueOnce({
      files: [{ $id: "user-123/c", mimeType: "text/plain", sizeOriginal: 1 }],
      total: 1,
    } as never);
    const second = await files.list({
      cursor: first.cursor,
      limit: 2,
      prefix: "user-123/",
    });
    expect(second.items).toHaveLength(1);
    expect(second.cursor).toBeUndefined();
    expect(listFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        bucketId: BUCKET,
        queries: expect.arrayContaining([
          "limit(2)",
          'startsWith("$id", "user-123/")',
          'cursorAfter("user-123/b")',
        ]),
      })
    );
  });

  test("list > items expose lazy bodies that fetch on demand", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    const { items } = await files.list();
    expect(getFileDownloadMock).not.toHaveBeenCalled();
    const text = await items[0]?.text();
    expect(text).toBe("hello");
    expect(getFileDownloadMock).toHaveBeenCalled();
  });

  test("list > surfaces SDK errors", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: appwrite({ bucket: BUCKET }),
    });
    listFilesMock.mockRejectedValueOnce(new AppwriteException("denied", 403));
    await expect(files.list()).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("url > rejects when public bucket is missing endpoint/projectId", async () => {
    // Pass a bare client with empty config so endpoint/projectId stay undefined.
    const bareClient = { config: { project: "" } } as unknown as Client;
    const bareAdapter = appwrite({
      bucket: BUCKET,
      client: bareClient,
      public: true,
    });
    await expect(bareAdapter.url("k")).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("missing endpoint or projectId"),
    });
  });
});

const appwriteFileJson = (size: number) =>
  Response.json({
    $id: "file-id-123",
    chunksTotal: 1,
    chunksUploaded: 1,
    mimeType: "application/octet-stream",
    sizeOriginal: size,
  });

describe("appwrite resumable uploads (chunked)", () => {
  const FIVE_MIB = 5 * 1024 * 1024;
  const filesUrl = `${ENDPOINT}/storage/buckets/${BUCKET}/files`;
  let restoreFetch: () => void;
  const installFetch = (
    handler: (url: string, init: RequestInit) => Response
  ): void => {
    const original = globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    globalThis.fetch = ((url: string, init: RequestInit = {}) =>
      Promise.resolve(handler(url, init))) as unknown as typeof fetch;
  };
  const fileJson = appwriteFileJson;

  const adapter = () =>
    appwrite({
      bucket: BUCKET,
      endpoint: ENDPOINT,
      key: "api-key",
      projectId: PROJECT_ID,
    });

  beforeEach(() => {
    deleteFileMock.mockClear();
  });
  afterEach(() => {
    restoreFetch?.();
  });

  test("fresh upload posts a chunk with Content-Range and completes", async () => {
    const ranges: string[] = [];
    installFetch((url, init) => {
      expect(url).toBe(filesUrl);
      ranges.push(
        (init.headers as Record<string, string>)["Content-Range"] ?? ""
      );
      return fileJson(5);
    });
    const files = new Files({ adapter: adapter() });
    const control = new UploadControl();
    const result = await files.upload("doc", "hello", { control });
    expect(result.key).toBe("file-id-123");
    expect(result.size).toBe(5);
    expect(control.status).toBe("completed");
    expect(control.session?.provider).toBe("appwrite");
    expect(ranges).toEqual(["bytes 0-4/5"]);
  });

  test("resume continues from the token's offset", async () => {
    const ranges: string[] = [];
    installFetch((_url, init) => {
      ranges.push(
        (init.headers as Record<string, string>)["Content-Range"] ?? ""
      );
      return fileJson(FIVE_MIB + 10);
    });
    const files = new Files({ adapter: adapter() });
    const token: ResumableUploadSession = {
      contentType: "application/octet-stream",
      fileId: "doc",
      key: "doc",
      offset: FIVE_MIB,
      provider: "appwrite",
    };
    const result = await files.upload("doc", new Uint8Array(FIVE_MIB + 10), {
      control: UploadControl.from(token),
    });
    expect(result.size).toBe(FIVE_MIB + 10);
    expect(ranges).toEqual([
      `bytes ${FIVE_MIB}-${FIVE_MIB + 9}/${FIVE_MIB + 10}`,
    ]);
  });

  test("abort deletes the partial file", async () => {
    installFetch((_url, init) => {
      const range =
        (init.headers as Record<string, string>)["Content-Range"] ?? "";
      // Two chunks: first reports more to come, then abort fires.
      return range.startsWith("bytes 0-")
        ? Response.json({
            $id: "file-id-123",
            chunksTotal: 2,
            chunksUploaded: 1,
            mimeType: "application/octet-stream",
            sizeOriginal: FIVE_MIB,
          })
        : fileJson(FIVE_MIB * 2 + 5);
    });
    const files = new Files({ adapter: adapter() });
    const control = new UploadControl();
    let aborting: Promise<void> | undefined;
    const promise = files.upload("ab", new Uint8Array(FIVE_MIB * 2 + 5), {
      control,
      onProgress: ({ loaded }) => {
        if (loaded >= FIVE_MIB && !aborting) {
          aborting = control.abort();
        }
      },
    });
    await expect(promise).rejects.toMatchObject({ aborted: true });
    await aborting;
    expect(deleteFileMock).toHaveBeenCalled();
  });

  test("a failed chunk throws", async () => {
    installFetch(() => new Response("nope", { status: 500 }));
    const files = new Files({ adapter: adapter() });
    await expect(
      files.upload("x", "data", { control: new UploadControl(), retries: 0 })
    ).rejects.toThrow(/chunk upload failed/u);
  });

  test("resumable requires an API key (not a keyless client)", async () => {
    delete process.env.APPWRITE_API_KEY;
    delete process.env.APPWRITE_KEY;
    const files = new Files({
      adapter: appwrite({
        bucket: BUCKET,
        endpoint: ENDPOINT,
        projectId: PROJECT_ID,
      }),
    });
    await expect(
      files.upload("x", "data", { control: new UploadControl() })
    ).rejects.toThrow(/require an API key/u);
  });

  test("metadata and cacheControl are rejected", async () => {
    const files = new Files({ adapter: adapter() });
    await expect(
      files.upload("m", "data", {
        control: new UploadControl(),
        metadata: { a: "b" },
      })
    ).rejects.toThrow(/metadata/u);
    await expect(
      files.upload("c", "data", {
        cacheControl: "public",
        control: new UploadControl(),
      })
    ).rejects.toThrow(/cacheControl/u);
  });

  test("resuming a mismatched key throws", async () => {
    const files = new Files({ adapter: adapter() });
    const token: ResumableUploadSession = {
      contentType: "application/octet-stream",
      fileId: "other",
      key: "other",
      offset: 0,
      provider: "appwrite",
    };
    await expect(
      files.upload("doc", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/does not match/u);
  });

  test("resuming a non-appwrite token throws", async () => {
    const files = new Files({ adapter: adapter() });
    const token = {
      bucket: "b",
      key: "x",
      provider: "gcs",
      uri: "u",
    } as ResumableUploadSession;
    await expect(
      files.upload("x", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/Cannot resume a gcs/u);
  });
});
