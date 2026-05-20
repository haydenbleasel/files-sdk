import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import { Files, FilesError } from "../src/index.js";

const lastOptsOf = (m: { mock: { calls: unknown[][] } }) =>
  m.mock.calls.at(-1)?.at(-1) as { abortSignal?: AbortSignal } | undefined;

const STABLE_LAST_MODIFIED = "2024-01-02T03:04:05.000Z";
const STABLE_LAST_MODIFIED_MS = new Date(STABLE_LAST_MODIFIED).getTime();
const ACCOUNT = "acct";
const CONTAINER = "uploads";
const BLOB_BASE = `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}`;
const CONNECTION_STRING = `DefaultEndpointsProtocol=https;AccountName=${ACCOUNT};AccountKey=a2V5;EndpointSuffix=core.windows.net`;

const baseProps = () => ({
  contentLength: 5,
  contentType: "text/plain",
  etag: '"etag-a"',
  lastModified: new Date(STABLE_LAST_MODIFIED),
  metadata: { foo: "bar" },
});

const drainStream = async (stream: Readable): Promise<void> => {
  // for-await over a Readable is the lint-clean way to consume a stream
  // without `new Promise(...)`. The mock uses this so tests don't deadlock
  // on the writer-side promise the real SDK returns.
  for await (const _chunk of stream) {
    // discard
  }
};

const uploadDataResponse = () => ({
  etag: '"etag-a"',
  lastModified: new Date(STABLE_LAST_MODIFIED),
});

const uploadStreamResponse = () => ({
  etag: '"etag-stream"',
  lastModified: new Date(STABLE_LAST_MODIFIED),
});

const uploadDataMock = mock((_data: unknown, _opts: unknown) =>
  Promise.resolve(uploadDataResponse())
);
const uploadStreamMock = mock(
  async (
    stream: Readable,
    _bufferSize: unknown,
    _maxConcurrency: unknown,
    _opts: unknown
  ) => {
    await drainStream(stream);
    return uploadStreamResponse();
  }
);
interface DownloadResult {
  contentLength?: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
  readableStreamBody?: Readable;
}
const downloadMock = mock(
  (): Promise<DownloadResult> =>
    Promise.resolve({
      ...baseProps(),
      readableStreamBody: Readable.from([Buffer.from("hello")]),
    })
);
const downloadToBufferMock = mock(() => Promise.resolve(Buffer.from("hello")));
const existsMock = mock(() => Promise.resolve(true));
const getPropertiesMock = mock(() => Promise.resolve(baseProps()));
const deleteIfExistsMock = mock(() => Promise.resolve({ succeeded: true }));
const syncCopyFromURLMock = mock((_source: string) =>
  Promise.resolve({ copyStatus: "success" })
);

const blobUrlOf = (key: string): string => `${BLOB_BASE}/${key}`;

const makeBlobClient = (key: string) => ({
  delete: deleteIfExistsMock,
  deleteIfExists: deleteIfExistsMock,
  download: downloadMock,
  downloadToBuffer: downloadToBufferMock,
  exists: existsMock,
  getProperties: getPropertiesMock,
  syncCopyFromURL: syncCopyFromURLMock,
  url: blobUrlOf(key),
});

const makeBlockBlobClient = (key: string) => ({
  ...makeBlobClient(key),
  uploadData: uploadDataMock,
  uploadStream: uploadStreamMock,
});

const getBlobClientMock = mock((key: string) => makeBlobClient(key));
const getBlockBlobClientMock = mock((key: string) => makeBlockBlobClient(key));

interface BlobItemFixture {
  name: string;
  properties: ReturnType<typeof baseProps>;
  metadata?: Record<string, string>;
}

const makeListPage = (
  blobItems: BlobItemFixture[],
  continuationToken = ""
) => ({
  continuationToken,
  segment: { blobItems },
});

const defaultListPage = () =>
  makeListPage(
    [
      { metadata: { foo: "bar" }, name: "a/1.txt", properties: baseProps() },
      { metadata: { foo: "bar" }, name: "a/2.txt", properties: baseProps() },
    ],
    ""
  );

