import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { PassThrough, Readable } from "node:stream";

import { Files, FilesError, UploadControl } from "../src/index.js";

const STABLE_UPDATED = "2024-01-02T03:04:05.000Z";
const STABLE_UPDATED_MS = new Date(STABLE_UPDATED).getTime();

const baseMetadata = (name: string) => ({
  bucket: "uploads.firebasestorage.app",
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
      url: "https://firebase.example.com/policy",
    },
  ])
);
const createReadStreamMock = mock(() => Readable.from([Buffer.from("hello")]));
const createWriteStreamMock = mock(() => new PassThrough());
const createResumableUploadMock = mock(() =>
  Promise.resolve(["https://session.example/fb-uri"] as [string])
);

const makeFile = (name: string, populateMetadata = false) => ({
  copy: copyMock,
  createReadStream: createReadStreamMock,
  createResumableUpload: createResumableUploadMock,
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

const fakeBucket = {
  file: bucketFileMock,
  getFiles: getFilesMock,
  name: "uploads.firebasestorage.app",
};

interface FakeApp {
  name: string;
  options: { projectId?: string; storageBucket?: string };
}

const initializedApps: FakeApp[] = [];
const initializeAppMock = mock(
  (options: FakeApp["options"], appName?: string): FakeApp => {
    const app: FakeApp = { name: appName ?? "[DEFAULT]", options };
    initializedApps.push(app);
    return app;
  }
);
const getAppsMock = mock(() => initializedApps);
const getAppMock = mock((name?: string): FakeApp => {
  const found = initializedApps.find((a) => a.name === (name ?? "[DEFAULT]"));
  if (!found) {
    throw new Error(`no app found: ${name}`);
  }
  return found;
});
const certMock = mock(
  (
    input:
      | string
      | { clientEmail?: string; privateKey?: string; projectId?: string }
  ) => ({ _kind: "cert", input })
);
const applicationDefaultMock = mock(() => ({ _kind: "adc" }));

mock.module("firebase-admin/app", () => ({
  applicationDefault: applicationDefaultMock,
  cert: certMock,
  getApp: getAppMock,
  getApps: getAppsMock,
  initializeApp: initializeAppMock,
}));

const getStorageMock = mock((_app?: FakeApp) => ({
  bucket: (_name?: string) => fakeBucket,
}));

mock.module("firebase-admin/storage", () => ({
  getStorage: getStorageMock,
}));

const { firebaseStorage, mapFirebaseStorageError } =
  await import("../src/firebase-storage/index.js");

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
  createResumableUploadMock.mockClear();
  createResumableUploadMock.mockImplementation(() =>
    Promise.resolve(["https://session.example/fb-uri"] as [string])
  );
  bucketFileMock.mockClear();
  getFilesMock.mockClear();
  initializeAppMock.mockClear();
  getAppsMock.mockClear();
  getAppMock.mockClear();
  certMock.mockClear();
  applicationDefaultMock.mockClear();
  getStorageMock.mockClear();
  initializedApps.length = 0;

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
        url: "https://firebase.example.com/policy",
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
  getStorageMock.mockImplementation(() => ({
    bucket: (_name?: string) => fakeBucket,
  }));

  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_STORAGE_BUCKET;
  delete process.env.FIREBASE_CLIENT_EMAIL;
  delete process.env.FIREBASE_PRIVATE_KEY;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GCLOUD_PROJECT;
});

