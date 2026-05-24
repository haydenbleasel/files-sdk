import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { PassThrough, Readable } from "node:stream";

import { Files, FilesError } from "../src/index.js";

const STABLE_UPDATED = "2024-01-02T03:04:05.000Z";
const STABLE_UPDATED_MS = new Date(STABLE_UPDATED).getTime();

const baseMetadata = (name: string) => ({
  bucket: "uploads",
  contentType: "text/plain",
  etag: `etag-${name}`,
  metadata: { foo: "bar" },
  name,
  size: "5",
  updated: STABLE_UPDATED,
});

const saveMock = mock(async (_data: unknown, _opts: unknown) => {});
const downloadMock = mock(() =>
  Promise.resolve([Buffer.from("hello")] as [Buffer])
);
const existsMock = mock(() => Promise.resolve([true] as [boolean]));
const getMetadataMock = mock(() =>
  Promise.resolve([baseMetadata("a.txt")] as const)
);
const deleteMock = mock(async () => {});
const copyMock = mock(async (_dest: unknown) => {});
const getSignedUrlMock = mock((opts: { action?: string; version?: string }) =>
  Promise.resolve([
    `https://signed.example.com/${opts.action ?? "read"}?v=${opts.version}`,
  ] as [string])
);
const generateSignedPostPolicyV4Mock = mock((_opts: unknown) =>
  Promise.resolve([
    {
      fields: { key: "a.txt", policy: "abc" },
      url: "https://gcs.example.com/policy",
    },
  ])
);
const createReadStreamMock = mock(() => Readable.from([Buffer.from("hello")]));
const createWriteStreamMock = mock(() => new PassThrough());

const makeFile = (name: string, populateMetadata = false) => ({
  copy: copyMock,
  createReadStream: createReadStreamMock,
  createWriteStream: createWriteStreamMock,
  delete: deleteMock,
  download: downloadMock,
  exists: existsMock,
  generateSignedPostPolicyV4: generateSignedPostPolicyV4Mock,
  getMetadata: getMetadataMock,
  getSignedUrl: getSignedUrlMock,
  metadata: populateMetadata ? baseMetadata(name) : {},
  name,
  save: saveMock,
});

const bucketFileMock = mock((name: string) => makeFile(name));
const getFilesMock = mock((_opts?: unknown) =>
  Promise.resolve([
    [makeFile("a/1.txt", true), makeFile("a/2.txt", true)],
    null,
    {},
  ])
);

// The real `Storage` SDK class exposes `bucket` as an instance method, and
// the adapter calls it via `new Storage(...).bucket(...)`. Keeping the same
// shape here means the stub method doesn't read `this` — silence the rule.
// oxlint-disable-next-line class-methods-use-this
class StorageStub {
  static lastOpts?: Record<string, unknown>;
  constructor(opts: Record<string, unknown>) {
    StorageStub.lastOpts = opts;
  }
  // oxlint-disable-next-line class-methods-use-this
  bucket(_name: string) {
    return {
      file: bucketFileMock,
      getFiles: getFilesMock,
    };
  }
}

mock.module("@google-cloud/storage", () => ({
  Storage: StorageStub,
}));

const { gcs, mapGCSError } = await import("../src/gcs/index.js");