const listBlobsFlatMock = mock((opts?: { prefix?: string }) => {
  listBlobsFlatMock.lastOpts = opts;
  return {
    byPage(byPageOpts?: { continuationToken?: string; maxPageSize?: number }) {
      listBlobsFlatMock.lastByPageOpts = byPageOpts;
      return {
        next: () => Promise.resolve({ done: false, value: defaultListPage() }),
      };
    },
  };
}) as ReturnType<typeof mock> & {
  lastOpts?: { prefix?: string };
  lastByPageOpts?: { continuationToken?: string; maxPageSize?: number };
};

const getContainerClientMock = mock((_name: string) => ({
  getBlobClient: getBlobClientMock,
  getBlockBlobClient: getBlockBlobClientMock,
  listBlobsFlat: listBlobsFlatMock,
}));

const sharedKeyInstances: { accountName: string; accountKey: string }[] = [];

class BlobServiceClientStub {
  static lastInit?: { kind: "fromConnectionString" | "ctor"; arg: unknown };

  url: string;

  static fromConnectionString(cs: string): BlobServiceClientStub {
    BlobServiceClientStub.lastInit = { arg: cs, kind: "fromConnectionString" };
    return new BlobServiceClientStub(
      `https://${ACCOUNT}.blob.core.windows.net`
    );
  }

  constructor(url: string, _credential?: unknown) {
    BlobServiceClientStub.lastInit ??= { arg: url, kind: "ctor" };
    this.url = url;
  }

  // oxlint-disable-next-line class-methods-use-this
  getContainerClient(name: string) {
    return getContainerClientMock(name);
  }
}

// oxlint-disable-next-line max-classes-per-file
class StorageSharedKeyCredentialStub {
  accountName: string;
  accountKey: string;

  constructor(accountName: string, accountKey: string) {
    this.accountName = accountName;
    this.accountKey = accountKey;
    sharedKeyInstances.push({ accountKey, accountName });
  }
}

const generateBlobSASQueryParametersMock = mock(
  (
    opts: {
      blobName: string;
      containerName: string;
      permissions: { toString(): string };
      expiresOn: Date;
      contentDisposition?: string;
    },
    _credential: unknown
  ) => {
    const perms = opts.permissions.toString();
    const params = new URLSearchParams({
      se: opts.expiresOn.toISOString(),
      sig: "stub",
      sp: perms,
    });
    if (opts.contentDisposition) {
      params.set("rscd", opts.contentDisposition);
    }
    return {
      toString: () => params.toString(),
    };
  }
);

mock.module("@azure/storage-blob", () => ({
  BlobSASPermissions: {
    parse: (s: string) => ({ toString: () => s }),
  },
  BlobServiceClient: BlobServiceClientStub,
  ContainerSASPermissions: {
    parse: (s: string) => ({ toString: () => s }),
  },
  SASProtocol: { Https: "https" },
  StorageSharedKeyCredential: StorageSharedKeyCredentialStub,
  generateBlobSASQueryParameters: generateBlobSASQueryParametersMock,
}));

const { azure, mapAzureError } = await import("../src/azure/index.js");

beforeEach(() => {
  uploadDataMock.mockClear();
  uploadStreamMock.mockClear();
  downloadMock.mockClear();
  downloadToBufferMock.mockClear();
  existsMock.mockClear();
  getPropertiesMock.mockClear();
  deleteIfExistsMock.mockClear();
  syncCopyFromURLMock.mockClear();
  getBlobClientMock.mockClear();
  getBlockBlobClientMock.mockClear();
  getContainerClientMock.mockClear();
  listBlobsFlatMock.mockClear();
  generateBlobSASQueryParametersMock.mockClear();

  uploadDataMock.mockImplementation(() =>
    Promise.resolve(uploadDataResponse())
  );
  uploadStreamMock.mockImplementation(
    async (
      stream: Readable,
      _bufferSize: unknown,
      _maxConcurrency: unknown,
      _opts: unknown
    ) => {
      await drainStream(stream);
      return uploadStreamResponse();
    }
  );
  downloadMock.mockImplementation(() =>
    Promise.resolve({
      ...baseProps(),
      readableStreamBody: Readable.from([Buffer.from("hello")]),
    })
  );
  downloadToBufferMock.mockImplementation(() =>
    Promise.resolve(Buffer.from("hello"))
  );
  existsMock.mockImplementation(() => Promise.resolve(true));
  getPropertiesMock.mockImplementation(() => Promise.resolve(baseProps()));
  deleteIfExistsMock.mockImplementation(() =>
    Promise.resolve({ succeeded: true })
  );
  syncCopyFromURLMock.mockImplementation(() =>
    Promise.resolve({ copyStatus: "success" })
  );

  sharedKeyInstances.length = 0;
  BlobServiceClientStub.lastInit = undefined;
  listBlobsFlatMock.lastOpts = undefined;
  listBlobsFlatMock.lastByPageOpts = undefined;
});

