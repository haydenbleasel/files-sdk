// oxlint-disable promise/prefer-await-to-callbacks -- Cloudinary's upload_stream and node Writable are callback-shaped by design.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Writable } from "node:stream";

import { cloudinary, mapCloudinaryError } from "../src/cloudinary/index.js";
import { Files, FilesError } from "../src/index.js";

const CLOUD_NAME = "test-cloud";
const API_KEY = "test-key";
const API_SECRET = "test-secret";

const configMock = mock(() => ({}));

const uploadStreamMock = mock(
  (_opts: unknown, callback: (err: Error | null, result?: unknown) => void) => {
    let captured: Buffer = Buffer.alloc(0);
    const stream = new Writable({
      final(cb) {
        callback(null, {
          bytes: captured.byteLength,
          created_at: "2024-01-01T00:00:00Z",
          etag: "etag-123",
          format: "txt",
          public_id: "test-file",
          resource_type: "raw",
          secure_url: `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/test-file`,
          type: "upload",
          url: `http://res.cloudinary.com/${CLOUD_NAME}/raw/upload/test-file`,
          version: 1,
        });
        cb();
      },
      write(chunk: Buffer, _enc, cb) {
        captured = Buffer.concat([captured, chunk]);
        cb();
      },
    });
    return stream;
  }
);

const uploadMock = mock((_url: string, _opts: unknown) =>
  Promise.resolve({
    bytes: 5,
    public_id: "destination",
    resource_type: "raw",
  })
);

const destroyMock = mock((_id: string, _opts: unknown) =>
  Promise.resolve({ result: "ok" })
);

const renameMock = mock((_from: string, _to: string, _opts: unknown) =>
  Promise.resolve({ public_id: "destination", resource_type: "raw" })
);

const resourceMock = mock((_id: string, _opts: unknown) =>
  Promise.resolve({
    bytes: 5,
    created_at: "2024-01-01T00:00:00Z",
    etag: "etag-123",
    format: "txt",
    public_id: "test-file",
    resource_type: "raw",
    secure_url: `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/test-file.txt`,
    type: "upload",
  })
);

const resourcesMock = mock((_opts: unknown) =>
  Promise.resolve({
    resources: [
      {
        bytes: 5,
        created_at: "2024-01-01T00:00:00Z",
        etag: "etag-a",
        format: "txt",
        public_id: "a.txt",
        resource_type: "raw",
        type: "upload",
      },
      {
        bytes: 10,
        created_at: "2024-01-01T00:00:00Z",
        etag: "etag-b",
        format: "txt",
        public_id: "b.txt",
        resource_type: "raw",
        type: "upload",
      },
    ],
  })
);

const urlMock = mock(
  (publicId: string, opts: { resource_type?: string; type?: string }) =>
    `https://res.cloudinary.com/${CLOUD_NAME}/${opts.resource_type ?? "raw"}/${opts.type ?? "upload"}/${publicId}`
);

const apiSignRequestMock = mock(
  (_params: Record<string, unknown>, _secret: string) => "signature-abc"
);

const privateDownloadUrlMock = mock(
  (publicId: string, format: string, opts: Record<string, unknown>) =>
    `https://res.cloudinary.com/${CLOUD_NAME}/raw/private/${publicId}.${format}?expires=${opts.expires_at as number}&signed=1`
);

mock.module("cloudinary", () => ({
  v2: {
    api: {
      resource: resourceMock,
      resources: resourcesMock,
    },
    config: configMock,
    uploader: {
      destroy: destroyMock,
      rename: renameMock,
      upload: uploadMock,
      upload_stream: uploadStreamMock,
    },
    url: urlMock,
    utils: {
      api_sign_request: apiSignRequestMock,
      private_download_url: privateDownloadUrlMock,
    },
  },
}));

const originalFetch = globalThis.fetch;

