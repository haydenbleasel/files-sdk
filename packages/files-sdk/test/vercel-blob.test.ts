import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Files, FilesError } from "../src/index.js";

// Mock @vercel/blob before the adapter imports it.
const putMock = mock((pathname: string, _body: unknown, _opts?: unknown) =>
  Promise.resolve({
    contentDisposition: "",
    contentType: "text/plain",
    downloadUrl: `https://blob.test/${pathname}?download=1`,
    etag: `"etag-${pathname}"`,
    pathname,
    url: `https://blob.test/${pathname}`,
  })
);
const headMock = mock((pathname: string, _opts?: unknown) =>
  Promise.resolve({
    cacheControl: "",
    contentDisposition: "",
    contentType: "text/plain",
    downloadUrl: `https://blob.test/${pathname}?download=1`,
    etag: `"etag-${pathname}"`,
    pathname,
    size: 5,
    uploadedAt: new Date(),
    url: `https://blob.test/${pathname}`,
  })
);
const delMock = mock((_pathname: string | string[], _opts?: unknown) =>
  Promise.resolve()
);
const copyMock = mock((_from: string, to: string, _opts?: unknown) =>
  Promise.resolve({
    contentDisposition: "",
    contentType: "text/plain",
    downloadUrl: `https://blob.test/${to}?download=1`,
    pathname: to,
    url: `https://blob.test/${to}`,
  })
);
const listMock = mock((_opts?: unknown) =>
  Promise.resolve({
    blobs: [
      {
        downloadUrl: "https://blob.test/a/1.txt?download=1",
        etag: '"etag-a/1.txt"',
        pathname: "a/1.txt",
        size: 1,
        uploadedAt: new Date(),
        url: "https://blob.test/a/1.txt",
      },
    ],
    cursor: undefined,
    hasMore: false,
  })
);
type GetMockResult = {
  blob: {
    cacheControl: string;
    contentDisposition: string;
    contentType: string;
    downloadUrl: string;
    etag: string;
    pathname: string;
    size: number;
    uploadedAt: Date;
    url: string;
  };
  headers: Headers;
  statusCode: number;
  stream: ReadableStream<Uint8Array>;
} | null;
const getMock = mock(
  (pathname: string, _opts?: unknown): Promise<GetMockResult> =>
    Promise.resolve({
      blob: {
        cacheControl: "",
        contentDisposition: "",
        contentType: "text/plain",
        downloadUrl: `https://blob.test/${pathname}?download=1`,
        etag: `"etag-${pathname}"`,
        pathname,
        size: 5,
        uploadedAt: new Date(),
        url: `https://blob.test/${pathname}`,
      },
      headers: new Headers(),
      statusCode: 200,
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("hello"));
          c.close();
        },
      }),
    })
);

mock.module("@vercel/blob", () => ({
  copy: copyMock,
  del: delMock,
  get: getMock,
  head: headMock,
  list: listMock,
  put: putMock,
}));

const { vercelBlob } = await import("../src/vercel-blob/index.js");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  // Make sure OIDC env vars never leak in from the host shell — several
  // tests below assert the RW-token code path runs, which is only true
  // when neither OIDC env var is set.
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.BLOB_STORE_ID;
  putMock.mockClear();
  headMock.mockClear();
  delMock.mockClear();
  copyMock.mockClear();
  listMock.mockClear();
  getMock.mockClear();
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.includes("/missing")) {
      return Promise.resolve(
        new Response(null, { status: 404, statusText: "Not Found" })
      );
    }
    return Promise.resolve(
      new Response("hello", {
        headers: { "Content-Type": "text/plain" },
        status: 200,
      })
    );
  }) as typeof fetch;
});

afterEach(() => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.BLOB_STORE_ID;
  globalThis.fetch = originalFetch;
});

