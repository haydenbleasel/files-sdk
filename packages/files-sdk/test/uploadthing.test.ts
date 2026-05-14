import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Files, FilesError } from "../src/index.js";

// `appId: "myapp"`, `apiKey: "sk_test"`, `regions: ["sea1"]`
const TEST_TOKEN = btoa(
  JSON.stringify({ apiKey: "sk_test", appId: "myapp", regions: ["sea1"] })
);

type UploadResult =
  | {
      data: {
        appUrl: string;
        customId: string | null;
        fileHash: string;
        key: string;
        lastModified: number;
        name: string;
        size: number;
        type: string;
        ufsUrl: string;
        url: string;
      };
      error: null;
    }
  | { data: null; error: { code: string; message: string } };

// UTApi method mocks. Closures captured below the mock.module call.
const uploadFilesMock = mock(
  (
    file: {
      name: string;
      customId?: string | null;
      size: number;
      type: string;
    },
    _opts?: unknown
  ): Promise<UploadResult> =>
    Promise.resolve({
      data: {
        appUrl: `https://myapp.ufs.sh/f/${file.customId ?? file.name}`,
        customId: file.customId ?? null,
        fileHash: "hash-123",
        key: "ut-generated-key",
        lastModified: 1_700_000_000_000,
        name: file.name,
        size: file.size,
        type: file.type,
        ufsUrl: `https://myapp.ufs.sh/f/${file.customId ?? file.name}`,
        url: `https://uploadthing.com/f/ut-generated-key`,
      },
      error: null,
    })
);

const deleteFilesMock = mock((_keys: string | string[], _opts?: unknown) =>
  Promise.resolve({ deletedCount: 1, success: true })
);

const listFilesMock = mock(
  (_opts?: {
    limit?: number;
    offset?: number;
  }): Promise<{
    files: readonly {
      customId: string | null;
      id: string;
      key: string;
      name: string;
      size: number;
      status: string;
      uploadedAt: number;
    }[];
    hasMore: boolean;
  }> =>
    Promise.resolve({
      files: [
        {
          customId: "a/1.txt",
          id: "id-1",
          key: "ut-key-1",
          name: "1.txt",
          size: 5,
          status: "Uploaded",
          uploadedAt: 1_700_000_000_000,
        },
        {
          customId: null,
          id: "id-2",
          key: "ut-key-2",
          name: "loose.bin",
          size: 9,
          status: "Uploaded",
          uploadedAt: 1_700_000_001_000,
        },
      ],
      hasMore: false,
    })
);

const generateSignedURLMock = mock(
  (key: string, opts?: { expiresIn?: number }) =>
    Promise.resolve({
      ufsUrl: `https://signed.ufs.sh/f/${key}?expires=${opts?.expiresIn ?? 0}`,
    })
);

// Constructible stand-in for the real UTApi — the adapter does
// `new UTApi(...)`, so we expose a constructor that returns the captured
// mock methods. (Plain object factory wouldn't satisfy the `new` call.)
const FakeUTApi = function FakeUTApi() {
  return {
    deleteFiles: deleteFilesMock,
    generateSignedURL: generateSignedURLMock,
    listFiles: listFilesMock,
    uploadFiles: uploadFilesMock,
  };
} as unknown as new () => unknown;

class FakeUTFile extends Blob {
  name: string;
  customId?: string | null;
  lastModified: number;
  constructor(
    parts: BlobPart[],
    name: string,
    options?: { type?: string; customId?: string | null; lastModified?: number }
  ) {
    super(parts, options?.type ? { type: options.type } : undefined);
    this.name = name;
    this.customId = options?.customId ?? undefined;
    this.lastModified = options?.lastModified ?? Date.now();
  }
}

mock.module("uploadthing/server", () => ({
  UTApi: FakeUTApi,
  UTFile: FakeUTFile,
}));

const { uploadthing } = await import("../src/uploadthing/index.js");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.UPLOADTHING_TOKEN = TEST_TOKEN;
  uploadFilesMock.mockClear();
  deleteFilesMock.mockClear();
  listFilesMock.mockClear();
  generateSignedURLMock.mockClear();
  // Default fetch mock: 200 with body "hello", surfaces typical headers.
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/missing")) {
      return Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" })
      );
    }
    if (init?.method === "HEAD") {
      return Promise.resolve(
        new Response(null, {
          headers: {
            "content-length": "5",
            "content-type": "text/plain",
            etag: '"abc123"',
            "last-modified": "Wed, 21 Oct 2020 07:28:00 GMT",
          },
          status: 200,
        })
      );
    }
    return Promise.resolve(
      new Response("hello", {
        headers: {
          "content-length": "5",
          "content-type": "text/plain",
          etag: '"abc123"',
        },
        status: 200,
      })
    );
  }) as typeof fetch;
});