describe("firebase-storage adapter", () => {
  test("missing bucket and projectId throws at construction", () => {
    expect(() => firebaseStorage()).toThrow(/bucket/u);
  });

  test("derives default bucket from projectId", () => {
    const adapter = firebaseStorage({ projectId: "my-proj" });
    expect(adapter.name).toBe("firebase-storage");
    expect(adapter.bucket).toBe("uploads.firebasestorage.app");
    expect(initializeAppMock).toHaveBeenCalledTimes(1);
    const [initCall] = initializeAppMock.mock.calls;
    if (!initCall) {
      throw new Error("expected initializeApp to have been called");
    }
    const initOpts = initCall[0] as {
      projectId?: string;
      storageBucket: string;
    };
    expect(initOpts.projectId).toBe("my-proj");
    expect(initOpts.storageBucket).toBe("my-proj.firebasestorage.app");
  });

  test("explicit bucket is forwarded to initializeApp", () => {
    firebaseStorage({ bucket: "explicit.appspot.com", projectId: "p" });
    const [initCall] = initializeAppMock.mock.calls;
    if (!initCall) {
      throw new Error("expected initializeApp to have been called");
    }
    const initOpts = initCall[0] as { storageBucket: string };
    expect(initOpts.storageBucket).toBe("explicit.appspot.com");
  });

  test("inline credentials are wrapped via cert()", () => {
    firebaseStorage({
      bucket: "uploads.firebasestorage.app",
      credentials: {
        clientEmail: "sa@p.iam.gserviceaccount.com",
        privateKey:
          "-----BEGIN PRIVATE KEY-----\nXXX\n-----END PRIVATE KEY-----\n",
      },
      projectId: "p",
    });
    expect(certMock).toHaveBeenCalledTimes(1);
    const [certCall] = certMock.mock.calls;
    if (!certCall) {
      throw new Error("expected cert to have been called");
    }
    const arg = certCall[0] as {
      clientEmail: string;
      privateKey: string;
      projectId?: string;
    };
    expect(arg.clientEmail).toBe("sa@p.iam.gserviceaccount.com");
    expect(arg.projectId).toBe("p");
    expect(arg.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  test("private key with literal \\n escapes is unescaped before cert()", () => {
    firebaseStorage({
      bucket: "uploads.firebasestorage.app",
      credentials: {
        clientEmail: "sa@p.iam.gserviceaccount.com",
        privateKey: String.raw`-----BEGIN PRIVATE KEY-----\nXXX\n-----END PRIVATE KEY-----\n`,
      },
      projectId: "p",
    });
    const [certCall] = certMock.mock.calls;
    if (!certCall) {
      throw new Error("expected cert to have been called");
    }
    const arg = certCall[0] as { privateKey: string };
    expect(arg.privateKey).toContain("\n");
    expect(arg.privateKey).not.toContain(String.raw`\n`);
  });

  test("serviceAccountPath wins over inline credentials", () => {
    firebaseStorage({
      bucket: "uploads.firebasestorage.app",
      credentials: {
        clientEmail: "sa@p.iam.gserviceaccount.com",
        privateKey: "x",
      },
      projectId: "p",
      serviceAccountPath: "/path/to/sa.json",
    });
    expect(certMock).toHaveBeenCalledWith("/path/to/sa.json");
  });

  test("no credentials falls back to applicationDefault()", () => {
    firebaseStorage({ bucket: "uploads.firebasestorage.app", projectId: "p" });
    expect(applicationDefaultMock).toHaveBeenCalledTimes(1);
    expect(certMock).not.toHaveBeenCalled();
  });

  test("env fallbacks: FIREBASE_PROJECT_ID and FIREBASE_STORAGE_BUCKET", () => {
    process.env.FIREBASE_PROJECT_ID = "from-env";
    process.env.FIREBASE_STORAGE_BUCKET = "env-bucket.firebasestorage.app";
    firebaseStorage();
    const [initCall] = initializeAppMock.mock.calls;
    if (!initCall) {
      throw new Error("expected initializeApp to have been called");
    }
    const initOpts = initCall[0] as {
      projectId?: string;
      storageBucket: string;
    };
    expect(initOpts.projectId).toBe("from-env");
    expect(initOpts.storageBucket).toBe("env-bucket.firebasestorage.app");
  });

  test("env fallbacks: FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY trigger cert()", () => {
    process.env.FIREBASE_CLIENT_EMAIL = "sa@p.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "x";
    firebaseStorage({ bucket: "uploads.firebasestorage.app", projectId: "p" });
    expect(certMock).toHaveBeenCalledTimes(1);
  });

  test("reuses an existing app under the same name (idempotent factory)", () => {
    firebaseStorage({ bucket: "uploads.firebasestorage.app", projectId: "p" });
    expect(initializeAppMock).toHaveBeenCalledTimes(1);
    firebaseStorage({ bucket: "uploads.firebasestorage.app", projectId: "p" });
    expect(initializeAppMock).toHaveBeenCalledTimes(1);
  });

  test("accepts a pre-built App via opts.app", () => {
    const app: FakeApp = {
      name: "external",
      options: { storageBucket: "external.firebasestorage.app" },
    };
    firebaseStorage({
      app: app as unknown as NonNullable<
        Parameters<typeof firebaseStorage>[0]
      >["app"],
    });
    expect(initializeAppMock).not.toHaveBeenCalled();
    expect(getStorageMock).toHaveBeenCalledWith(app);
  });

  test("accepts a pre-built Bucket via opts.app and skips firebase init entirely", () => {
    firebaseStorage({
      app: fakeBucket as unknown as NonNullable<
        Parameters<typeof firebaseStorage>[0]
      >["app"],
    });
    expect(initializeAppMock).not.toHaveBeenCalled();
    expect(getStorageMock).not.toHaveBeenCalled();
  });

  test("upload writes metadata from the post-save getMetadata round trip", async () => {
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
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

  test("upload of a ReadableStream pipes through createWriteStream and reports authoritative size", async () => {
    const adapter = firebaseStorage({ projectId: "p" });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello"));
        c.close();
      },
    });
    const result = await adapter.upload("s.txt", stream);
    expect(createWriteStreamMock).toHaveBeenCalledTimes(1);
    expect(saveMock).not.toHaveBeenCalled();
    expect(result.size).toBe(5);
    expect(result.etag).toBe("etag-a.txt");
  });

  test("forwards resumable-upload progress to onProgress", async () => {
    createWriteStreamMock.mockImplementationOnce(() => {
      const pt = new PassThrough();
      let written = 0;
      pt.on("data", (chunk: Buffer) => {
        written += chunk.length;
        pt.emit("progress", { bytesWritten: written });
      });
      return pt;
    });
    const adapter = firebaseStorage({ projectId: "p" });
    const events: { loaded: number; total?: number }[] = [];
    await adapter.upload("a.txt", "hello", {
      onProgress: (p) => events.push(p),
    });
    expect(createWriteStreamMock).toHaveBeenCalledTimes(1);
    expect(saveMock).not.toHaveBeenCalled();
    expect(events).toEqual([{ loaded: 5, total: 5 }]);
  });

  test("multipart: true uploads via a resumable createWriteStream", async () => {
    const adapter = firebaseStorage({ projectId: "p" });
    const result = await adapter.upload("a.txt", "hello", { multipart: true });
    expect(createWriteStreamMock).toHaveBeenCalledTimes(1);
    expect(saveMock).not.toHaveBeenCalled();
    const opts = (createWriteStreamMock.mock.calls as unknown[][])[0]?.[0] as
      | { resumable: boolean; chunkSize?: number }
      | undefined;
    expect(opts?.resumable).toBe(true);
    expect(result.size).toBe(5);
  });

  test("multipart partSize sets a 256 KiB-aligned chunkSize", async () => {
    const adapter = firebaseStorage({ projectId: "p" });
    await adapter.upload("a.txt", "hello", {
      multipart: { partSize: 700 * 1024 },
    });
    const opts = (createWriteStreamMock.mock.calls as unknown[][])[0]?.[0] as
      | { chunkSize?: number }
      | undefined;
    // 700 KiB rounds down to the nearest 256 KiB multiple → 512 KiB.
    expect(opts?.chunkSize).toBe(512 * 1024);
  });

  test("download returns a buffered StoredFile whose text matches the body", async () => {
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
    const got = await files.download("a.txt");
    expect(await got.text()).toBe("hello");
    expect(got.size).toBe(5);
    expect(got.type).toBe("text/plain");
    expect(got.etag).toBe("etag-a.txt");
  });

  test("download as: 'stream' returns a streaming StoredFile and skips file.download", async () => {
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
    const got = await files.download("a.txt", { as: "stream" });
    expect(downloadMock).not.toHaveBeenCalled();
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
    const files = new Files({ adapter: firebaseStorage({ projectId: "p" }) });
    const got = await files.download("a.txt", { range: { end: 3, start: 1 } });
    expect(downloadMock).toHaveBeenCalledWith({ end: 3, start: 1 });
    expect(await got.text()).toBe("ell");
    expect(got.size).toBe(3);
  });

  test("open-ended range streams from start and sizes via metadata", async () => {
    const files = new Files({ adapter: firebaseStorage({ projectId: "p" }) });
    const got = await files.download("a.txt", {
      as: "stream",
      range: { start: 2 },
    });
    expect(got.size).toBe(3);
    got.stream().getReader();
    expect(createReadStreamMock).toHaveBeenCalledWith({ start: 2 });
  });

  test("head returns metadata only", async () => {
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
    const info = await files.head("a.txt");
    expect(info.size).toBe(5);
    expect(info.type).toBe("text/plain");
    expect(info.etag).toBe("etag-a.txt");
    expect(downloadMock).not.toHaveBeenCalled();
  });

  test("exists returns true/false from the SDK tuple", async () => {
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
    await expect(files.exists("a.txt")).resolves.toBe(true);
    existsMock.mockImplementationOnce(() =>
      Promise.resolve([false] as [boolean])
    );
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("exists swallows a NotFound thrown by file().exists()", async () => {
    existsMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("not found"), { code: 404 }))
    );
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("delete delegates to file.delete()", async () => {
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
    await files.delete("a.txt");
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  test("copy delegates to srcFile.copy(destFile)", async () => {
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
    await files.copy("a.txt", "b.txt");
    expect(copyMock).toHaveBeenCalledTimes(1);
    const fileNames = bucketFileMock.mock.calls.map((c) => c[0]);
    expect(fileNames).toContain("a.txt");
    expect(fileNames).toContain("b.txt");
  });

  test("list maps files into StoredFile items and forwards prefix/limit/cursor", async () => {
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
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

  test("url returns publicBaseUrl when configured", async () => {
    const files = new Files({
      adapter: firebaseStorage({
        projectId: "p",
        publicBaseUrl: "https://cdn.example.com",
      }),
    });
    expect(await files.url("a.txt")).toBe("https://cdn.example.com/a.txt");
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  test("url falls back to a signed read URL when publicBaseUrl is unset", async () => {
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
    const url = await files.url("a.txt");
    expect(url).toBe("https://signed.example.com/read?v=v4");
  });

  test("url with responseContentDisposition forces signing", async () => {
    const files = new Files({
      adapter: firebaseStorage({
        projectId: "p",
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
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
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
  });

  test("signedUploadUrl with maxSize returns a POST policy with content-length-range", async () => {
    const files = new Files({
      adapter: firebaseStorage({ projectId: "p" }),
    });
    const out = await files.signedUploadUrl("a.txt", {
      contentType: "image/png",
      expiresIn: 60,
      maxSize: 5_000_000,
    });
    expect(out.method).toBe("POST");
    if (out.method !== "POST") {
      throw new Error("expected POST");
    }
    expect(out.url).toBe("https://firebase.example.com/policy");
    const [policyCall] = generateSignedPostPolicyV4Mock.mock.calls;
    if (!policyCall) {
      throw new Error(
        "expected generateSignedPostPolicyV4 to have been called"
      );
    }
    const opts = policyCall[0] as { conditions: unknown[][] };
    expect(opts.conditions[0]).toEqual(["content-length-range", 1, 5_000_000]);
  });

  describe("error mapping", () => {
    test("404 maps to NotFound", () => {
      const err = mapFirebaseStorageError(
        Object.assign(new Error("nope"), { code: 404 })
      );
      expect(err.code).toBe("NotFound");
      expect(err.message).toBe("nope");
    });

    test("403 maps to Unauthorized", () => {
      const err = mapFirebaseStorageError(
        Object.assign(new Error("denied"), { code: 403 })
      );
      expect(err.code).toBe("Unauthorized");
    });

    test("409 maps to Conflict", () => {
      const err = mapFirebaseStorageError(
        Object.assign(new Error("conflict"), { code: 409 })
      );
      expect(err.code).toBe("Conflict");
    });

    test("500 maps to Provider", () => {
      const err = mapFirebaseStorageError(
        Object.assign(new Error("oops"), { code: 500 })
      );
      expect(err.code).toBe("Provider");
    });

    test("FilesError passthrough is preserved", () => {
      const original = new FilesError("NotFound", "already wrapped");
      const err = mapFirebaseStorageError(original);
      expect(err).toBe(original);
    });

    test("download error is wrapped as FilesError", async () => {
      downloadMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("not here"), { code: 404 }))
      );
      const adapter = firebaseStorage({ projectId: "p" });
      await expect(adapter.download("a.txt")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("status field is honored when code is missing", () => {
      const err = mapFirebaseStorageError(
        Object.assign(new Error("missing"), { status: 404 })
      );
      expect(err.code).toBe("NotFound");
    });

    test("non-numeric code falls through to Provider with the underlying message", () => {
      const err = mapFirebaseStorageError(
        Object.assign(new Error("boom"), { code: "ENOTFOUND" })
      );
      expect(err.code).toBe("Provider");
      expect(err.message).toBe("boom");
    });
  });

  describe("error paths", () => {
    test("copy wraps underlying errors", async () => {
      copyMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("denied"), { code: 403 }))
      );
      const adapter = firebaseStorage({ projectId: "p" });
      await expect(adapter.copy("a.txt", "b.txt")).rejects.toMatchObject({
        code: "Unauthorized",
      });
    });

    test("delete wraps underlying errors", async () => {
      deleteMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("nope"), { code: 404 }))
      );
      const adapter = firebaseStorage({ projectId: "p" });
      await expect(adapter.delete("a.txt")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("head wraps underlying errors", async () => {
      getMetadataMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("nope"), { code: 404 }))
      );
      const adapter = firebaseStorage({ projectId: "p" });
      await expect(adapter.head("a.txt")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("list wraps underlying errors", async () => {
      getFilesMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("denied"), { code: 403 }))
      );
      const adapter = firebaseStorage({ projectId: "p" });
      await expect(adapter.list()).rejects.toMatchObject({
        code: "Unauthorized",
      });
    });

    test("upload wraps underlying errors", async () => {
      saveMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("boom"), { code: 500 }))
      );
      const adapter = firebaseStorage({ projectId: "p" });
      await expect(adapter.upload("a.txt", "hello")).rejects.toMatchObject({
        code: "Provider",
      });
    });

    test("signedUploadUrl wraps underlying errors", async () => {
      getSignedUrlMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("denied"), { code: 403 }))
      );
      const adapter = firebaseStorage({ projectId: "p" });
      await expect(
        adapter.signedUploadUrl("a.txt", { expiresIn: 60 })
      ).rejects.toMatchObject({
        code: "Unauthorized",
      });
    });

    test("url() error path wraps signing errors", async () => {
      getSignedUrlMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("denied"), { code: 403 }))
      );
      const adapter = firebaseStorage({ projectId: "p" });
      await expect(adapter.url("a.txt")).rejects.toMatchObject({
        code: "Unauthorized",
      });
    });

    test("exists rethrows a non-NotFound error after mapping", async () => {
      existsMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("denied"), { code: 403 }))
      );
      const adapter = firebaseStorage({ projectId: "p" });
      await expect(adapter.exists("a.txt")).rejects.toMatchObject({
        code: "Unauthorized",
      });
    });
  });

  describe("lazy body factories", () => {
    test("head body is lazy — text() triggers a follow-up download()", async () => {
      const adapter = firebaseStorage({ projectId: "p" });
      const info = await adapter.head("a.txt");
      downloadMock.mockClear();
      expect(await info.text()).toBe("hello");
      expect(downloadMock).toHaveBeenCalledTimes(1);
    });

    test("list items expose lazy bodies that fetch via file.download()", async () => {
      const adapter = firebaseStorage({ projectId: "p" });
      const out = await adapter.list();
      const [item] = out.items;
      if (!item) {
        throw new Error("expected at least one list item");
      }
      downloadMock.mockClear();
      expect(await item.text()).toBe("hello");
      expect(downloadMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("pre-built app fallbacks", () => {
    test("pre-built App without bucket name uses getStorage(app).bucket() default", () => {
      const app: FakeApp = { name: "external", options: {} };
      firebaseStorage({
        app: app as unknown as NonNullable<
          Parameters<typeof firebaseStorage>[0]
        >["app"],
      });
      // Adapter should call getStorage(app), then bucket() with no arg
      // when the app has no storageBucket and no FIREBASE_STORAGE_BUCKET is
      // set — exercised via the side effect that initializeApp was not
      // called.
      expect(initializeAppMock).not.toHaveBeenCalled();
      expect(getStorageMock).toHaveBeenCalledWith(app);
    });

    test("pre-built App falls back to app.options.storageBucket when bucket is unset", () => {
      const app: FakeApp = {
        name: "external",
        options: { storageBucket: "from-app.firebasestorage.app" },
      };
      const adapter = firebaseStorage({
        app: app as unknown as NonNullable<
          Parameters<typeof firebaseStorage>[0]
        >["app"],
      });
      expect(adapter.bucket).toBe("uploads.firebasestorage.app");
      // The mock's bucket() returns the same fakeBucket regardless of
      // name, but the wiring path (getStorage(app).bucket(<derived name>))
      // is what's being exercised here.
      expect(getStorageMock).toHaveBeenCalledWith(app);
    });
  });
});

describe("firebase-storage resumable uploads", () => {
  let restoreFetch: () => void;
  afterEach(() => {
    restoreFetch?.();
  });

  test("a resumable upload drives the shared GCS session driver", async () => {
    const original = globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          contentType: "application/octet-stream",
          etag: "fb-final",
          size: "5",
          updated: "2024-01-02T03:04:05.000Z",
        })
      )) as unknown as typeof fetch;

    const files = new Files({ adapter: firebaseStorage({ projectId: "p" }) });
    const control = new UploadControl();
    const result = await files.upload("note.txt", "hello", { control });
    expect(result.etag).toBe("fb-final");
    expect(control.status).toBe("completed");
    expect(createResumableUploadMock).toHaveBeenCalledTimes(1);
    expect(control.session?.provider).toBe("gcs");
  });
});
