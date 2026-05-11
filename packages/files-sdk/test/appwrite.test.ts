import { beforeEach, describe, expect, mock, test } from "bun:test";

import { AppwriteException } from "node-appwrite";

import { createAppwriteAdapter } from "../src/appwrite/index.js";
import { Files, FilesError } from "../src/index.js";

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
  createFile = createFileMock;
  deleteFile = deleteFileMock;
  getFile = getFileMock;
  getFileDownload = getFileDownloadMock;
  listFiles = listFilesMock;
}

mock.module("node-appwrite", () => ({
  AppwriteException: MockAppwriteExceptionError,
  Client: MockClient,
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
          adapter: createAppwriteAdapter({
            bucket: BUCKET,
          }),
        })
    ).toThrow("Appwrite adapter requires a projectId or an existing client");
  });

  test("construction > initializes with env vars", () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: createAppwriteAdapter({ bucket: BUCKET }),
    });
    expect(files.adapter.name).toBe("appwrite");
  });

  test("upload > returns metadata", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: createAppwriteAdapter({ bucket: BUCKET }),
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
      adapter: createAppwriteAdapter({ bucket: BUCKET }),
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
      adapter: createAppwriteAdapter({ bucket: BUCKET }),
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
      adapter: createAppwriteAdapter({ bucket: BUCKET }),
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
      adapter: createAppwriteAdapter({ bucket: BUCKET }),
    });

    await expect(files.url("file-123")).rejects.toThrow(
      "unsupported_operation"
    );
  });

  test("url > returns configured URL when public", async () => {
    const files = new Files({
      adapter: createAppwriteAdapter({
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
      adapter: createAppwriteAdapter({ bucket: BUCKET }),
    });

    await expect(
      files.signedUploadUrl("file-123", {
        contentType: "text/plain",
        expiresIn: 3600,
      })
    ).rejects.toThrow("unsupported_operation");
  });

  test("error mapping > 404 maps to NotFound", async () => {
    process.env.APPWRITE_PROJECT_ID = PROJECT_ID;
    const files = new Files({
      adapter: createAppwriteAdapter({ bucket: BUCKET }),
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
});