describe("vercel-blob adapter", () => {
  test("missing credentials throws at construction", () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(() => vercelBlob()).toThrow(/credentials/iu);
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  });

  test("only one OIDC env var (no token) still throws — partial config", () => {
    // OIDC needs both `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID`. With only one
    // set and no RW token, the adapter must surface this at construction
    // instead of falling through to anonymous calls that 401 at runtime.
    delete process.env.BLOB_READ_WRITE_TOKEN;
    process.env.VERCEL_OIDC_TOKEN = "oidc-token";
    expect(() => vercelBlob()).toThrow(/credentials/iu);
    delete process.env.VERCEL_OIDC_TOKEN;
    process.env.BLOB_STORE_ID = "abc123store";
    expect(() => vercelBlob()).toThrow(/credentials/iu);
    delete process.env.BLOB_STORE_ID;
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  });

  test("upload calls blob.put with the right options", async () => {
    const files = new Files({ adapter: vercelBlob() });
    const result = await files.upload("a.txt", "hello", {
      cacheControl: "public, max-age=60",
      contentType: "text/plain",
    });
    expect(result.key).toBe("a.txt");
    expect(putMock).toHaveBeenCalledTimes(1);
    const [firstPutCall] = putMock.mock.calls;
    if (!firstPutCall) {
      throw new Error("expected put to have been called");
    }
    const [path, , opts] = firstPutCall;
    expect(path).toBe("a.txt");
    const o = opts as {
      access: string;
      addRandomSuffix: boolean;
      cacheControlMaxAge?: number;
      contentType?: string;
    };
    expect(o.access).toBe("public");
    expect(o.addRandomSuffix).toBe(false);
    expect(o.cacheControlMaxAge).toBe(60);
    expect(o.contentType).toBe("text/plain");
  });

  test("forwards blob.put progress to onProgress", async () => {
    putMock.mockImplementationOnce(
      (pathname: string, _body: unknown, opts: unknown) => {
        const { onUploadProgress } = opts as {
          onUploadProgress?: (e: {
            loaded: number;
            total: number;
            percentage: number;
          }) => void;
        };
        onUploadProgress?.({ loaded: 2, percentage: 40, total: 5 });
        onUploadProgress?.({ loaded: 5, percentage: 100, total: 5 });
        return Promise.resolve({
          contentDisposition: "",
          contentType: "text/plain",
          downloadUrl: `https://blob.test/${pathname}?download=1`,
          etag: `"etag-${pathname}"`,
          pathname,
          url: `https://blob.test/${pathname}`,
        });
      }
    );
    const files = new Files({ adapter: vercelBlob() });
    const events: { loaded: number; total?: number }[] = [];
    await files.upload("a.txt", "hello", {
      onProgress: (p) => events.push(p),
    });
    expect(events).toEqual([
      { loaded: 2, total: 5 },
      { loaded: 5, total: 5 },
    ]);
  });

  test("upload forwards signals to blob.put", async () => {
    const { signal } = new AbortController();
    const files = new Files({ adapter: vercelBlob() });

    await files.upload("a.txt", "hello", { signal });

    const [call] = putMock.mock.calls;
    expect(call).toBeDefined();
    const opts = call?.[2] as { abortSignal?: AbortSignal } | undefined;
    expect(opts?.abortSignal).toBe(signal);
  });

  test("head returns metadata without polluting it with adapter URLs", async () => {
    const files = new Files({ adapter: vercelBlob() });
    const info = await files.head("a.txt");
    expect(info.key).toBe("a.txt");
    expect(info.size).toBe(5);
    expect(info.etag).toBe('"etag-a.txt"');
    expect(info.metadata).toBeUndefined();
  });

  test("head forwards signals to blob.head", async () => {
    const { signal } = new AbortController();
    const files = new Files({ adapter: vercelBlob() });

    await files.head("a.txt", { signal });

    const [call] = headMock.mock.calls;
    expect(call).toBeDefined();
    const opts = call?.[1] as { abortSignal?: AbortSignal } | undefined;
    expect(opts?.abortSignal).toBe(signal);
  });

  test("delete delegates to blob.del", async () => {
    const files = new Files({ adapter: vercelBlob() });
    await files.delete("a.txt");
    expect(delMock).toHaveBeenCalledTimes(1);
    const [firstDelCall] = delMock.mock.calls;
    if (!firstDelCall) {
      throw new Error("expected del to have been called");
    }
    const [delArg] = firstDelCall;
    expect(delArg).toBe("a.txt");
  });

  test("copy delegates to blob.copy", async () => {
    const files = new Files({ adapter: vercelBlob() });
    await files.copy("a.txt", "b.txt");
    expect(copyMock).toHaveBeenCalledTimes(1);
    const [firstCopyCall] = copyMock.mock.calls;
    if (!firstCopyCall) {
      throw new Error("expected copy to have been called");
    }
    const [fromArg, toArg] = firstCopyCall;
    expect(fromArg).toBe("a.txt");
    expect(toArg).toBe("b.txt");
  });

  test("list maps blobs into StoredFile items", async () => {
    const files = new Files({ adapter: vercelBlob() });
    const out = await files.list({ prefix: "a/" });
    expect(out.items.map((i) => i.key)).toEqual(["a/1.txt"]);
  });

  test("download forwards signals to fetch on public blobs", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      void url;
      seenSignal = init?.signal ?? undefined;
      return Promise.resolve(new Response("hello", { status: 200 }));
    }) as typeof fetch;
    const files = new Files({ adapter: vercelBlob() });

    await files.download("a.txt", { signal: controller.signal });

    expect(seenSignal).toBeDefined();
    expect(seenSignal).not.toBe(controller.signal);
    controller.abort(new Error("stop"));
    expect(seenSignal?.aborted).toBe(true);
  });

  test("download forwards a Range header and reports the slice on public blobs", async () => {
    let seenRange: string | null | undefined;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      void url;
      seenRange = new Headers(init?.headers).get("range");
      return Promise.resolve(
        new Response("234", {
          headers: { "content-length": "3" },
          status: 206,
        })
      );
    }) as typeof fetch;
    const files = new Files({ adapter: vercelBlob() });
    const got = await files.download("a.txt", { range: { end: 4, start: 2 } });
    expect(seenRange).toBe("bytes=2-4");
    expect(await got.text()).toBe("234");
    expect(got.size).toBe(3);
  });

  test("download (stream) with a range reports the slice length", async () => {
    globalThis.fetch = ((_url: string | URL | Request) =>
      Promise.resolve(
        new Response("789", { headers: { "content-length": "3" }, status: 206 })
      )) as typeof fetch;
    const files = new Files({ adapter: vercelBlob() });
    const got = await files.download("a.txt", {
      as: "stream",
      range: { start: 7 },
    });
    expect(got.size).toBe(3);
  });

  test("public adapter advertises range support; private does not", () => {
    expect(vercelBlob().supportsRange).toBe(true);
    expect(vercelBlob({ access: "private" }).supportsRange).toBeUndefined();
  });

  test("url returns the blob's public URL via head() when token has no storeId", async () => {
    const files = new Files({ adapter: vercelBlob() });
    headMock.mockClear();
    const url = await files.url("a.txt");
    expect(url).toBe("https://blob.test/a.txt");
    expect(headMock).toHaveBeenCalledTimes(1);
  });

  test("url derives URL from storeId without a round trip when addRandomSuffix is false", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_abc123store_random";
    const files = new Files({ adapter: vercelBlob() });
    headMock.mockClear();
    const url = await files.url("a.txt");
    expect(url).toBe(
      "https://abc123store.public.blob.vercel-storage.com/a.txt"
    );
    expect(headMock).not.toHaveBeenCalled();
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  });

  test("url encodes special characters in the key on the storeId fast path", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_abc123store_random";
    const files = new Files({ adapter: vercelBlob() });
    headMock.mockClear();
    const url = await files.url("my file?q#frag");
    expect(url).toBe(
      "https://abc123store.public.blob.vercel-storage.com/my%20file%3Fq%23frag"
    );
    expect(headMock).not.toHaveBeenCalled();
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  });

  test("url falls back to head() when token format is unfamiliar (e.g. version segment added)", async () => {
    // Hypothetical future token shape with a version prefix segment after
    // `vercel_blob_rw_`. Old code naively grabbed split('_')[3] and would
    // treat 'v2' as the storeId. We must fall back instead.
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_v2_abc123store_random";
    const files = new Files({ adapter: vercelBlob() });
    headMock.mockClear();
    const url = await files.url("a.txt");
    expect(url).toBe("https://blob.test/a.txt");
    expect(headMock).toHaveBeenCalledTimes(1);
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  });

  test("url falls back to head() when token doesn't have the vercel_blob_rw_ prefix", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "custom_token_shape_x";
    const files = new Files({ adapter: vercelBlob() });
    headMock.mockClear();
    const url = await files.url("a.txt");
    expect(url).toBe("https://blob.test/a.txt");
    expect(headMock).toHaveBeenCalledTimes(1);
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  });

  test("url falls back to head() when addRandomSuffix is true (pathname unknown)", async () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_abc123store_random";
    const files = new Files({
      adapter: vercelBlob({ addRandomSuffix: true }),
    });
    headMock.mockClear();
    const url = await files.url("a.txt");
    expect(url).toBe("https://blob.test/a.txt");
    expect(headMock).toHaveBeenCalledTimes(1);
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  });

  test("url with responseContentDisposition throws Provider (no Content-Disposition primitive)", async () => {
    const files = new Files({ adapter: vercelBlob() });
    try {
      await files.url("a.txt", { responseContentDisposition: "attachment" });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toMatch(
        /responseContentDisposition|signing primitive/u
      );
    }
  });

  test("signedUploadUrl throws Provider", async () => {
    const files = new Files({ adapter: vercelBlob() });
    try {
      await files.signedUploadUrl("a.txt", { expiresIn: 60 });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toMatch(/handleUpload/u);
    }
  });

  test("download fetches the blob URL and returns its body", async () => {
    const files = new Files({ adapter: vercelBlob() });
    const got = await files.download("a.txt");
    expect(await got.text()).toBe("hello");
    expect(got.size).toBe(5);
    expect(got.type).toBe("text/plain");
  });

  test("download as stream returns a streaming StoredFile", async () => {
    const files = new Files({ adapter: vercelBlob() });
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

  test("download maps non-OK responses to FilesError (404 → NotFound)", async () => {
    headMock.mockImplementationOnce((pathname: string) =>
      Promise.resolve({
        cacheControl: "",
        contentDisposition: "",
        contentType: "text/plain",
        downloadUrl: `https://blob.test/missing/${pathname}?download=1`,
        etag: "",
        pathname,
        size: 0,
        uploadedAt: new Date(),
        url: `https://blob.test/missing/${pathname}`,
      })
    );
    const files = new Files({ adapter: vercelBlob() });
    try {
      await files.download("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("upload computes size for Uint8Array, ArrayBuffer, ArrayBufferView, Blob, string", async () => {
    const adapter = vercelBlob();
    const u8 = await adapter.upload("u8.bin", new Uint8Array([1, 2, 3]));
    expect(u8.size).toBe(3);
    const ab = await adapter.upload(
      "ab.bin",
      new Uint8Array([1, 2, 3, 4]).buffer
    );
    expect(ab.size).toBe(4);
    const view = await adapter.upload(
      "v.bin",
      new DataView(new ArrayBuffer(8))
    );
    expect(view.size).toBe(8);
    const blobUpload = await adapter.upload(
      "b.bin",
      new Blob([new Uint8Array([1, 2])], { type: "image/png" })
    );
    expect(blobUpload.size).toBe(2);
    const str = await adapter.upload("s.txt", "hello");
    expect(str.size).toBe(5);
  });

  test("upload error is wrapped as FilesError", async () => {
    const files = new Files({ adapter: vercelBlob() });
    putMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("oops"), { status: 500 }))
    );
    try {
      await files.upload("a.txt", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toBe("oops");
    }
  });

  test("head error: name BlobNotFoundError maps to NotFound", async () => {
    const files = new Files({ adapter: vercelBlob() });
    headMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("nope"), { name: "BlobNotFoundError" })
      )
    );
    try {
      await files.head("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("exists returns true for present blobs and false for BlobNotFound errors", async () => {
    const files = new Files({ adapter: vercelBlob() });
    await expect(files.exists("a.txt")).resolves.toBe(true);

    headMock.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("missing"), { name: "BlobNotFoundError" })
      )
    );
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("exists rethrows non-NotFound errors from blob.head()", async () => {
    const files = new Files({ adapter: vercelBlob() });
    headMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("denied"), { status: 403 }))
    );
    await expect(files.exists("a.txt")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("upload error: status 409 maps to Conflict", async () => {
    const files = new Files({ adapter: vercelBlob() });
    putMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("conflict"), { status: 409 }))
    );
    try {
      await files.upload("a.txt", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Conflict");
    }
  });

  test("delete error: status 403 maps to Unauthorized", async () => {
    const files = new Files({ adapter: vercelBlob() });
    delMock.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("denied"), { status: 403 }))
    );
    try {
      await files.delete("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Unauthorized");
    }
  });

  test("copy error is mapped to FilesError", async () => {
    const files = new Files({ adapter: vercelBlob() });
    copyMock.mockImplementationOnce(() =>
      Promise.reject(new Error("copy failed"))
    );
    try {
      await files.copy("a.txt", "b.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toBe("copy failed");
    }
  });

  test("head exposes a lazy body that fetches the blob URL", async () => {
    const files = new Files({ adapter: vercelBlob() });
    const info = await files.head("a.txt");
    expect(await info.text()).toBe("hello");
  });

  test("list items expose lazy bodies that fetch the blob URL", async () => {
    const files = new Files({ adapter: vercelBlob() });
    const out = await files.list();
    const [item] = out.items;
    if (!item) {
      throw new Error("expected at least one item");
    }
    expect(await item.text()).toBe("hello");
  });

  test("url throws Provider when the head response has no public URL", async () => {
    headMock.mockImplementationOnce((pathname: string) =>
      Promise.resolve({
        cacheControl: "",
        contentDisposition: "",
        contentType: "text/plain",
        downloadUrl: "",
        etag: "",
        pathname,
        size: 0,
        uploadedAt: new Date(),
        url: "",
      })
    );
    const files = new Files({ adapter: vercelBlob() });
    try {
      await files.url("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toMatch(/missing public URL/u);
    }
  });

  test("upload of ReadableStream body fetches authoritative size via head()", async () => {
    const adapter = vercelBlob();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
    headMock.mockClear();
    const result = await adapter.upload("s.bin", stream);
    // The streaming-body path must consult head() for the size that we
    // can't compute locally — otherwise callers see a bogus size: 0.
    expect(headMock).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(5);
  });

  test("upload of known-size body skips the extra head() round trip", async () => {
    const adapter = vercelBlob();
    headMock.mockClear();
    const result = await adapter.upload("s.txt", "hello");
    expect(headMock).not.toHaveBeenCalled();
    expect(result.size).toBe(5);
    expect(result.etag).toBe('"etag-s.txt"');
  });

  test("list error is mapped to FilesError", async () => {
    const files = new Files({ adapter: vercelBlob() });
    listMock.mockImplementationOnce(() =>
      Promise.reject(new Error("list failed"))
    );
    try {
      await files.list();
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toBe("list failed");
    }
  });

  test("download passes an AbortSignal so a hung CDN can't pin the call forever", async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      seenSignals.push(init?.signal ?? undefined);
      return Promise.resolve(
        new Response("hello", {
          headers: { "Content-Type": "text/plain" },
          status: 200,
        })
      );
    }) as typeof fetch;
    const files = new Files({
      adapter: vercelBlob({ downloadTimeoutMs: 1000 }),
    });
    await files.download("a.txt");
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
  });

  test("download with downloadTimeoutMs=0 disables the AbortSignal", async () => {
    const seenSignals: (AbortSignal | undefined)[] = [];
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      seenSignals.push(init?.signal ?? undefined);
      return Promise.resolve(
        new Response("hello", {
          headers: { "Content-Type": "text/plain" },
          status: 200,
        })
      );
    }) as typeof fetch;
    const files = new Files({
      adapter: vercelBlob({ downloadTimeoutMs: 0 }),
    });
    await files.download("a.txt");
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]).toBeUndefined();
  });

  describe("private mode", () => {
    test("upload passes access: 'private' to blob.put", async () => {
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      await files.upload("a.txt", "hello");
      const [firstCall] = putMock.mock.calls;
      if (!firstCall) {
        throw new Error("expected put to have been called");
      }
      const opts = firstCall[2] as { access: string };
      expect(opts.access).toBe("private");
    });

    test("copy passes access: 'private' to blob.copy", async () => {
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      await files.copy("a.txt", "b.txt");
      const [firstCall] = copyMock.mock.calls;
      if (!firstCall) {
        throw new Error("expected copy to have been called");
      }
      const opts = firstCall[2] as { access: string };
      expect(opts.access).toBe("private");
    });

    test("download routes through blob.get and never hits the public URL", async () => {
      // Track public-URL fetches; the private path must not touch fetch().
      const fetchCalls: string[] = [];
      globalThis.fetch = ((url: string | URL | Request) => {
        fetchCalls.push(typeof url === "string" ? url : url.toString());
        return Promise.resolve(new Response("from-public-url"));
      }) as typeof fetch;
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      const got = await files.download("a.txt");
      expect(await got.text()).toBe("hello");
      expect(getMock).toHaveBeenCalledTimes(1);
      const [firstGet] = getMock.mock.calls;
      if (!firstGet) {
        throw new Error("expected get to have been called");
      }
      const [pathArg, getOpts] = firstGet;
      expect(pathArg).toBe("a.txt");
      const o = getOpts as { access: string; token: string };
      expect(o.access).toBe("private");
      expect(o.token).toBe("test-token");
      expect(fetchCalls).toEqual([]);
    });

    test("download as: 'stream' returns the blob.get stream without buffering", async () => {
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
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

    test("head lazy body fetches via blob.get, not the public URL", async () => {
      const fetchCalls: string[] = [];
      globalThis.fetch = ((url: string | URL | Request) => {
        fetchCalls.push(typeof url === "string" ? url : url.toString());
        return Promise.resolve(new Response("from-public-url"));
      }) as typeof fetch;
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      const info = await files.head("a.txt");
      expect(await info.text()).toBe("hello");
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(fetchCalls).toEqual([]);
    });

    test("list items lazy bodies fetch via blob.get, not the public URL", async () => {
      const fetchCalls: string[] = [];
      globalThis.fetch = ((url: string | URL | Request) => {
        fetchCalls.push(typeof url === "string" ? url : url.toString());
        return Promise.resolve(new Response("from-public-url"));
      }) as typeof fetch;
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      const out = await files.list();
      const [item] = out.items;
      if (!item) {
        throw new Error("expected at least one list item");
      }
      expect(await item.text()).toBe("hello");
      expect(getMock).toHaveBeenCalledTimes(1);
      expect(fetchCalls).toEqual([]);
    });

    test("url throws Provider with a private-specific message", async () => {
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      try {
        await files.url("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("Provider");
        expect((error as FilesError).message).toMatch(/private/u);
      }
    });

    test("url throws even when the storeId fast path would otherwise apply", async () => {
      // Fast path is gated on storeId presence; private mode must override
      // it so we never hand out a URL that 401s.
      process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_abc123store_random";
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      try {
        await files.url("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("Provider");
      }
      process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    });

    test("url with responseContentDisposition still throws on private blobs", async () => {
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      try {
        await files.url("a.txt", { responseContentDisposition: "attachment" });
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("Provider");
      }
    });

    test("download maps blob.get rejection with status 404 to NotFound", async () => {
      getMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("nope"), { status: 404 }))
      );
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      try {
        await files.download("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("download maps blob.get rejection with status 403 to Unauthorized", async () => {
      getMock.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error("denied"), { status: 403 }))
      );
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      try {
        await files.download("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("Unauthorized");
      }
    });

    test("download maps a 304 (or null) blob.get response to NotFound", async () => {
      // Defensive: blob.get can resolve to null or to a non-200 statusCode.
      // Either case means we cannot return a body, so surface NotFound rather
      // than constructing a StoredFile with a null stream.
      getMock.mockImplementationOnce(() => Promise.resolve(null));
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      try {
        await files.download("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("default access is 'public' (existing put calls still pass access: 'public')", async () => {
      // Backward-compat regression guard: omitting `access` must keep the
      // existing public behavior.
      const files = new Files({ adapter: vercelBlob() });
      await files.upload("a.txt", "hello");
      const [firstCall] = putMock.mock.calls;
      if (!firstCall) {
        throw new Error("expected put to have been called");
      }
      const opts = firstCall[2] as { access: string };
      expect(opts.access).toBe("public");
    });
  });

  describe("OIDC mode", () => {
    interface AuthOpts {
      token?: string;
      oidcToken?: string;
      storeId?: string;
    }

    test("constructs successfully with OIDC env vars and no read-write token", () => {
      delete process.env.BLOB_READ_WRITE_TOKEN;
      process.env.VERCEL_OIDC_TOKEN = "oidc-token";
      process.env.BLOB_STORE_ID = "abc123store";
      expect(() => vercelBlob()).not.toThrow();
    });

    test("upload passes oidcToken + storeId instead of token when in OIDC mode", async () => {
      delete process.env.BLOB_READ_WRITE_TOKEN;
      process.env.VERCEL_OIDC_TOKEN = "oidc-token";
      process.env.BLOB_STORE_ID = "abc123store";
      const files = new Files({ adapter: vercelBlob() });
      await files.upload("a.txt", "hello");
      const [firstCall] = putMock.mock.calls;
      if (!firstCall) {
        throw new Error("expected put to have been called");
      }
      const opts = firstCall[2] as AuthOpts;
      expect(opts.token).toBeUndefined();
      expect(opts.oidcToken).toBe("oidc-token");
      expect(opts.storeId).toBe("abc123store");
    });

    test("explicit oidcToken without storeId throws — no silent RW-token fallback", () => {
      // A caller who explicitly passes `oidcToken` is asking for OIDC. With
      // no resolvable storeId, the adapter must not quietly fall back to the
      // RW token sitting in the env (set by beforeEach) — that would swap the
      // auth scheme out from under them. Mirrors upstream, which throws here.
      expect(() => vercelBlob({ oidcToken: "explicit-oidc" })).toThrow(
        /storeId/iu
      );
    });

    test("explicit oidcToken + storeId options work without any env vars", async () => {
      delete process.env.BLOB_READ_WRITE_TOKEN;
      const files = new Files({
        adapter: vercelBlob({
          oidcToken: "explicit-oidc",
          storeId: "explicit-store-id",
        }),
      });
      await files.upload("a.txt", "hello");
      const [firstCall] = putMock.mock.calls;
      if (!firstCall) {
        throw new Error("expected put to have been called");
      }
      const opts = firstCall[2] as AuthOpts;
      expect(opts.token).toBeUndefined();
      expect(opts.oidcToken).toBe("explicit-oidc");
      expect(opts.storeId).toBe("explicit-store-id");
    });

    test("explicit token option wins over OIDC env vars (matches SDK resolution order)", async () => {
      // SDK contract: an explicit `token` always wins, including over OIDC.
      // Failing this would silently swap the auth scheme out from under a
      // caller that deliberately passed `token`.
      process.env.VERCEL_OIDC_TOKEN = "oidc-token";
      process.env.BLOB_STORE_ID = "abc123store";
      const files = new Files({
        adapter: vercelBlob({ token: "explicit-rw-token" }),
      });
      await files.upload("a.txt", "hello");
      const [firstCall] = putMock.mock.calls;
      if (!firstCall) {
        throw new Error("expected put to have been called");
      }
      const opts = firstCall[2] as AuthOpts;
      expect(opts.token).toBe("explicit-rw-token");
      expect(opts.oidcToken).toBeUndefined();
      expect(opts.storeId).toBeUndefined();
    });

    test("OIDC env vars beat BLOB_READ_WRITE_TOKEN env var when both are set", async () => {
      // No explicit option overrides — OIDC takes precedence over the
      // legacy env token. Mirrors the upstream SDK behavior so a project
      // that ships both env vars actually gets the rotating credential.
      process.env.BLOB_READ_WRITE_TOKEN = "test-token";
      process.env.VERCEL_OIDC_TOKEN = "oidc-token";
      process.env.BLOB_STORE_ID = "abc123store";
      const files = new Files({ adapter: vercelBlob() });
      await files.upload("a.txt", "hello");
      const [firstCall] = putMock.mock.calls;
      if (!firstCall) {
        throw new Error("expected put to have been called");
      }
      const opts = firstCall[2] as AuthOpts;
      expect(opts.token).toBeUndefined();
      expect(opts.oidcToken).toBe("oidc-token");
      expect(opts.storeId).toBe("abc123store");
    });

    test("delete/copy/list/head also pass OIDC credentials", async () => {
      // Spot-check the rest of the surface — every call site spreads the
      // same auth object, so one mis-wiring would show up in any of them.
      delete process.env.BLOB_READ_WRITE_TOKEN;
      process.env.VERCEL_OIDC_TOKEN = "oidc-token";
      process.env.BLOB_STORE_ID = "abc123store";
      const files = new Files({ adapter: vercelBlob() });
      await files.delete("a.txt");
      await files.copy("a.txt", "b.txt");
      await files.list();
      await files.head("a.txt");
      const assertOidc = (opts: AuthOpts | undefined) => {
        if (!opts) {
          throw new Error("expected options to be passed");
        }
        expect(opts.token).toBeUndefined();
        expect(opts.oidcToken).toBe("oidc-token");
        expect(opts.storeId).toBe("abc123store");
      };
      assertOidc(delMock.mock.calls.at(-1)?.[1] as AuthOpts | undefined);
      assertOidc(copyMock.mock.calls.at(-1)?.[2] as AuthOpts | undefined);
      assertOidc(listMock.mock.calls.at(-1)?.[0] as AuthOpts | undefined);
      assertOidc(headMock.mock.calls.at(-1)?.[1] as AuthOpts | undefined);
    });

    test("private-mode download uses OIDC credentials, not a token", async () => {
      // The private path goes through `blob.get(...)` separately from the
      // other SDK calls, so it gets its own regression guard.
      delete process.env.BLOB_READ_WRITE_TOKEN;
      process.env.VERCEL_OIDC_TOKEN = "oidc-token";
      process.env.BLOB_STORE_ID = "abc123store";
      const files = new Files({ adapter: vercelBlob({ access: "private" }) });
      await files.download("a.txt");
      const [firstGet] = getMock.mock.calls;
      if (!firstGet) {
        throw new Error("expected get to have been called");
      }
      const [, getOpts] = firstGet;
      const o = getOpts as AuthOpts & { access: string };
      expect(o.access).toBe("private");
      expect(o.token).toBeUndefined();
      expect(o.oidcToken).toBe("oidc-token");
      expect(o.storeId).toBe("abc123store");
    });

    test("url fast path uses BLOB_STORE_ID env when no RW token exists (OIDC setup)", async () => {
      // OIDC users have no RW token to derive a storeId from, so the URL
      // fast path has to fall back to `BLOB_STORE_ID`. Otherwise public
      // URL lookups would round-trip to head() on every call.
      delete process.env.BLOB_READ_WRITE_TOKEN;
      process.env.VERCEL_OIDC_TOKEN = "oidc-token";
      process.env.BLOB_STORE_ID = "abc123store";
      const files = new Files({ adapter: vercelBlob() });
      headMock.mockClear();
      const url = await files.url("a.txt");
      expect(url).toBe(
        "https://abc123store.public.blob.vercel-storage.com/a.txt"
      );
      expect(headMock).not.toHaveBeenCalled();
    });

    test("url fast path strips the `store_` prefix from BLOB_STORE_ID", async () => {
      // Docs: "The SDK accepts the value in either `store_<id>` or `<id>`
      // form." The CDN host uses the bare id, so a `store_`-prefixed env
      // value must produce the same URL as the unprefixed form.
      delete process.env.BLOB_READ_WRITE_TOKEN;
      process.env.VERCEL_OIDC_TOKEN = "oidc-token";
      process.env.BLOB_STORE_ID = "store_abc123store";
      const files = new Files({ adapter: vercelBlob() });
      headMock.mockClear();
      const url = await files.url("a.txt");
      expect(url).toBe(
        "https://abc123store.public.blob.vercel-storage.com/a.txt"
      );
      expect(headMock).not.toHaveBeenCalled();
    });

    test("explicit storeId option powers the fast path even with a token-style URL miss", async () => {
      // Mixing a custom `token` shape (no derivable id) with an explicit
      // `storeId` should still produce a fast-path URL — covers the
      // user-supplies-everything case.
      process.env.BLOB_READ_WRITE_TOKEN = "custom_token_shape_x";
      const files = new Files({
        adapter: vercelBlob({ storeId: "abc123store" }),
      });
      headMock.mockClear();
      const url = await files.url("a.txt");
      expect(url).toBe(
        "https://abc123store.public.blob.vercel-storage.com/a.txt"
      );
      expect(headMock).not.toHaveBeenCalled();
    });
  });
});