beforeEach(() => {
  saveMock.mockClear();
  downloadMock.mockClear();
  existsMock.mockClear();
  getMetadataMock.mockClear();
  deleteMock.mockClear();
  copyMock.mockClear();
  getSignedUrlMock.mockClear();
  generateSignedPostPolicyV4Mock.mockClear();
  createReadStreamMock.mockClear();
  createWriteStreamMock.mockClear();
  bucketFileMock.mockClear();
  getFilesMock.mockClear();
  // Restore default implementations so `mockImplementationOnce` from a
  // previous test doesn't bleed over.
  saveMock.mockImplementation(async () => {});
  downloadMock.mockImplementation(() =>
    Promise.resolve([Buffer.from("hello")] as [Buffer])
  );
  existsMock.mockImplementation(() => Promise.resolve([true] as [boolean]));
  getMetadataMock.mockImplementation(() =>
    Promise.resolve([baseMetadata("a.txt")] as const)
  );
  deleteMock.mockImplementation(async () => {});
  copyMock.mockImplementation(async () => {});
  getSignedUrlMock.mockImplementation(
    (opts: { action?: string; version?: string }) =>
      Promise.resolve([
        `https://signed.example.com/${opts.action ?? "read"}?v=${opts.version}`,
      ] as [string])
  );
  generateSignedPostPolicyV4Mock.mockImplementation(() =>
    Promise.resolve([
      {
        fields: { key: "a.txt", policy: "abc" },
        url: "https://gcs.example.com/policy",
      },
    ])
  );
  createReadStreamMock.mockImplementation(() =>
    Readable.from([Buffer.from("hello")])
  );
  createWriteStreamMock.mockImplementation(() => new PassThrough());
  getFilesMock.mockImplementation(() =>
    Promise.resolve([
      [makeFile("a/1.txt", true), makeFile("a/2.txt", true)],
      null,
      {},
    ])
  );
});