describe("cloudinary adapter", () => {
  beforeEach(() => {
    configMock.mockClear();
    uploadStreamMock.mockClear();
    uploadMock.mockClear();
    destroyMock.mockClear();
    renameMock.mockClear();
    resourceMock.mockClear();
    resourcesMock.mockClear();
    urlMock.mockClear();
    apiSignRequestMock.mockClear();
    privateDownloadUrlMock.mockClear();
    delete process.env.CLOUDINARY_URL;
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("construction > missing cloudName throws", () => {
    expect(
      () =>
        new Files({
          adapter: cloudinary({}),
        })
    ).toThrow(/missing cloudName/u);
  });

  test("construction > picks up CLOUDINARY_URL", () => {
    process.env.CLOUDINARY_URL = `cloudinary://${API_KEY}:${API_SECRET}@${CLOUD_NAME}`;
    const files = new Files({ adapter: cloudinary({}) });
    expect(files.adapter.name).toBe("cloudinary");
    expect(configMock).toHaveBeenCalledWith(
      expect.objectContaining({
        api_key: API_KEY,
        api_secret: API_SECRET,
        cloud_name: CLOUD_NAME,
      })
    );
  });

  test("construction > picks up individual env vars", () => {
    process.env.CLOUDINARY_CLOUD_NAME = CLOUD_NAME;
    process.env.CLOUDINARY_API_KEY = API_KEY;
    process.env.CLOUDINARY_API_SECRET = API_SECRET;
    const files = new Files({ adapter: cloudinary({}) });
    expect(files.adapter.name).toBe("cloudinary");
  });

  test("construction > resourceType defaults to raw", () => {
    const adapter = cloudinary({ cloudName: CLOUD_NAME });
    expect(adapter.resourceType).toBe("raw");
    expect(adapter.type).toBe("upload");
  });

  test("upload > delegates to upload_stream and returns metadata", async () => {
    const files = new Files({
      adapter: cloudinary({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        cloudName: CLOUD_NAME,
      }),
    });
    const result = await files.upload("test-file", "hello");
    expect(uploadStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        overwrite: true,
        public_id: "test-file",
        resource_type: "raw",
        type: "upload",
      }),
      expect.any(Function)
    );
    expect(result.key).toBe("test-file");
    expect(result.size).toBe(5);
    expect(result.etag).toBe("etag-123");
    expect(result.lastModified).toBe(
      new Date("2024-01-01T00:00:00Z").getTime()
    );
  });

  test("upload > accepts Uint8Array body", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await files.upload("k", new Uint8Array([1, 2, 3]));
    expect(uploadStreamMock).toHaveBeenCalled();
  });

  test("upload > rejects cacheControl", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(
      files.upload("k", "data", { cacheControl: "max-age=60" })
    ).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("cacheControl"),
    });
  });

  test("upload > rejects non-empty metadata", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(
      files.upload("k", "data", { metadata: { owner: "alice" } })
    ).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("metadata"),
    });
  });

  test("upload > accepts empty metadata object", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    const result = await files.upload("k", "data", { metadata: {} });
    expect(result.key).toBe("test-file");
  });

  test("download > fetches the file and returns StoredFile", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("hello", {
          headers: { "content-type": "text/plain" },
          status: 200,
        })
      )
    ) as unknown as typeof globalThis.fetch;
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    const file = await files.download("test-file");
    expect(file.key).toBe("test-file");
    expect(file.size).toBe(5);
    expect(file.etag).toBe("etag-123");
    expect(await file.text()).toBe("hello");
  });

  test("download > surfaces 404 as NotFound", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("", { status: 404 }))
    ) as unknown as typeof globalThis.fetch;
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.download("missing")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("download > forwards a Range header and reports the slice length", async () => {
    let seenRange: string | null | undefined;
    globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
      seenRange = new Headers(init?.headers).get("range");
      return Promise.resolve(
        new Response("ell", {
          headers: { "content-type": "text/plain" },
          status: 206,
        })
      );
    }) as unknown as typeof globalThis.fetch;
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    const file = await files.download("test-file", {
      range: { end: 3, start: 1 },
    });
    expect(seenRange).toBe("bytes=1-3");
    expect(await file.text()).toBe("ell");
    // The full asset is larger; a ranged read reports the slice length.
    expect(file.size).toBe(3);
  });

  test("head > returns lazy StoredFile that fetches on read", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("hello", {
          headers: { "content-type": "text/plain" },
          status: 200,
        })
      )
    ) as unknown as typeof globalThis.fetch;
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    const file = await files.head("test-file");
    expect(file.key).toBe("test-file");
    expect(file.size).toBe(5);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await file.text()).toBe("hello");
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  test("exists > returns true when found", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.exists("test-file")).resolves.toBe(true);
  });

  test("exists > returns false on 404", async () => {
    resourceMock.mockRejectedValueOnce({
      error: { http_code: 404, message: "Not found" },
    });
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.exists("missing")).resolves.toBe(false);
  });

  test("exists > rethrows non-NotFound errors", async () => {
    resourceMock.mockRejectedValueOnce({
      error: { http_code: 401, message: "Unauthorized" },
    });
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.exists("k")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("delete > delegates to uploader.destroy", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await files.delete("test-file");
    expect(destroyMock).toHaveBeenCalledWith(
      "test-file",
      expect.objectContaining({
        invalidate: true,
        resource_type: "raw",
        type: "upload",
      })
    );
  });

  test("copy > re-uploads from delivery URL", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await files.copy("source", "destination");
    expect(urlMock).toHaveBeenCalledWith(
      "source",
      expect.objectContaining({ resource_type: "raw", type: "upload" })
    );
    expect(uploadMock).toHaveBeenCalledWith(
      expect.stringContaining("source"),
      expect.objectContaining({
        overwrite: true,
        public_id: "destination",
        resource_type: "raw",
        type: "upload",
      })
    );
  });

  test("move > delegates to native uploader.rename, not copy+delete", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await files.move("source", "destination");
    expect(renameMock).toHaveBeenCalledWith(
      "source",
      "destination",
      expect.objectContaining({ resource_type: "raw", type: "upload" })
    );
    // Native rename — no byte round-trip, no separate delete.
    expect(uploadMock).not.toHaveBeenCalled();
    expect(destroyMock).not.toHaveBeenCalled();
  });

  test("list > forwards prefix and cursor; clamps limit", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await files.list({ cursor: "next-cursor", limit: 1000, prefix: "user-1/" });
    expect(resourcesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        max_results: 500,
        next_cursor: "next-cursor",
        prefix: "user-1/",
        resource_type: "raw",
        type: "upload",
      })
    );
  });

  test("list > maps response to StoredFile items", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    const { items, cursor } = await files.list();
    expect(items).toHaveLength(2);
    expect(items[0]?.key).toBe("a.txt");
    expect(items[0]?.etag).toBe("etag-a");
    expect(cursor).toBeUndefined();
  });

  test("list > surfaces next_cursor when present", async () => {
    resourcesMock.mockResolvedValueOnce({
      next_cursor: "page-2",
      resources: [
        {
          bytes: 5,
          created_at: "2024-01-01T00:00:00Z",
          etag: "x",
          format: "txt",
          public_id: "x.txt",
          resource_type: "raw",
          type: "upload",
        },
      ],
    } as never);
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    const { cursor } = await files.list();
    expect(cursor).toBe("page-2");
  });

  test("url > returns public delivery URL for type=upload", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    const url = await files.url("test-file");
    expect(url).toContain(CLOUD_NAME);
    expect(url).toContain("test-file");
    expect(urlMock).toHaveBeenCalledWith(
      "test-file",
      expect.objectContaining({
        resource_type: "raw",
        secure: true,
        type: "upload",
      })
    );
  });

  test("url > rejects responseContentDisposition", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(
      files.url("test-file", { responseContentDisposition: "attachment" })
    ).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("responseContentDisposition"),
    });
  });

  test("url > mints signed URL for type=private with expiresIn", async () => {
    const files = new Files({
      adapter: cloudinary({
        cloudName: CLOUD_NAME,
        type: "private",
      }),
    });
    const url = await files.url("test-file", { expiresIn: 60 });
    expect(privateDownloadUrlMock).toHaveBeenCalledWith(
      "test-file",
      "txt",
      expect.objectContaining({
        resource_type: "raw",
        type: "private",
      })
    );
    expect(url).toContain("private");
    expect(url).toContain("signed=1");
  });

  test("signedUploadUrl > computes signature and returns POST shape", async () => {
    const files = new Files({
      adapter: cloudinary({
        apiKey: API_KEY,
        apiSecret: API_SECRET,
        cloudName: CLOUD_NAME,
      }),
    });
    const signed = await files.signedUploadUrl("upload-key", {
      contentType: "text/plain",
      expiresIn: 3600,
    });
    expect(signed.method).toBe("POST");
    expect(signed.url).toBe(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/raw/upload`
    );
    if (signed.method !== "POST") {
      throw new Error("expected POST shape");
    }
    expect(signed.fields.api_key).toBe(API_KEY);
    expect(signed.fields.signature).toBe("signature-abc");
    expect(signed.fields.public_id).toBe("upload-key");
    expect(signed.fields.content_type).toBe("text/plain");
    expect(apiSignRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content_type: "text/plain",
        public_id: "upload-key",
      }),
      API_SECRET
    );
  });

  test("signedUploadUrl > throws when apiSecret is missing", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(
      files.signedUploadUrl("k", { expiresIn: 3600 })
    ).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("apiSecret"),
    });
  });

  test("error mapping > http_code 404 maps to NotFound", async () => {
    resourceMock.mockRejectedValueOnce({
      error: { http_code: 404, message: "Not found" },
    });
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.head("missing")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("error mapping > http_code 401 maps to Unauthorized", async () => {
    resourceMock.mockRejectedValueOnce({
      http_code: 401,
      message: "Unauthorized",
    });
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.head("k")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("error mapping > unknown error falls back to Provider", async () => {
    resourceMock.mockRejectedValueOnce(new Error("boom"));
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.head("k")).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("mapCloudinaryError > passes through existing FilesError", () => {
    const original = new FilesError("NotFound", "already mapped");
    expect(mapCloudinaryError(original)).toBe(original);
  });

  test("construction > malformed CLOUDINARY_URL falls through to plain envs", () => {
    process.env.CLOUDINARY_URL = "not-a-cloudinary-url";
    process.env.CLOUDINARY_CLOUD_NAME = CLOUD_NAME;
    const files = new Files({ adapter: cloudinary({}) });
    expect(files.adapter.name).toBe("cloudinary");
  });

  test("construction > skips config() when `client` is passed", () => {
    const files = new Files({
      adapter: cloudinary({
        client: {} as never,
        cloudName: CLOUD_NAME,
      }),
    });
    expect(files.adapter.name).toBe("cloudinary");
    expect(configMock).not.toHaveBeenCalled();
  });

  test("upload > resourceType=image returns image/<format> contentType", async () => {
    uploadStreamMock.mockImplementationOnce(
      (
        _opts: unknown,
        callback: (err: Error | null, result?: unknown) => void
      ) => {
        const stream = new Writable({
          final(cb) {
            callback(null, {
              bytes: 100,
              created_at: "2024-01-01T00:00:00Z",
              etag: "img-etag",
              format: "png",
              public_id: "logo",
              resource_type: "image",
              type: "upload",
            });
            cb();
          },
          write(_chunk: Buffer, _enc, cb) {
            cb();
          },
        });
        return stream;
      }
    );
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME, resourceType: "image" }),
    });
    const result = await files.upload("logo", new Uint8Array([1, 2, 3]));
    expect(result.contentType).toBe("image/png");
  });

  test("upload > resourceType=video returns video/<format> contentType", async () => {
    uploadStreamMock.mockImplementationOnce(
      (
        _opts: unknown,
        callback: (err: Error | null, result?: unknown) => void
      ) => {
        const stream = new Writable({
          final(cb) {
            callback(null, {
              bytes: 1024,
              created_at: "2024-01-01T00:00:00Z",
              etag: "vid-etag",
              format: "mp4",
              public_id: "clip",
              resource_type: "video",
              type: "upload",
            });
            cb();
          },
          write(_chunk: Buffer, _enc, cb) {
            cb();
          },
        });
        return stream;
      }
    );
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME, resourceType: "video" }),
    });
    const result = await files.upload("clip", new Uint8Array([1, 2, 3]));
    expect(result.contentType).toBe("video/mp4");
  });

  test("upload > caller-supplied contentType overrides inferred", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    const result = await files.upload("k", "hello", {
      contentType: "application/json",
    });
    expect(result.contentType).toBe("application/json");
  });

  test("upload > accepts ReadableStream body", async () => {
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    const result = await files.upload("k", stream);
    expect(result.key).toBe("test-file");
  });

  test("upload > surfaces upload_stream callback error as Provider", async () => {
    uploadStreamMock.mockImplementationOnce(
      (
        _opts: unknown,
        callback: (err: Error | null, result?: unknown) => void
      ) => {
        const stream = new Writable({
          final(cb) {
            const err = new Error("upstream rejected") as Error & {
              http_code?: number;
            };
            err.http_code = 401;
            callback(err);
            cb();
          },
          write(_chunk: Buffer, _enc, cb) {
            cb();
          },
        });
        return stream;
      }
    );
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.upload("k", "data")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("upload > upload_stream returning no result throws Provider", async () => {
    uploadStreamMock.mockImplementationOnce(
      (
        _opts: unknown,
        callback: (err: Error | null, result?: unknown) => void
      ) => {
        const stream = new Writable({
          final(cb) {
            callback(null);
            cb();
          },
          write(_chunk: Buffer, _enc, cb) {
            cb();
          },
        });
        return stream;
      }
    );
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.upload("k", "data")).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("no result"),
    });
  });

  test("copy > surfaces uploader.upload errors", async () => {
    uploadMock.mockRejectedValueOnce({
      error: { http_code: 404, message: "source missing" },
    });
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.copy("missing", "dest")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("delete > surfaces uploader.destroy errors", async () => {
    destroyMock.mockRejectedValueOnce({
      http_code: 403,
      message: "forbidden",
    });
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.delete("k")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("list > surfaces api.resources errors", async () => {
    resourcesMock.mockRejectedValueOnce({
      error: { http_code: 401, message: "no auth" },
    });
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.list()).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("download > surfaces api.resource errors", async () => {
    resourceMock.mockRejectedValueOnce({
      error: { http_code: 401, message: "no auth" },
    });
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.download("k")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("download > raw 500 from CDN surfaces as Provider", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("server error", { status: 500 }))
    ) as unknown as typeof globalThis.fetch;
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    await expect(files.download("k")).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("500"),
    });
  });

  test("url > type=private without format on resource throws Provider", async () => {
    resourceMock.mockResolvedValueOnce({
      bytes: 0,
      created_at: "2024-01-01T00:00:00Z",
      // no format field
      public_id: "raw-no-ext",
      resource_type: "raw",
      type: "private",
    } as never);
    const files = new Files({
      adapter: cloudinary({
        cloudName: CLOUD_NAME,
        type: "private",
      }),
    });
    await expect(files.url("raw-no-ext")).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("no format"),
    });
  });

  test("url > type=authenticated uses signedUrlExpiresIn default when no per-call expiry", async () => {
    const files = new Files({
      adapter: cloudinary({
        cloudName: CLOUD_NAME,
        signedUrlExpiresIn: 120,
        type: "authenticated",
      }),
    });
    await files.url("test-file");
    expect(privateDownloadUrlMock).toHaveBeenCalledWith(
      "test-file",
      "txt",
      expect.objectContaining({
        resource_type: "raw",
        type: "authenticated",
      })
    );
    const call = privateDownloadUrlMock.mock.calls.at(-1);
    if (!call) {
      throw new Error("expected private_download_url to have been called");
    }
    const expiresAt = (call[2] as { expires_at: number }).expires_at;
    const expected = Math.floor(Date.now() / 1000) + 120;
    expect(Math.abs(expiresAt - expected)).toBeLessThan(5);
  });

  test("download forwards the signal to the delivery fetch", async () => {
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return Promise.resolve(
        new Response("hello", {
          headers: { "content-type": "text/plain" },
          status: 200,
        })
      );
    }) as typeof fetch;
    const files = new Files({
      adapter: cloudinary({ cloudName: CLOUD_NAME }),
    });
    const { signal } = new AbortController();
    await files.download("test-file", { signal });
    expect(seenSignal).toBe(signal);
  });
});