afterEach(() => {
  delete process.env.UPLOADTHING_TOKEN;
  globalThis.fetch = originalFetch;
});

describe("uploadthing adapter", () => {
  test("missing token throws at construction", () => {
    delete process.env.UPLOADTHING_TOKEN;
    expect(() => uploadthing()).toThrow(/token/iu);
    process.env.UPLOADTHING_TOKEN = TEST_TOKEN;
  });

  test("malformed (non-base64) token throws at construction", () => {
    process.env.UPLOADTHING_TOKEN = "!!!not-base64!!!";
    expect(() => uploadthing()).toThrow(/UPLOADTHING_TOKEN/u);
    process.env.UPLOADTHING_TOKEN = TEST_TOKEN;
  });

  test("token decoding to non-JSON throws at construction", () => {
    process.env.UPLOADTHING_TOKEN = btoa("not json");
    expect(() => uploadthing()).toThrow(/JSON/u);
    process.env.UPLOADTHING_TOKEN = TEST_TOKEN;
  });

  test("token missing apiKey/appId throws at construction", () => {
    process.env.UPLOADTHING_TOKEN = btoa(JSON.stringify({ apiKey: "x" }));
    expect(() => uploadthing()).toThrow(/apiKey or appId/u);
    process.env.UPLOADTHING_TOKEN = TEST_TOKEN;
  });

  test("upload calls utapi.uploadFiles with key as customId and configured ACL", async () => {
    const files = new Files({ adapter: uploadthing() });
    const result = await files.upload("avatars/abc.png", "hello", {
      contentType: "text/plain",
    });
    expect(result.key).toBe("avatars/abc.png");
    expect(result.size).toBe(5);
    // Bun's Blob normalizes string-part types to include `;charset=utf-8`.
    // The adapter passes the Blob's effective type through verbatim.
    expect(result.contentType).toMatch(/^text\/plain/u);
    expect(result.etag).toBe("hash-123");
    expect(uploadFilesMock).toHaveBeenCalledTimes(1);
    const [firstCall] = uploadFilesMock.mock.calls;
    if (!firstCall) {
      throw new Error("expected uploadFiles to have been called");
    }
    const [file, opts] = firstCall;
    expect(file.name).toBe("abc.png");
    expect(file.customId).toBe("avatars/abc.png");
    expect((opts as { acl: string }).acl).toBe("public-read");
  });

  test("upload uses custom acl when configured", async () => {
    const files = new Files({ adapter: uploadthing({ acl: "private" }) });
    await files.upload("a.txt", "hi");
    const [firstCall] = uploadFilesMock.mock.calls;
    expect((firstCall?.[1] as { acl: string })?.acl).toBe("private");
  });

  test("upload surfaces UploadThing's per-file error", async () => {
    uploadFilesMock.mockImplementationOnce(() =>
      Promise.resolve({
        data: null,
        error: { code: "UPLOAD_FAILED", message: "boom" },
      })
    );
    const files = new Files({ adapter: uploadthing() });
    try {
      await files.upload("a.txt", "hi");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).message).toMatch(/boom/u);
    }
  });

  test("download fetches the public CDN URL by default", async () => {
    let observedUrl = "";
    globalThis.fetch = ((url: string | URL | Request) => {
      observedUrl = typeof url === "string" ? url : url.toString();
      return Promise.resolve(new Response("hello", { status: 200 }));
    }) as typeof fetch;
    const files = new Files({ adapter: uploadthing() });
    const got = await files.download("a.txt");
    expect(observedUrl).toBe("https://myapp.ufs.sh/f/a.txt");
    expect(await got.text()).toBe("hello");
    expect(generateSignedURLMock).not.toHaveBeenCalled();
  });

  test("download for private adapter routes through generateSignedURL", async () => {
    const files = new Files({ adapter: uploadthing({ acl: "private" }) });
    const got = await files.download("a.txt");
    expect(await got.text()).toBe("hello");
    expect(generateSignedURLMock).toHaveBeenCalledTimes(1);
    expect(generateSignedURLMock.mock.calls[0]?.[0]).toBe("a.txt");
    expect(generateSignedURLMock.mock.calls[0]?.[1]?.expiresIn).toBe(3600);
  });

  test("download as: stream returns a streaming StoredFile", async () => {
    const files = new Files({ adapter: uploadthing() });
    const got = await files.download("a.txt", { as: "stream" });
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

  test("download maps 404 to NotFound", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" })
      )) as unknown as typeof fetch;
    const files = new Files({ adapter: uploadthing() });
    try {
      await files.download("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("head issues a HEAD request and returns metadata", async () => {
    let observedMethod = "";
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      observedMethod = init?.method ?? "GET";
      return Promise.resolve(
        new Response(null, {
          headers: {
            "content-length": "42",
            "content-type": "image/png",
            etag: '"xyz"',
          },
          status: 200,
        })
      );
    }) as typeof fetch;
    const files = new Files({ adapter: uploadthing() });
    const info = await files.head("a.png");
    expect(observedMethod).toBe("HEAD");
    expect(info.size).toBe(42);
    expect(info.type).toBe("image/png");
    expect(info.etag).toBe('"xyz"');
    expect(info.key).toBe("a.png");
  });

  test("exists returns true for present keys and false for missing keys", async () => {
    const files = new Files({ adapter: uploadthing() });
    await expect(files.exists("a.txt")).resolves.toBe(true);

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" })
      )) as unknown as typeof fetch;
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("delete delegates to utapi.deleteFiles with the key", async () => {
    const files = new Files({ adapter: uploadthing() });
    await files.delete("a.txt");
    expect(deleteFilesMock).toHaveBeenCalledTimes(1);
    expect(deleteFilesMock.mock.calls[0]?.[0]).toBe("a.txt");
  });

  test("copy streams source through a re-upload", async () => {
    const files = new Files({ adapter: uploadthing() });
    await files.copy("a.txt", "b.txt");
    // Upload should have been called once (for the destination).
    expect(uploadFilesMock).toHaveBeenCalledTimes(1);
    const [call] = uploadFilesMock.mock.calls;
    expect(call?.[0]?.customId).toBe("b.txt");
  });

  test("list maps files to StoredFile items, preferring customId as key", async () => {
    const files = new Files({ adapter: uploadthing() });
    const out = await files.list({ limit: 10 });
    expect(out.items.map((i) => i.key)).toEqual(["a/1.txt", "ut-key-2"]);
    expect(out.cursor).toBeUndefined();
    expect(listFilesMock.mock.calls[0]?.[0]).toEqual({ limit: 10, offset: 0 });
  });

  test("list cursor round-trips as string offset when hasMore", async () => {
    listFilesMock.mockImplementationOnce(() =>
      Promise.resolve({
        files: [
          {
            customId: "x",
            id: "id-x",
            key: "ut-x",
            name: "x",
            size: 1,
            status: "Uploaded",
            uploadedAt: 0,
          },
        ],
        hasMore: true,
      })
    );
    const files = new Files({ adapter: uploadthing() });
    const out = await files.list({ cursor: "5" });
    expect(out.cursor).toBe("6");
    expect(listFilesMock.mock.calls[0]?.[0]).toEqual({ offset: 5 });
  });

  test("list applies prefix client-side over the returned page", async () => {
    const files = new Files({ adapter: uploadthing() });
    const out = await files.list({ prefix: "a/" });
    expect(out.items.map((i) => i.key)).toEqual(["a/1.txt"]);
  });

  test("url returns the public CDN URL for public-read adapter", async () => {
    const files = new Files({ adapter: uploadthing() });
    const url = await files.url("avatars/me.png");
    expect(url).toBe("https://myapp.ufs.sh/f/avatars%2Fme.png");
    expect(generateSignedURLMock).not.toHaveBeenCalled();
  });

  test("url throws on responseContentDisposition (no override)", async () => {
    const files = new Files({ adapter: uploadthing() });
    try {
      await files.url("a.txt", { responseContentDisposition: "attachment" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toMatch(
        /responseContentDisposition/u
      );
    }
  });

  test("url for private adapter mints a signed URL", async () => {
    const files = new Files({
      adapter: uploadthing({ acl: "private", defaultUrlExpiresIn: 60 }),
    });
    const url = await files.url("a.txt");
    expect(url).toBe("https://signed.ufs.sh/f/a.txt?expires=60");
    expect(generateSignedURLMock).toHaveBeenCalledTimes(1);
  });

  test("url honors per-call expiresIn override", async () => {
    const files = new Files({ adapter: uploadthing({ acl: "private" }) });
    await files.url("a.txt", { expiresIn: 120 });
    expect(generateSignedURLMock.mock.calls[0]?.[1]?.expiresIn).toBe(120);
  });

  test("signedUploadUrl returns a PUT URL with documented query params and a recomputable signature", async () => {
    const files = new Files({
      adapter: uploadthing({ slug: "mediaUploader" }),
    });
    const out = await files.signedUploadUrl("uploads/x.png", {
      contentType: "image/png",
      expiresIn: 60,
      maxSize: 10_000_000,
    });
    expect(out.method).toBe("PUT");
    if (out.method !== "PUT") {
      throw new Error("expected PUT");
    }
    const u = new URL(out.url);
    expect(u.host).toBe("sea1.ingest.uploadthing.com");
    expect(u.searchParams.get("x-ut-identifier")).toBe("myapp");
    expect(u.searchParams.get("x-ut-file-name")).toBe("x.png");
    expect(u.searchParams.get("x-ut-file-size")).toBe("10000000");
    expect(u.searchParams.get("x-ut-slug")).toBe("mediaUploader");
    expect(u.searchParams.get("x-ut-file-type")).toBe("image/png");
    expect(u.searchParams.get("x-ut-custom-id")).toBe("uploads/x.png");
    expect(u.searchParams.get("x-ut-acl")).toBe("public-read");
    const signature = u.searchParams.get("signature");
    expect(signature).toMatch(/^hmac-sha256=[0-9a-f]{64}$/u);

    // Verify the signature is HMAC-SHA256(url-without-signature, apiKey).
    u.searchParams.delete("signature");
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode("sk_test"),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(u.toString()));
    const expected = `hmac-sha256=${[...new Uint8Array(sig)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;
    expect(signature).toBe(expected);
  });

  test("signedUploadUrl region override is honored", async () => {
    const files = new Files({
      adapter: uploadthing({ region: "fra1" }),
    });
    const out = await files.signedUploadUrl("a.txt", { expiresIn: 60 });
    if (out.method !== "PUT") {
      throw new Error("expected PUT");
    }
    expect(new URL(out.url).host).toBe("fra1.ingest.uploadthing.com");
  });

  test("upload accepts every Body shape (string, Uint8Array, ArrayBuffer, view, Blob, stream)", async () => {
    const files = new Files({ adapter: uploadthing() });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    // ArrayBufferView with non-zero offset — the adapter must slice the
    // underlying buffer to the view's window, not include unrelated bytes.
    const wrapped = new Uint8Array(new ArrayBuffer(10), 2, 3);
    wrapped.set([7, 8, 9]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello"));
        c.close();
      },
    });
    const inputs: { name: string; body: Parameters<typeof files.upload>[1] }[] =
      [
        { body: "hello", name: "string" },
        { body: bytes, name: "Uint8Array" },
        { body: bytes.buffer, name: "ArrayBuffer" },
        { body: wrapped, name: "ArrayBufferView" },
        { body: new Blob(["hello"], { type: "text/plain" }), name: "Blob" },
        { body: stream, name: "ReadableStream" },
      ];
    for (const { body } of inputs) {
      uploadFilesMock.mockClear();
      const out = await files.upload("a.bin", body);
      expect(out.size).toBeGreaterThan(0);
      expect(uploadFilesMock).toHaveBeenCalledTimes(1);
    }
  });

  test("upload accepts a non-Uint8Array ArrayBufferView (DataView) and slices to its window", async () => {
    // Uint8Array short-circuits the `instanceof Uint8Array` branch, so to
    // exercise the generic ArrayBufferView path we hand in a DataView with
    // a non-zero offset. The adapter must slice the underlying buffer to
    // the view's window — uploading the full buffer would smuggle 7 extra
    // bytes (4 leading + 3 trailing) into the destination.
    const buf = new ArrayBuffer(10);
    new Uint8Array(buf).set([0, 0, 0, 0, 1, 2, 3, 0, 0, 0]);
    const view = new DataView(buf, 4, 3);
    const files = new Files({ adapter: uploadthing() });
    const out = await files.upload("a.bin", view);
    expect(out.size).toBe(3);
  });

  test("upload re-wraps a Blob when its type does not match contentType", async () => {
    const files = new Files({ adapter: uploadthing() });
    const blob = new Blob(["xyz"], { type: "application/octet-stream" });
    await files.upload("a.txt", blob, { contentType: "text/plain" });
    const file = uploadFilesMock.mock.calls[0]?.[0];
    // Bun's Blob normalizes string-part types; the adapter passes the type
    // through verbatim, so just assert the prefix.
    expect(file?.type).toMatch(/^text\/plain/u);
  });

  test("upload surfaces utapi.uploadFiles thrown error (not result.error path)", async () => {
    uploadFilesMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("network down"), {
          code: "UNAUTHORIZED",
          status: 401,
        })
      )
    );
    const files = new Files({ adapter: uploadthing() });
    try {
      await files.upload("a.txt", "hi");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Unauthorized");
    }
  });

  test("delete maps a thrown error through classifyUploadThingError (409 → Conflict)", async () => {
    deleteFilesMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("conflict"), { code: "CONFLICT", status: 409 })
      )
    );
    const files = new Files({ adapter: uploadthing() });
    try {
      await files.delete("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Conflict");
    }
  });

  test("delete maps a generic 'not found' message to NotFound", async () => {
    deleteFilesMock.mockImplementationOnce(() =>
      Promise.reject(new Error("file not found"))
    );
    const files = new Files({ adapter: uploadthing() });
    try {
      await files.delete("missing.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("download wraps a thrown fetch error", async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error("connection reset"))) as unknown as typeof fetch;
    const files = new Files({ adapter: uploadthing() });
    try {
      await files.download("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).message).toMatch(/connection reset/u);
    }
  });

  test("head wraps a non-OK HEAD response (500 → Provider)", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 500, statusText: "Internal" })
      )) as unknown as typeof fetch;
    const files = new Files({ adapter: uploadthing() });
    try {
      await files.head("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
    }
  });

  test("head surfaces 404 from HEAD as NotFound", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" })
      )) as unknown as typeof fetch;
    const files = new Files({ adapter: uploadthing() });
    try {
      await files.head("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("head's lazy body factory fetches on first body access", async () => {
    const calls: { method: string }[] = [];
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET" });
      return Promise.resolve(
        new Response("payload", {
          headers: {
            "content-length": "7",
            "content-type": "text/plain",
          },
          status: 200,
        })
      );
    }) as unknown as typeof fetch;
    const files = new Files({ adapter: uploadthing() });
    const meta = await files.head("a.txt");
    expect(calls).toEqual([{ method: "HEAD" }]);
    const body = await meta.text();
    expect(body).toBe("payload");
    expect(calls).toEqual([{ method: "HEAD" }, { method: "GET" }]);
  });

  test("head's lazy body factory throws NotFound when the follow-up GET 404s", async () => {
    let firstCall = true;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      if (init?.method === "HEAD" && firstCall) {
        firstCall = false;
        return Promise.resolve(
          new Response(null, {
            headers: { "content-length": "5", "content-type": "text/plain" },
            status: 200,
          })
        );
      }
      return Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" })
      );
    }) as unknown as typeof fetch;
    const files = new Files({ adapter: uploadthing() });
    const meta = await files.head("a.txt");
    try {
      await meta.text();
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("list wraps a thrown utapi.listFiles error", async () => {
    listFilesMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("forbidden"), {
          code: "FORBIDDEN",
          status: 403,
        })
      )
    );
    const files = new Files({ adapter: uploadthing() });
    try {
      await files.list();
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Unauthorized");
    }
  });

  test("list items expose lazy bodies that fetch on first access", async () => {
    const fetched: string[] = [];
    globalThis.fetch = ((url: unknown) => {
      fetched.push(typeof url === "string" ? url : (url as URL).toString());
      return Promise.resolve(new Response("contents", { status: 200 }));
    }) as unknown as typeof fetch;
    const files = new Files({ adapter: uploadthing() });
    const out = await files.list();
    expect(fetched).toEqual([]);
    const text = await out.items[0]?.text();
    expect(text).toBe("contents");
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toBe("https://myapp.ufs.sh/f/a%2F1.txt");
  });

  test("downloadTimeoutMs: 0 disables AbortSignal.timeout on fetches", async () => {
    let observedSignal: AbortSignal | null | undefined;
    globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
      observedSignal = init?.signal;
      return Promise.resolve(new Response("hi", { status: 200 }));
    }) as unknown as typeof fetch;
    const files = new Files({
      adapter: uploadthing({ downloadTimeoutMs: 0 }),
    });
    await files.download("a.txt");
    expect(observedSignal).toBeUndefined();
  });

  test("mapUploadThingError preserves an already-wrapped FilesError without re-wrapping", async () => {
    const inner = new FilesError("NotFound", "from inside");
    deleteFilesMock.mockImplementationOnce(() => Promise.reject(inner));
    const files = new Files({ adapter: uploadthing() });
    try {
      await files.delete("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBe(inner);
    }
  });
});