describe("gcs adapter", () => {
  test("missing bucket throws at construction", () => {
    expect(() => gcs({ bucket: "" })).toThrow(/bucket/u);
  });

  test("construction with no credentials lets the SDK fall back to ADC", () => {
    const adapter = gcs({ bucket: "uploads" });
    expect(adapter.name).toBe("gcs");
    expect(adapter.bucket).toBe("uploads");
    // Storage gets called with no auth fields when none were passed.
    expect(StorageStub.lastOpts).toBeDefined();
    expect(StorageStub.lastOpts).not.toHaveProperty("keyFilename");
    expect(StorageStub.lastOpts).not.toHaveProperty("credentials");
  });

  test("construction with explicit projectId is forwarded to the Storage client", () => {
    gcs({ bucket: "uploads", projectId: "my-proj" });
    expect(StorageStub.lastOpts?.projectId).toBe("my-proj");
  });

  test("construction with keyFilename is forwarded to the Storage client", () => {
    gcs({ bucket: "uploads", keyFilename: "/path/to/sa.json" });
    expect(StorageStub.lastOpts?.keyFilename).toBe("/path/to/sa.json");
  });

  test("construction with inline credentials is forwarded to the Storage client", () => {
    gcs({
      bucket: "uploads",
      credentials: {
        client_email: "sa@my-proj.iam.gserviceaccount.com",
        private_key:
          "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
      },
    });
    const creds = StorageStub.lastOpts?.credentials as {
      client_email: string;
      private_key: string;
    };
    expect(creds.client_email).toBe("sa@my-proj.iam.gserviceaccount.com");
    expect(creds.private_key).toMatch(/BEGIN PRIVATE KEY/u);
  });

  test("upload returns metadata from the post-save getMetadata round trip", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const result = await files.upload("a.txt", "hello", {
      cacheControl: "public, max-age=60",
      contentType: "text/plain",
      metadata: { author: "me" },
    });
    expect(result.key).toBe("a.txt");
    expect(result.size).toBe(5);
    expect(result.contentType).toBe("text/plain");
    expect(result.etag).toBe("etag-a.txt");
    expect(result.lastModified).toBe(STABLE_UPDATED_MS);

    expect(saveMock).toHaveBeenCalledTimes(1);
    const [saveCall] = saveMock.mock.calls;
    if (!saveCall) {
      throw new Error("expected save to have been called");
    }
    const [, saveOpts] = saveCall;
    const o = saveOpts as {
      contentType: string;
      resumable: boolean;
      metadata: { cacheControl?: string; metadata?: Record<string, string> };
    };
    expect(o.contentType).toBe("text/plain");
    expect(o.resumable).toBe(false);
    expect(o.metadata.cacheControl).toBe("public, max-age=60");
    expect(o.metadata.metadata).toEqual({ author: "me" });
  });

  test("upload of a Uint8Array passes a Buffer view to file.save", async () => {
    const adapter = gcs({ bucket: "uploads" });
    await adapter.upload("a.bin", new Uint8Array([1, 2, 3, 4]));
    const [saveCall] = saveMock.mock.calls;
    if (!saveCall) {
      throw new Error("expected save to have been called");
    }
    const [data] = saveCall;
    expect(Buffer.isBuffer(data)).toBe(true);
    expect((data as Buffer).byteLength).toBe(4);
  });

  test("upload of a ReadableStream pipes through createWriteStream and reports authoritative size", async () => {
    const adapter = gcs({ bucket: "uploads" });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello"));
        c.close();
      },
    });
    const result = await adapter.upload("s.txt", stream);
    expect(createWriteStreamMock).toHaveBeenCalledTimes(1);
    expect(saveMock).not.toHaveBeenCalled();
    // For streams we have no local content-length; the value comes from
    // the post-upload getMetadata.
    expect(result.size).toBe(5);
    expect(result.etag).toBe("etag-a.txt");
  });

  test("forwards resumable-upload progress to onProgress", async () => {
    // The resumable write stream emits 'progress' with cumulative bytesWritten.
    createWriteStreamMock.mockImplementationOnce(() => {
      const pt = new PassThrough();
      let written = 0;
      pt.on("data", (chunk: Buffer) => {
        written += chunk.length;
        pt.emit("progress", { bytesWritten: written });
      });
      return pt;
    });
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const events: { loaded: number; total?: number }[] = [];
    await files.upload("a.txt", "hello", {
      onProgress: (p) => events.push(p),
    });
    expect(createWriteStreamMock).toHaveBeenCalledTimes(1);
    expect(saveMock).not.toHaveBeenCalled();
    expect(events).toEqual([{ loaded: 5, total: 5 }]);
  });

  test("multipart: true uploads via a resumable createWriteStream", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const result = await files.upload("a.txt", "hello", { multipart: true });
    expect(createWriteStreamMock).toHaveBeenCalledTimes(1);
    expect(saveMock).not.toHaveBeenCalled();
    const opts = (createWriteStreamMock.mock.calls as unknown[][])[0]?.[0] as
      | { resumable: boolean; chunkSize?: number }
      | undefined;
    expect(opts?.resumable).toBe(true);
    expect(opts?.chunkSize).toBeUndefined();
    expect(result.size).toBe(5);
  });

  test("multipart partSize sets a 256 KiB-aligned chunkSize", async () => {
    const adapter = gcs({ bucket: "uploads" });
    await adapter.upload("a.txt", "hello", {
      multipart: { partSize: 1024 * 1024 },
    });
    const opts = (createWriteStreamMock.mock.calls as unknown[][])[0]?.[0] as
      | { resumable: boolean; chunkSize?: number }
      | undefined;
    expect(opts?.resumable).toBe(true);
    expect(opts?.chunkSize).toBe(1024 * 1024);
  });

  test("download returns a buffered StoredFile whose text matches the body", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const got = await files.download("a.txt");
    expect(await got.text()).toBe("hello");
    expect(got.size).toBe(5);
    expect(got.type).toBe("text/plain");
    expect(got.etag).toBe("etag-a.txt");
    expect(got.metadata).toEqual({ foo: "bar" });
  });

  test("download as: 'stream' returns a streaming StoredFile and skips file.download", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const got = await files.download("a.txt", { as: "stream" });
    expect(downloadMock).not.toHaveBeenCalled();
    // The stream factory is lazy — calling .stream() is what triggers
    // createReadStream, not the download() call itself.
    const reader = got.stream().getReader();
    expect(createReadStreamMock).toHaveBeenCalledTimes(1);
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

  test("range forwards inclusive start/end to file.download (buffer)", async () => {
    downloadMock.mockImplementationOnce(
      (opts?: { start?: number; end?: number }) => {
        const full = Buffer.from("hello");
        const slice = full.subarray(
          opts?.start ?? 0,
          opts?.end === undefined ? undefined : opts.end + 1
        );
        return Promise.resolve([slice] as [Buffer]);
      }
    );
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const got = await files.download("a.txt", { range: { end: 3, start: 1 } });
    expect(downloadMock).toHaveBeenCalledWith({ end: 3, start: 1 });
    expect(await got.text()).toBe("ell");
    expect(got.size).toBe(3);
  });

  test("open-ended range streams from start and sizes via metadata", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const got = await files.download("a.txt", {
      as: "stream",
      range: { start: 2 },
    });
    // metadata size is 5, so bytes 2..EOF is 3 bytes.
    expect(got.size).toBe(3);
    got.stream().getReader();
    expect(createReadStreamMock).toHaveBeenCalledWith({ start: 2 });
  });

  test("head returns metadata only and does not pre-fetch the body", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const info = await files.head("a.txt");
    expect(info.size).toBe(5);
    expect(info.type).toBe("text/plain");
    expect(info.etag).toBe("etag-a.txt");
    expect(downloadMock).not.toHaveBeenCalled();
  });

  test("head body is lazy — text() triggers a follow-up download()", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const info = await files.head("a.txt");
    downloadMock.mockClear();
    expect(await info.text()).toBe("hello");
    expect(downloadMock).toHaveBeenCalledTimes(1);
  });

  test("exists returns true/false from the SDK tuple response", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    await expect(files.exists("a.txt")).resolves.toBe(true);

    existsMock.mockImplementationOnce(() =>
      Promise.resolve([false] as [boolean])
    );
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("exists rethrows non-NotFound errors", async () => {
    existsMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("denied"), { code: 403 }))
    );
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    await expect(files.exists("a.txt")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("exists swallows a NotFound *thrown* by file().exists()", async () => {
    // The SDK's exists() normally returns [false] for misses, but it can
    // throw a 404 in some configurations — adapter must still report `false`.
    existsMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("not found"), { code: 404 }))
    );
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("delete delegates to file.delete()", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    await files.delete("a.txt");
    expect(deleteMock).toHaveBeenCalledTimes(1);
    const [fileCall] = bucketFileMock.mock.calls;
    if (!fileCall) {
      throw new Error("expected bucket.file to have been called");
    }
    expect(fileCall[0]).toBe("a.txt");
  });

  test("copy delegates to srcFile.copy(destFile)", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    await files.copy("a.txt", "b.txt");
    expect(copyMock).toHaveBeenCalledTimes(1);
    const fileNames = bucketFileMock.mock.calls.map((c) => c[0]);
    expect(fileNames).toContain("a.txt");
    expect(fileNames).toContain("b.txt");
  });

  test("list maps files into StoredFile items and forwards prefix/limit/cursor", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const out = await files.list({ cursor: "tok-1", limit: 10, prefix: "a/" });
    expect(out.items.map((i) => i.key)).toEqual(["a/1.txt", "a/2.txt"]);
    const [getFilesCall] = getFilesMock.mock.calls;
    if (!getFilesCall) {
      throw new Error("expected getFiles to have been called");
    }
    const opts = getFilesCall[0] as {
      autoPaginate: boolean;
      prefix: string;
      maxResults: number;
      pageToken: string;
    };
    expect(opts.autoPaginate).toBe(false);
    expect(opts.prefix).toBe("a/");
    expect(opts.maxResults).toBe(10);
    expect(opts.pageToken).toBe("tok-1");
  });

  test("list returns the next pageToken as cursor when more pages exist", async () => {
    getFilesMock.mockImplementationOnce(() =>
      Promise.resolve([
        [makeFile("a/1.txt", true)],
        { pageToken: "next-tok" },
        {},
      ])
    );
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const out = await files.list();
    expect(out.cursor).toBe("next-tok");
  });

  test("list omits cursor when the next query has no pageToken", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const out = await files.list();
    expect(out.cursor).toBeUndefined();
  });

  test("list items expose lazy bodies that fetch via file.download()", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const out = await files.list();
    const [item] = out.items;
    if (!item) {
      throw new Error("expected at least one list item");
    }
    downloadMock.mockClear();
    expect(await item.text()).toBe("hello");
    expect(downloadMock).toHaveBeenCalledTimes(1);
  });

  test("url returns publicBaseUrl when configured", async () => {
    const files = new Files({
      adapter: gcs({
        bucket: "uploads",
        publicBaseUrl: "https://cdn.example.com",
      }),
    });
    expect(await files.url("a.txt")).toBe("https://cdn.example.com/a.txt");
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  test("url tolerates a trailing slash on publicBaseUrl", async () => {
    const adapter = gcs({
      bucket: "uploads",
      publicBaseUrl: "https://cdn.example.com/",
    });
    expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
  });

  test("url falls back to a signed read URL when publicBaseUrl is unset", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const url = await files.url("a.txt");
    expect(url).toBe("https://signed.example.com/read?v=v4");
    const [signCall] = getSignedUrlMock.mock.calls;
    if (!signCall) {
      throw new Error("expected getSignedUrl to have been called");
    }
    const opts = signCall[0] as {
      action: string;
      version: string;
      expires: number;
    };
    expect(opts.action).toBe("read");
    expect(opts.version).toBe("v4");
    // expires is ms-since-epoch in the future.
    expect(opts.expires).toBeGreaterThan(Date.now());
  });

  test("url honors a per-call expiresIn", async () => {
    const adapter = gcs({ bucket: "uploads" });
    const before = Date.now();
    await adapter.url("a.txt", { expiresIn: 60 });
    const [signCall] = getSignedUrlMock.mock.calls;
    if (!signCall) {
      throw new Error("expected getSignedUrl to have been called");
    }
    const { expires } = signCall[0] as { expires: number };
    // Roughly before + 60s, with a small slack for test execution time.
    expect(expires).toBeGreaterThanOrEqual(before + 60_000 - 1000);
    expect(expires).toBeLessThanOrEqual(before + 60_000 + 5000);
  });

  test("url with responseContentDisposition forces signing even when publicBaseUrl is set", async () => {
    const files = new Files({
      adapter: gcs({
        bucket: "uploads",
        publicBaseUrl: "https://cdn.example.com",
      }),
    });
    const url = await files.url("a.txt", {
      responseContentDisposition: "attachment",
    });
    expect(url).toContain("https://signed.example.com/read");
    const [signCall] = getSignedUrlMock.mock.calls;
    if (!signCall) {
      throw new Error("expected getSignedUrl to have been called");
    }
    const opts = signCall[0] as { responseDisposition: string };
    expect(opts.responseDisposition).toBe("attachment");
  });

  test("signedUploadUrl without maxSize returns a PUT URL", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const out = await files.signedUploadUrl("a.txt", {
      contentType: "image/png",
      expiresIn: 60,
    });
    expect(out.method).toBe("PUT");
    if (out.method !== "PUT") {
      throw new Error("expected PUT");
    }
    expect(out.url).toContain("https://signed.example.com/write");
    expect(out.headers).toEqual({ "Content-Type": "image/png" });
    const [signCall] = getSignedUrlMock.mock.calls;
    if (!signCall) {
      throw new Error("expected getSignedUrl to have been called");
    }
    const opts = signCall[0] as {
      action: string;
      version: string;
      contentType: string;
    };
    expect(opts.action).toBe("write");
    expect(opts.version).toBe("v4");
    expect(opts.contentType).toBe("image/png");
  });

  test("signedUploadUrl with maxSize returns a POST policy with content-length-range", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    const out = await files.signedUploadUrl("a.txt", {
      contentType: "image/png",
      expiresIn: 60,
      maxSize: 5_000_000,
    });
    expect(out.method).toBe("POST");
    if (out.method !== "POST") {
      throw new Error("expected POST");
    }
    expect(out.url).toBe("https://gcs.example.com/policy");
    expect(out.fields.policy).toBe("abc");
    const [policyCall] = generateSignedPostPolicyV4Mock.mock.calls;
    if (!policyCall) {
      throw new Error(
        "expected generateSignedPostPolicyV4 to have been called"
      );
    }
    const opts = policyCall[0] as {
      conditions: unknown[][];
      fields?: Record<string, string>;
    };
    // Default minSize is 1 — we explicitly choose 1 over 0 so empty
    // uploads (a common silent-bug pattern) don't slip through.
    expect(opts.conditions[0]).toEqual(["content-length-range", 1, 5_000_000]);
    expect(opts.fields?.["content-type"]).toBe("image/png");
  });

  test("signedUploadUrl with minSize: 0 allows empty uploads through the policy", async () => {
    const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
    await files.signedUploadUrl("a.txt", {
      expiresIn: 60,
      maxSize: 1000,
      minSize: 0,
    });
    const [policyCall] = generateSignedPostPolicyV4Mock.mock.calls;
    if (!policyCall) {
      throw new Error(
        "expected generateSignedPostPolicyV4 to have been called"
      );
    }
    const opts = policyCall[0] as { conditions: unknown[][] };
    expect(opts.conditions[0]).toEqual(["content-length-range", 0, 1000]);
  });

  describe("error mapping", () => {
    test("404 maps to NotFound", () => {
      const err = mapGCSError(Object.assign(new Error("nope"), { code: 404 }));
      expect(err.code).toBe("NotFound");
      expect(err.message).toBe("nope");
    });

    test("403 maps to Unauthorized", () => {
      const err = mapGCSError(
        Object.assign(new Error("denied"), { code: 403 })
      );
      expect(err.code).toBe("Unauthorized");
    });

    test("401 maps to Unauthorized", () => {
      const err = mapGCSError(Object.assign(new Error("auth"), { code: 401 }));
      expect(err.code).toBe("Unauthorized");
    });

    test("409 maps to Conflict", () => {
      const err = mapGCSError(
        Object.assign(new Error("conflict"), { code: 409 })
      );
      expect(err.code).toBe("Conflict");
    });

    test("412 maps to Conflict (precondition failed)", () => {
      const err = mapGCSError(
        Object.assign(new Error("precondition"), { code: 412 })
      );
      expect(err.code).toBe("Conflict");
    });

    test("500 maps to Provider", () => {
      const err = mapGCSError(Object.assign(new Error("oops"), { code: 500 }));
      expect(err.code).toBe("Provider");
    });

    test("non-numeric code falls through to Provider with the underlying message", () => {
      const err = mapGCSError(
        Object.assign(new Error("boom"), { code: "ENOTFOUND" })
      );
      expect(err.code).toBe("Provider");
      expect(err.message).toBe("boom");
    });

    test("status field is honored when code is missing", () => {
      const err = mapGCSError(
        Object.assign(new Error("missing"), { status: 404 })
      );
      expect(err.code).toBe("NotFound");
    });

    test("download error is wrapped as FilesError", async () => {
      downloadMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("not here"), { code: 404 }))
      );
      const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
      try {
        await files.download("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("upload error is wrapped as FilesError", async () => {
      saveMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("denied"), { code: 403 }))
      );
      const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
      try {
        await files.upload("a.txt", "x");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("Unauthorized");
      }
    });

    test("an existing FilesError passes through unchanged (preserves code + cause)", () => {
      // Adapters call mapGCSError on whatever they catch, including a
      // FilesError that an inner helper already produced. Re-wrapping
      // would lose the original code/cause and double-prefix the message.
      const original = new FilesError("Conflict", "already there", {
        original: true,
      });
      const out = mapGCSError(original);
      expect(out).toBe(original);
      expect(out.code).toBe("Conflict");
      expect(out.cause).toEqual({ original: true });
    });

    test("copy error is wrapped as FilesError", async () => {
      copyMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("nope"), { code: 404 }))
      );
      const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
      try {
        await files.copy("a.txt", "b.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("delete error is wrapped as FilesError", async () => {
      deleteMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("denied"), { code: 403 }))
      );
      const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
      try {
        await files.delete("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("Unauthorized");
      }
    });

    test("head error is wrapped as FilesError", async () => {
      getMetadataMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("missing"), { code: 404 }))
      );
      const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
      try {
        await files.head("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("list error is wrapped as FilesError", async () => {
      getFilesMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("boom"), { code: 500 }))
      );
      const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
      try {
        await files.list();
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("Provider");
      }
    });

    test("signedUploadUrl PUT error is wrapped as FilesError", async () => {
      getSignedUrlMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("denied"), { code: 403 }))
      );
      const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
      try {
        await files.signedUploadUrl("a.txt", { expiresIn: 60 });
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("Unauthorized");
      }
    });

    test("signedUploadUrl POST error is wrapped as FilesError", async () => {
      generateSignedPostPolicyV4Mock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("oops"), { code: 500 }))
      );
      const files = new Files({ adapter: gcs({ bucket: "uploads" }) });
      try {
        await files.signedUploadUrl("a.txt", {
          expiresIn: 60,
          maxSize: 1000,
        });
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("Provider");
      }
    });
  });

  describe("body normalization", () => {
    test("upload of an ArrayBuffer surfaces the buffer's byteLength", async () => {
      const adapter = gcs({ bucket: "uploads" });
      const ab = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
      const result = await adapter.upload("a.bin", ab);
      expect(result.size).toBe(8);
      expect(result.contentType).toBe("application/octet-stream");
      const [saveCall] = saveMock.mock.calls;
      if (!saveCall) {
        throw new Error("expected save to have been called");
      }
      const [data] = saveCall;
      expect(Buffer.isBuffer(data)).toBe(true);
      expect((data as Buffer).byteLength).toBe(8);
    });

    test("upload of an ArrayBufferView (DataView) surfaces the view's byteLength", async () => {
      const adapter = gcs({ bucket: "uploads" });
      // 16-byte buffer with a 10-byte DataView starting at offset 4 — the
      // adapter must respect byteOffset + byteLength, not the underlying
      // buffer's full size, otherwise we'd over-read into adjacent bytes.
      const view = new DataView(new ArrayBuffer(16), 4, 10);
      const result = await adapter.upload("v.bin", view);
      expect(result.size).toBe(10);
      const [saveCall] = saveMock.mock.calls;
      if (!saveCall) {
        throw new Error("expected save to have been called");
      }
      const [data] = saveCall;
      expect(Buffer.isBuffer(data)).toBe(true);
      expect((data as Buffer).byteLength).toBe(10);
    });

    test("upload of a Blob preserves the blob's contentType when the caller doesn't override it", async () => {
      const adapter = gcs({ bucket: "uploads" });
      const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
        type: "image/jpeg",
      });
      const result = await adapter.upload("photo.jpg", blob);
      expect(result.size).toBe(3);
      expect(result.contentType).toBe("image/jpeg");
      const [saveCall] = saveMock.mock.calls;
      if (!saveCall) {
        throw new Error("expected save to have been called");
      }
      const [, opts] = saveCall;
      expect((opts as { contentType: string }).contentType).toBe("image/jpeg");
    });

    test("upload of a Blob lets the explicit contentType override the blob's type", async () => {
      const adapter = gcs({ bucket: "uploads" });
      const blob = new Blob(["hello"], { type: "text/plain" });
      const result = await adapter.upload("a.bin", blob, {
        contentType: "application/octet-stream",
      });
      expect(result.contentType).toBe("application/octet-stream");
    });
  });
});