describe("azure adapter", () => {
  describe("construction", () => {
    test("missing container throws", () => {
      expect(() =>
        azure({ accountKey: "k", accountName: ACCOUNT, container: "" })
      ).toThrow(/container/u);
    });

    test("missing credentials throws with a helpful message", () => {
      expect(() => azure({ container: CONTAINER })).toThrow(
        /missing credentials/u
      );
    });

    test("connectionString builds via fromConnectionString and recovers shared key", () => {
      const adapter = azure({
        connectionString: CONNECTION_STRING,
        container: CONTAINER,
      });
      expect(adapter.bucket).toBe(CONTAINER);
      expect(adapter.name).toBe("azure");
      expect(BlobServiceClientStub.lastInit?.kind).toBe("fromConnectionString");
      expect(sharedKeyInstances).toHaveLength(1);
      expect(sharedKeyInstances[0]?.accountName).toBe(ACCOUNT);
    });

    test("accountName + accountKey constructs StorageSharedKeyCredential", () => {
      azure({
        accountKey: "secret",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      expect(BlobServiceClientStub.lastInit?.kind).toBe("ctor");
      expect(sharedKeyInstances).toHaveLength(1);
      expect(sharedKeyInstances[0]).toEqual({
        accountKey: "secret",
        accountName: ACCOUNT,
      });
    });

    test("accountName + sasToken constructs without shared key", () => {
      azure({
        accountName: ACCOUNT,
        container: CONTAINER,
        sasToken: "?sig=abc",
      });
      expect(BlobServiceClientStub.lastInit?.kind).toBe("ctor");
      expect(sharedKeyInstances).toHaveLength(0);
      expect(BlobServiceClientStub.lastInit?.arg).toBe(
        `https://${ACCOUNT}.blob.core.windows.net?sig=abc`
      );
    });

    test("anonymous construction (accountName only) succeeds for public-read containers", () => {
      const adapter = azure({ accountName: ACCOUNT, container: CONTAINER });
      expect(adapter.name).toBe("azure");
      expect(sharedKeyInstances).toHaveLength(0);
    });
  });

  describe("upload", () => {
    test("buffer body returns metadata from uploadData response", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "secret",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      const result = await files.upload("a.txt", "hello", {
        cacheControl: "public, max-age=60",
        contentType: "text/plain",
        metadata: { author: "me" },
      });
      expect(result.key).toBe("a.txt");
      expect(result.size).toBe(5);
      expect(result.contentType).toBe("text/plain");
      expect(result.etag).toBe("etag-a");
      expect(result.lastModified).toBe(STABLE_LAST_MODIFIED_MS);

      expect(uploadDataMock).toHaveBeenCalledTimes(1);
      const [uploadCall] = uploadDataMock.mock.calls;
      if (!uploadCall) {
        throw new Error("expected uploadData to have been called");
      }
      const [data, opts] = uploadCall;
      expect(Buffer.isBuffer(data)).toBe(true);
      const o = opts as {
        blobHTTPHeaders: { blobContentType: string; blobCacheControl?: string };
        metadata?: Record<string, string>;
      };
      expect(o.blobHTTPHeaders.blobContentType).toBe("text/plain");
      expect(o.blobHTTPHeaders.blobCacheControl).toBe("public, max-age=60");
      expect(o.metadata).toEqual({ author: "me" });
    });

    test("Uint8Array passes a Buffer to uploadData", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      await adapter.upload("a.bin", new Uint8Array([1, 2, 3, 4]));
      const [uploadCall] = uploadDataMock.mock.calls;
      if (!uploadCall) {
        throw new Error("expected uploadData to have been called");
      }
      const [data] = uploadCall;
      expect(Buffer.isBuffer(data)).toBe(true);
      expect((data as Buffer).byteLength).toBe(4);
    });

    test("ArrayBuffer surfaces full byteLength", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      const ab = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
      const result = await adapter.upload("a.bin", ab);
      expect(result.size).toBe(8);
      expect(result.contentType).toBe("application/octet-stream");
      const [uploadCall] = uploadDataMock.mock.calls;
      if (!uploadCall) {
        throw new Error("expected uploadData to have been called");
      }
      const [data] = uploadCall;
      expect((data as Buffer).byteLength).toBe(8);
    });

    test("ArrayBufferView (DataView at offset) respects byteOffset and byteLength", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      // 16-byte buffer with a 10-byte view starting at offset 4. Adapter
      // must respect the view's bounds, not over-read into adjacent bytes.
      const view = new DataView(new ArrayBuffer(16), 4, 10);
      const result = await adapter.upload("v.bin", view);
      expect(result.size).toBe(10);
      const [uploadCall] = uploadDataMock.mock.calls;
      if (!uploadCall) {
        throw new Error("expected uploadData to have been called");
      }
      const [data] = uploadCall;
      expect((data as Buffer).byteLength).toBe(10);
    });

    test("Blob preserves its contentType when caller doesn't override", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
        type: "image/jpeg",
      });
      const result = await adapter.upload("photo.jpg", blob);
      expect(result.size).toBe(3);
      expect(result.contentType).toBe("image/jpeg");
    });

    test("Blob with explicit contentType override wins", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      const blob = new Blob(["hello"], { type: "text/plain" });
      const result = await adapter.upload("a.bin", blob, {
        contentType: "application/octet-stream",
      });
      expect(result.contentType).toBe("application/octet-stream");
    });

    test("ReadableStream goes through uploadStream and reports size from getProperties", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("hello"));
          c.close();
        },
      });
      const result = await adapter.upload("s.txt", stream);
      expect(uploadStreamMock).toHaveBeenCalledTimes(1);
      expect(uploadDataMock).not.toHaveBeenCalled();
      expect(result.size).toBe(5);
      expect(result.etag).toBe("etag-stream");
    });
  });

  describe("download", () => {
    test("buffered: returns body and metadata", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      const got = await files.download("a.txt");
      expect(await got.text()).toBe("hello");
      expect(got.size).toBe(5);
      expect(got.type).toBe("text/plain");
      expect(got.etag).toBe("etag-a");
      expect(got.metadata).toEqual({ foo: "bar" });
    });

    test("as: 'stream' returns a lazy stream — no fetch until .stream() called", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      const got = await files.download("a.txt", { as: "stream" });
      expect(downloadToBufferMock).not.toHaveBeenCalled();
      const reader = got.stream().getReader();
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
      expect(total).toBe(5);
    });

    test("as: 'stream' yields an empty stream when SDK omits readableStreamBody", async () => {
      // The Azure SDK occasionally returns the metadata envelope without a
      // readable body (e.g. zero-byte blobs). The adapter's stream factory
      // should fall through to an immediately-closed ReadableStream rather
      // than crashing on `Readable.toWeb(undefined)`.
      downloadMock.mockImplementationOnce(() =>
        Promise.resolve({ ...baseProps(), readableStreamBody: undefined })
      );
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      const got = await files.download("a.txt", { as: "stream" });
      const reader = got.stream().getReader();
      const { done, value } = await reader.read();
      expect(done).toBe(true);
      expect(value).toBeUndefined();
    });

    test("buffered: download tolerates a response missing etag and metadata", async () => {
      // stripEtag's `if (!etag) return undefined` branch runs when the SDK
      // doesn't echo an ETag back (e.g. anonymous-read responses).
      downloadMock.mockImplementationOnce(() =>
        Promise.resolve({
          contentLength: 5,
          contentType: "text/plain",
          lastModified: new Date(STABLE_LAST_MODIFIED),
          readableStreamBody: Readable.from([Buffer.from("hello")]),
        })
      );
      const got = await azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      }).download("a.txt");
      expect(await got.text()).toBe("hello");
      expect(got.etag).toBeUndefined();
      expect(got.metadata).toBeUndefined();
    });
  });

  describe("head", () => {
    test("returns metadata only and does not pre-fetch the body", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      const info = await files.head("a.txt");
      expect(info.size).toBe(5);
      expect(info.type).toBe("text/plain");
      expect(info.etag).toBe("etag-a");
      expect(downloadToBufferMock).not.toHaveBeenCalled();
    });

    test("body is lazy — text() triggers a follow-up download", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      const info = await files.head("a.txt");
      downloadToBufferMock.mockClear();
      expect(await info.text()).toBe("hello");
      expect(downloadToBufferMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("exists", () => {
    test("returns true when the blob exists", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      await expect(files.exists("a.txt")).resolves.toBe(true);
    });

    test("returns false when the blob is missing", async () => {
      existsMock.mockImplementationOnce(() => Promise.resolve(false));
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      await expect(files.exists("missing.txt")).resolves.toBe(false);
    });

    test("rethrows non-NotFound errors from blobClient.exists()", async () => {
      existsMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("denied"), { statusCode: 403 }))
      );
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      await expect(files.exists("a.txt")).rejects.toMatchObject({
        code: "Unauthorized",
      });
    });

    test("swallows a NotFound *thrown* by blobClient.exists()", async () => {
      // Happy path returns true/false; the SDK can also throw a 404 in some
      // configurations — the adapter should still report `false`.
      existsMock.mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error("BlobNotFound"), { statusCode: 404 })
        )
      );
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      await expect(files.exists("missing.txt")).resolves.toBe(false);
    });
  });

  describe("delete", () => {
    test("delegates to deleteIfExists", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      await files.delete("a.txt");
      expect(deleteIfExistsMock).toHaveBeenCalledTimes(1);
    });

    test("does NOT throw on missing blob (idempotent — divergent from gcs)", async () => {
      deleteIfExistsMock.mockImplementationOnce(() =>
        Promise.resolve({ succeeded: false })
      );
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      await expect(files.delete("nope.txt")).resolves.toBeUndefined();
    });
  });

  describe("copy", () => {
    test("same-container copy: source URL has a SAS appended in shared-key mode", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      await files.copy("a.txt", "b.txt");
      expect(syncCopyFromURLMock).toHaveBeenCalledTimes(1);
      const [copyCall] = syncCopyFromURLMock.mock.calls;
      if (!copyCall) {
        throw new Error("expected syncCopyFromURL to have been called");
      }
      const [source] = copyCall;
      expect(source).toContain(`${BLOB_BASE}/a.txt?`);
      expect(source).toContain("sig=");
      expect(generateBlobSASQueryParametersMock).toHaveBeenCalled();
    });

    test("anonymous mode (no key, no SAS) uses the bare blob URL as the copy source", async () => {
      const adapter = azure({ accountName: ACCOUNT, container: CONTAINER });
      await adapter.copy("a.txt", "b.txt");
      const [copyCall] = syncCopyFromURLMock.mock.calls;
      if (!copyCall) {
        throw new Error("expected syncCopyFromURL to have been called");
      }
      const [source] = copyCall;
      expect(source).toBe(`${BLOB_BASE}/a.txt`);
      expect(generateBlobSASQueryParametersMock).not.toHaveBeenCalled();
    });

    test("sas-only mode appends the existing SAS to the source URL", async () => {
      const adapter = azure({
        accountName: ACCOUNT,
        container: CONTAINER,
        sasToken: "?sig=existing-sas",
      });
      await adapter.copy("a.txt", "b.txt");
      const [copyCall] = syncCopyFromURLMock.mock.calls;
      if (!copyCall) {
        throw new Error("expected syncCopyFromURL to have been called");
      }
      const [source] = copyCall;
      expect(source).toBe(`${BLOB_BASE}/a.txt?sig=existing-sas`);
      expect(generateBlobSASQueryParametersMock).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    test("forwards prefix/limit/cursor and surfaces continuationToken", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      const out = await files.list({
        cursor: "tok-1",
        limit: 10,
        prefix: "a/",
      });
      expect(out.items.map((i) => i.key)).toEqual(["a/1.txt", "a/2.txt"]);
      expect(listBlobsFlatMock.lastOpts?.prefix).toBe("a/");
      expect(listBlobsFlatMock.lastByPageOpts?.continuationToken).toBe("tok-1");
      expect(listBlobsFlatMock.lastByPageOpts?.maxPageSize).toBe(10);
    });

    test("returns continuationToken as cursor when more pages exist", async () => {
      listBlobsFlatMock.mockImplementationOnce(() => ({
        byPage: () => ({
          next: () =>
            Promise.resolve({
              done: false,
              value: makeListPage(
                [{ name: "a/1.txt", properties: baseProps() }],
                "next-tok"
              ),
            }),
        }),
      }));
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      const out = await files.list();
      expect(out.cursor).toBe("next-tok");
    });

    test("omits cursor when continuationToken is empty", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      const out = await files.list();
      expect(out.cursor).toBeUndefined();
    });

    test("items expose lazy bodies that fetch via downloadToBuffer", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });
      const out = await files.list();
      const [item] = out.items;
      if (!item) {
        throw new Error("expected at least one list item");
      }
      downloadToBufferMock.mockClear();
      expect(await item.text()).toBe("hello");
      expect(downloadToBufferMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("url", () => {
    test("publicBaseUrl short-circuits and skips signing", async () => {
      const files = new Files({
        adapter: azure({
          accountKey: "k",
          accountName: ACCOUNT,
          container: CONTAINER,
          publicBaseUrl: "https://cdn.example.com",
        }),
      });
      expect(await files.url("a.txt")).toBe("https://cdn.example.com/a.txt");
      expect(generateBlobSASQueryParametersMock).not.toHaveBeenCalled();
    });

    test("publicBaseUrl tolerates trailing slash", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
        publicBaseUrl: "https://cdn.example.com/",
      });
      expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
    });

    test("falls back to a signed read URL when no publicBaseUrl", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      const url = await adapter.url("a.txt");
      expect(url).toContain(`${BLOB_BASE}/a.txt?`);
      const [signCall] = generateBlobSASQueryParametersMock.mock.calls;
      if (!signCall) {
        throw new Error(
          "expected generateBlobSASQueryParameters to have been called"
        );
      }
      const [opts] = signCall;
      expect(opts.permissions.toString()).toBe("r");
      expect(opts.expiresOn.getTime()).toBeGreaterThan(Date.now());
    });

    test("honors per-call expiresIn", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      const before = Date.now();
      await adapter.url("a.txt", { expiresIn: 60 });
      const [signCall] = generateBlobSASQueryParametersMock.mock.calls;
      if (!signCall) {
        throw new Error(
          "expected generateBlobSASQueryParameters to have been called"
        );
      }
      const [opts] = signCall;
      expect(opts.expiresOn.getTime()).toBeGreaterThanOrEqual(
        before + 60_000 - 1000
      );
      expect(opts.expiresOn.getTime()).toBeLessThanOrEqual(
        before + 60_000 + 5000
      );
    });

    test("responseContentDisposition forces signing even with publicBaseUrl set", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
        publicBaseUrl: "https://cdn.example.com",
      });
      const url = await adapter.url("a.txt", {
        responseContentDisposition: "attachment",
      });
      expect(url).toContain(`${BLOB_BASE}/a.txt?`);
      const [signCall] = generateBlobSASQueryParametersMock.mock.calls;
      if (!signCall) {
        throw new Error(
          "expected generateBlobSASQueryParameters to have been called"
        );
      }
      const [opts] = signCall;
      expect(opts.contentDisposition).toBe("attachment");
    });

    test("throws when no shared key is available (sas-only mode)", async () => {
      const adapter = azure({
        accountName: ACCOUNT,
        container: CONTAINER,
        sasToken: "?sig=abc",
      });
      try {
        await adapter.url("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).message).toMatch(/shared key/u);
      }
    });
  });

  describe("signedUploadUrl", () => {
    test("returns PUT URL with x-ms-blob-type header", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      const out = await adapter.signedUploadUrl("a.txt", { expiresIn: 60 });
      if (out.method !== "PUT") {
        throw new Error("expected PUT");
      }
      expect(out.url).toContain(`${BLOB_BASE}/a.txt?`);
      expect(out.headers?.["x-ms-blob-type"]).toBe("BlockBlob");
      const [signCall] = generateBlobSASQueryParametersMock.mock.calls;
      if (!signCall) {
        throw new Error(
          "expected generateBlobSASQueryParameters to have been called"
        );
      }
      const [opts] = signCall;
      expect(opts.permissions.toString()).toBe("cw");
    });

    test("includes Content-Type header when contentType passed", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      const out = await adapter.signedUploadUrl("a.png", {
        contentType: "image/png",
        expiresIn: 60,
      });
      if (out.method !== "PUT") {
        throw new Error("expected PUT");
      }
      expect(out.headers?.["Content-Type"]).toBe("image/png");
      expect(out.headers?.["x-ms-blob-type"]).toBe("BlockBlob");
    });

    test("throws NotSupported when maxSize is set", async () => {
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      try {
        await adapter.signedUploadUrl("a.txt", {
          expiresIn: 60,
          maxSize: 1000,
        });
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).message).toMatch(/maxSize/u);
      }
    });

    test("throws when no shared key is available", async () => {
      const adapter = azure({
        accountName: ACCOUNT,
        container: CONTAINER,
        sasToken: "?sig=abc",
      });
      try {
        await adapter.signedUploadUrl("a.txt", { expiresIn: 60 });
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).message).toMatch(/shared key/u);
      }
    });
  });

  describe("error mapping", () => {
    test("BlobNotFound maps to NotFound", () => {
      const err = mapAzureError(
        Object.assign(new Error("not here"), {
          details: { errorCode: "BlobNotFound" },
          statusCode: 404,
        })
      );
      expect(err.code).toBe("NotFound");
      expect(err.message).toBe("not here");
    });

    test("status 404 alone maps to NotFound", () => {
      const err = mapAzureError(
        Object.assign(new Error("missing"), { statusCode: 404 })
      );
      expect(err.code).toBe("NotFound");
    });

    test("AuthenticationFailed maps to Unauthorized", () => {
      const err = mapAzureError(
        Object.assign(new Error("bad sig"), {
          details: { errorCode: "AuthenticationFailed" },
          statusCode: 403,
        })
      );
      expect(err.code).toBe("Unauthorized");
    });

    test("AuthorizationFailure maps to Unauthorized", () => {
      const err = mapAzureError(
        Object.assign(new Error("denied"), {
          details: { errorCode: "AuthorizationFailure" },
          statusCode: 403,
        })
      );
      expect(err.code).toBe("Unauthorized");
    });

    test("status 401 maps to Unauthorized", () => {
      const err = mapAzureError(
        Object.assign(new Error("unauth"), { statusCode: 401 })
      );
      expect(err.code).toBe("Unauthorized");
    });

    test("BlobAlreadyExists maps to Conflict", () => {
      const err = mapAzureError(
        Object.assign(new Error("exists"), {
          details: { errorCode: "BlobAlreadyExists" },
          statusCode: 409,
        })
      );
      expect(err.code).toBe("Conflict");
    });

    test("ConditionNotMet (412) maps to Conflict", () => {
      const err = mapAzureError(
        Object.assign(new Error("precondition"), {
          details: { errorCode: "ConditionNotMet" },
          statusCode: 412,
        })
      );
      expect(err.code).toBe("Conflict");
    });

    test("status 500 maps to Provider", () => {
      const err = mapAzureError(
        Object.assign(new Error("oops"), { statusCode: 500 })
      );
      expect(err.code).toBe("Provider");
    });

    test("an existing FilesError passes through unchanged", () => {
      const original = new FilesError("Conflict", "already there", {
        original: true,
      });
      const out = mapAzureError(original);
      expect(out).toBe(original);
      expect(out.code).toBe("Conflict");
      expect(out.cause).toEqual({ original: true });
    });

    test("download error is wrapped as FilesError", async () => {
      downloadMock.mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error("not here"), {
            details: { errorCode: "BlobNotFound" },
            statusCode: 404,
          })
        )
      );
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      try {
        await adapter.download("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("upload error is wrapped as FilesError", async () => {
      uploadDataMock.mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error("denied"), {
            details: { errorCode: "AuthorizationFailure" },
            statusCode: 403,
          })
        )
      );
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      try {
        await adapter.upload("a.txt", "x");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("Unauthorized");
      }
    });

    test("head error is wrapped as FilesError", async () => {
      getPropertiesMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("missing"), { statusCode: 404 }))
      );
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      try {
        await adapter.head("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("delete error is wrapped as FilesError", async () => {
      deleteIfExistsMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("denied"), { statusCode: 403 }))
      );
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      try {
        await adapter.delete("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("Unauthorized");
      }
    });

    test("copy error is wrapped as FilesError", async () => {
      syncCopyFromURLMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("nope"), { statusCode: 404 }))
      );
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      try {
        await adapter.copy("a.txt", "b.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("list error is wrapped as FilesError", async () => {
      listBlobsFlatMock.mockImplementationOnce(() => ({
        byPage: () => ({
          next: () =>
            Promise.reject(
              Object.assign(new Error("boom"), { statusCode: 500 })
            ),
        }),
      }));
      const adapter = azure({
        accountKey: "k",
        accountName: ACCOUNT,
        container: CONTAINER,
      });
      try {
        await adapter.list();
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("Provider");
      }
    });
  });

  describe("signal forwarding", () => {
    const makeFiles = () =>
      new Files({
        adapter: azure({
          accountKey: "secret",
          accountName: ACCOUNT,
          container: CONTAINER,
        }),
      });

    test("upload forwards the signal to uploadData", async () => {
      const { signal } = new AbortController();
      await makeFiles().upload("a.txt", "hello", { signal });
      expect(lastOptsOf(uploadDataMock)?.abortSignal).toBe(signal);
    });

    test("download forwards the signal to download/downloadToBuffer", async () => {
      const { signal } = new AbortController();
      await makeFiles().download("a.txt", { signal });
      expect(lastOptsOf(downloadMock)?.abortSignal).toBe(signal);
      expect(lastOptsOf(downloadToBufferMock)?.abortSignal).toBe(signal);
    });

    test("head forwards the signal to getProperties", async () => {
      const { signal } = new AbortController();
      await makeFiles().head("a.txt", { signal });
      expect(lastOptsOf(getPropertiesMock)?.abortSignal).toBe(signal);
    });

    test("delete forwards the signal to deleteIfExists", async () => {
      const { signal } = new AbortController();
      await makeFiles().delete("a.txt", { signal });
      expect(lastOptsOf(deleteIfExistsMock)?.abortSignal).toBe(signal);
    });

    test("exists forwards the signal to exists", async () => {
      const { signal } = new AbortController();
      await makeFiles().exists("a.txt", { signal });
      expect(lastOptsOf(existsMock)?.abortSignal).toBe(signal);
    });

    test("copy forwards the signal to syncCopyFromURL", async () => {
      const { signal } = new AbortController();
      await makeFiles().copy("a.txt", "b.txt", { signal });
      expect(lastOptsOf(syncCopyFromURLMock)?.abortSignal).toBe(signal);
    });

    test("list forwards the signal to listBlobsFlat", async () => {
      const { signal } = new AbortController();
      await makeFiles().list({ signal });
      expect(
        (listBlobsFlatMock.lastOpts as { abortSignal?: AbortSignal })
          ?.abortSignal
      ).toBe(signal);
    });
  });
});
