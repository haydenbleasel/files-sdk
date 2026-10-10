import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { encryption, generateEncryptionKey } from "../src/encryption/index.js";
import { Files, FilesError, UploadControl } from "../src/index.js";
import type { ResumableUploadSession } from "../src/index.js";
import { expectDispositionRefusal } from "./disposition-refusal.js";

const sigOf = (m: { mock: { calls: unknown[][] } }, index: number) =>
  m.mock.calls.at(-1)?.[index] as { signal?: AbortSignal } | undefined;

const STABLE_LAST_MODIFIED = "2024-01-02T03:04:05.000Z";
const STABLE_LAST_MODIFIED_MS = new Date(STABLE_LAST_MODIFIED).getTime();
const PROJECT_URL = "https://abc.supabase.co";
const STORAGE_URL = `${PROJECT_URL}/storage/v1`;
const KEY = "service-role-key";
const BUCKET = "uploads";

// Capture the real storage-js before `mock.module` swaps it below, so error
// cases use genuine `StorageApiError` instances and an end-to-end client can
// run storage-js's own response-to-error handling.
const { StorageApiError, StorageClient: RealStorageClient } =
  await import("@supabase/storage-js");

type SupaErr = InstanceType<typeof StorageApiError>;
type SupaResult<T> = { data: T; error: null } | { data: null; error: SupaErr };

const ok = <T>(data: T): SupaResult<T> => ({ data, error: null });
const fail = (
  status: number,
  statusCode: string,
  message: string,
  code?: string
): SupaResult<never> => ({
  data: null,
  error: new StorageApiError(message, status, statusCode, "storage", code),
});

const baseInfo = () => ({
  cacheControl: "max-age=3600",
  contentType: "text/plain",
  etag: '"etag-a"',
  lastModified: STABLE_LAST_MODIFIED,
  metadata: { author: "me" },
  size: 5,
});

const baseListItem = (name: string) => ({
  created_at: STABLE_LAST_MODIFIED,
  id: name,
  metadata: {
    cacheControl: "max-age=3600",
    contentLength: 5,
    eTag: '"etag-a"',
    lastModified: STABLE_LAST_MODIFIED,
    mimetype: "text/plain",
    size: 5,
  },
  name,
  updated_at: STABLE_LAST_MODIFIED,
});

const drainStream = async (
  stream: ReadableStream<Uint8Array>
): Promise<number> => {
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- sequentially draining a stream reader
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
    }
  }
  return total;
};

const uploadMock = mock((_path: string, _body: unknown, _opts: unknown) =>
  Promise.resolve(ok({ fullPath: `${BUCKET}/file`, id: "id", path: "file" }))
);
const downloadResolveMock = mock((_path: string, _parameters?: unknown) =>
  Promise.resolve(ok(new Blob(["hello"], { type: "text/plain" })))
);
const downloadStreamMock = mock((_parameters?: unknown) =>
  Promise.resolve(
    ok(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("hello"));
          c.close();
        },
      })
    )
  )
);
interface SupaInfo {
  cacheControl?: string;
  contentType?: string;
  etag?: string;
  lastModified?: string | number | Date;
  metadata?: Record<string, unknown>;
  size?: number;
}
const infoMock = mock((_path: string): Promise<SupaResult<SupaInfo>> =>
  Promise.resolve(ok(baseInfo()))
);
const removeMock = mock((_paths: string[]) => Promise.resolve(ok([])));
const copyMock = mock((_from: string, _to: string) =>
  Promise.resolve(ok({ path: "to" }))
);
const listMock = mock(
  (_path: string, _opts: { limit: number; offset: number }) =>
    Promise.resolve(ok([baseListItem("a/1.txt"), baseListItem("a/2.txt")]))
);
const listV2Mock = mock(
  (opts?: {
    with_delimiter?: boolean;
    prefix?: string;
    cursor?: string;
    limit?: number;
  }) => {
    if (opts?.with_delimiter) {
      return Promise.resolve(
        ok({
          // `b` carries a full `key`; `c` has only a leaf name (key reconstructed).
          folders: [{ key: "a/b/", name: "b" }, { name: "c" }],
          hasNext: false,
          objects: [
            {
              key: "a/1.txt",
              metadata: baseListItem("a/1.txt").metadata,
              name: "1.txt",
            },
          ],
        })
      );
    }
    // Flat mode: object names are full keys; the nested one proves the listing
    // is recursive (the legacy V1 list() would have missed it).
    return Promise.resolve(
      ok({
        folders: [],
        hasNext: false,
        objects: [
          { metadata: baseListItem("a/1.txt").metadata, name: "a/1.txt" },
          {
            metadata: baseListItem("a/nested/2.txt").metadata,
            name: "a/nested/2.txt",
          },
        ],
      })
    );
  }
);
const getPublicUrlMock = mock((path: string, opts?: { download?: unknown }) => {
  const qs = opts?.download
    ? `?download=${typeof opts.download === "string" ? opts.download : ""}`
    : "";
  return {
    data: { publicUrl: `${STORAGE_URL}/object/public/${BUCKET}/${path}${qs}` },
  };
});
const createSignedUrlMock = mock(
  (path: string, expiresIn: number, opts?: { download?: unknown }) => {
    const qs = opts?.download
      ? `&rscd=${encodeURIComponent(String(opts.download))}`
      : "";
    return Promise.resolve(
      ok({
        signedUrl: `${STORAGE_URL}/object/sign/${BUCKET}/${path}?token=sig&exp=${expiresIn}${qs}`,
      })
    );
  }
);
const createSignedUploadUrlMock = mock(
  (path: string, _opts?: { upsert?: boolean }) =>
    Promise.resolve(
      ok({
        path,
        signedUrl: `${STORAGE_URL}/object/upload/sign/${BUCKET}/${path}?token=upload-tok`,
        token: "upload-tok",
      })
    )
);

const downloadBuilder = (path: string, parameters?: unknown) =>
  Object.assign(downloadResolveMock(path, parameters), {
    asStream: () => downloadStreamMock(parameters),
  });

const bucketRef = {
  copy: copyMock,
  createSignedUploadUrl: createSignedUploadUrlMock,
  createSignedUrl: createSignedUrlMock,
  download: (path: string, _options?: unknown, parameters?: unknown) =>
    downloadBuilder(path, parameters),
  getPublicUrl: getPublicUrlMock,
  info: infoMock,
  list: listMock,
  listV2: listV2Mock,
  remove: removeMock,
  upload: uploadMock,
};

class StorageClientStub {
  static lastInit?: { url: string; headers: Record<string, string> };

  url: string;
  headers: Record<string, string>;

  constructor(url: string, headers: Record<string, string>) {
    StorageClientStub.lastInit = { headers, url };
    this.url = url;
    this.headers = headers;
  }

  // oxlint-disable-next-line class-methods-use-this
  from(_bucket: string) {
    return bucketRef;
  }
}

mock.module("@supabase/storage-js", () => ({
  StorageClient: StorageClientStub,
}));

const { mapSupabaseError, supabase } = await import("../src/supabase/index.js");

const makeAdapter = (overrides?: Record<string, unknown>) =>
  supabase({
    bucket: BUCKET,
    key: KEY,
    url: PROJECT_URL,
    ...overrides,
  });

beforeEach(() => {
  uploadMock.mockClear();
  downloadResolveMock.mockClear();
  downloadStreamMock.mockClear();
  infoMock.mockClear();
  removeMock.mockClear();
  copyMock.mockClear();
  listMock.mockClear();
  listV2Mock.mockClear();
  getPublicUrlMock.mockClear();
  createSignedUrlMock.mockClear();
  createSignedUploadUrlMock.mockClear();

  uploadMock.mockImplementation(() =>
    Promise.resolve(ok({ fullPath: `${BUCKET}/file`, id: "id", path: "file" }))
  );
  downloadResolveMock.mockImplementation(() =>
    Promise.resolve(ok(new Blob(["hello"], { type: "text/plain" })))
  );
  downloadStreamMock.mockImplementation(() =>
    Promise.resolve(
      ok(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("hello"));
            c.close();
          },
        })
      )
    )
  );
  infoMock.mockImplementation(() => Promise.resolve(ok(baseInfo())));
  removeMock.mockImplementation(() => Promise.resolve(ok([])));
  copyMock.mockImplementation(() => Promise.resolve(ok({ path: "to" })));
  listMock.mockImplementation(() =>
    Promise.resolve(ok([baseListItem("a/1.txt"), baseListItem("a/2.txt")]))
  );

  StorageClientStub.lastInit = undefined;
});

describe("supabase adapter", () => {
  describe("construction", () => {
    test("missing bucket throws", () => {
      expect(() =>
        supabase({ bucket: "", key: KEY, url: PROJECT_URL })
      ).toThrow(/bucket/u);
    });

    test("missing url+key throws helpful message", () => {
      expect(() => supabase({ bucket: BUCKET })).toThrow(
        /missing credentials/u
      );
      expect(() => supabase({ bucket: BUCKET })).toThrow(
        expect.objectContaining({ code: "Invalid" })
      );
    });

    test("constructs StorageClient with /storage/v1 suffix", () => {
      const adapter = makeAdapter();
      expect(adapter.bucket).toBe(BUCKET);
      expect(adapter.name).toBe("supabase");
      expect(StorageClientStub.lastInit?.url).toBe(STORAGE_URL);
      expect(StorageClientStub.lastInit?.headers.Authorization).toBe(
        `Bearer ${KEY}`
      );
      expect(StorageClientStub.lastInit?.headers.apikey).toBe(KEY);
    });

    test("does not duplicate /storage/v1 suffix when already present", () => {
      supabase({ bucket: BUCKET, key: KEY, url: STORAGE_URL });
      expect(StorageClientStub.lastInit?.url).toBe(STORAGE_URL);
    });

    test("strips trailing slashes from project URL before appending suffix", () => {
      supabase({ bucket: BUCKET, key: KEY, url: `${PROJECT_URL}///` });
      expect(StorageClientStub.lastInit?.url).toBe(STORAGE_URL);
    });

    test("accepts a SupabaseClient-like object via `client`", () => {
      const fakeStorage = { from: () => bucketRef } as never;
      const adapter = supabase({
        bucket: BUCKET,
        client: { storage: fakeStorage },
      });
      // No StorageClient constructed when an existing client is passed.
      expect(StorageClientStub.lastInit).toBeUndefined();
      expect(adapter.raw).toBe(fakeStorage);
    });

    test("accepts a StorageClient directly via `client`", () => {
      const direct = { from: () => bucketRef } as never;
      const adapter = supabase({ bucket: BUCKET, client: direct });
      expect(StorageClientStub.lastInit).toBeUndefined();
      expect(adapter.raw).toBe(direct);
    });
  });

  describe("upload", () => {
    test("string body sets contentType and reports size", async () => {
      const files = new Files({ adapter: makeAdapter() });
      const result = await files.upload("a.txt", "hello", {
        cacheControl: "public, max-age=60",
        contentType: "text/plain",
        metadata: { author: "me" },
      });
      expect(result.key).toBe("a.txt");
      expect(result.size).toBe(5);
      expect(result.contentType).toBe("text/plain");

      expect(uploadMock).toHaveBeenCalledTimes(1);
      const [uploadCall] = uploadMock.mock.calls;
      if (!uploadCall) {
        throw new Error("expected upload to have been called");
      }
      const [path, body, opts] = uploadCall;
      expect(path).toBe("a.txt");
      expect(body).toBeInstanceOf(Uint8Array);
      const o = opts as {
        contentType: string;
        cacheControl?: string;
        metadata?: Record<string, string>;
        upsert?: boolean;
      };
      expect(o.contentType).toBe("text/plain");
      // storage-js takes seconds and adds `max-age=` itself.
      expect(o.cacheControl).toBe("60");
      expect(o.metadata).toEqual({ author: "me" });
      expect(o.upsert).toBe(true);
    });

    test("cacheControl maps to Supabase's seconds form", async () => {
      const adapter = makeAdapter();
      const sent = async (cacheControl: string) => {
        uploadMock.mockClear();
        await adapter.upload("a.txt", "hi", { cacheControl });
        const opts = uploadMock.mock.calls[0]?.[2] as { cacheControl?: string };
        return opts.cacheControl;
      };
      expect(await sent("max-age=31536000")).toBe("31536000");
      expect(await sent("Public, MAX-AGE=5,")).toBe("5");
      // A bare integer is already storage-js's native seconds form.
      expect(await sent(" 3600 ")).toBe("3600");
    });

    test("cacheControl Supabase can't store throws before any upload", async () => {
      const adapter = makeAdapter();
      for (const cacheControl of [
        "no-store",
        "public",
        "public, max-age=60, immutable",
        "max-age=60, max-age=120",
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- each case must reject independently
        await expect(
          adapter.upload("a.txt", "hi", { cacheControl })
        ).rejects.toThrow(/stores only a max-age/u);
      }
      expect(uploadMock).not.toHaveBeenCalled();
    });

    test("Uint8Array passes through and reports its byteLength", async () => {
      const adapter = makeAdapter();
      const result = await adapter.upload(
        "a.bin",
        new Uint8Array([1, 2, 3, 4])
      );
      expect(result.size).toBe(4);
      const [uploadCall] = uploadMock.mock.calls;
      if (!uploadCall) {
        throw new Error("expected upload");
      }
      const [, body] = uploadCall;
      expect(body).toBeInstanceOf(Uint8Array);
      expect((body as Uint8Array).byteLength).toBe(4);
    });

    test("ArrayBuffer flows through with full byteLength", async () => {
      const ab = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
      const result = await makeAdapter().upload("a.bin", ab);
      expect(result.size).toBe(8);
      expect(result.contentType).toBe("application/octet-stream");
    });

    test("DataView at offset respects byteOffset and byteLength", async () => {
      const view = new DataView(new ArrayBuffer(16), 4, 10);
      const result = await makeAdapter().upload("v.bin", view);
      expect(result.size).toBe(10);
      const [uploadCall] = uploadMock.mock.calls;
      if (!uploadCall) {
        throw new Error("expected upload");
      }
      const [, body] = uploadCall;
      expect((body as Uint8Array).byteLength).toBe(10);
    });

    test("Blob passes through and Blob.type wins when no override", async () => {
      const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], {
        type: "image/jpeg",
      });
      const result = await makeAdapter().upload("photo.jpg", blob);
      expect(result.size).toBe(3);
      expect(result.contentType).toBe("image/jpeg");
      const [uploadCall] = uploadMock.mock.calls;
      if (!uploadCall) {
        throw new Error("expected upload");
      }
      const [, body] = uploadCall;
      expect(body).toBeInstanceOf(Blob);
    });

    test("Blob with explicit contentType override is converted to Uint8Array", async () => {
      // Supabase-specific: Blob/File goes multipart and ignores contentType,
      // so we drain to bytes when an override is requested.
      const blob = new Blob(["hello"], { type: "text/plain" });
      const result = await makeAdapter().upload("a.bin", blob, {
        contentType: "application/octet-stream",
      });
      expect(result.contentType).toBe("application/octet-stream");
      const [uploadCall] = uploadMock.mock.calls;
      if (!uploadCall) {
        throw new Error("expected upload");
      }
      const [, body] = uploadCall;
      expect(body).toBeInstanceOf(Uint8Array);
    });

    test("ReadableStream passes through with duplex:half and follow-up info() reports size", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("hello"));
          c.close();
        },
      });
      const result = await makeAdapter().upload("s.txt", stream);
      expect(uploadMock).toHaveBeenCalledTimes(1);
      const [uploadCall] = uploadMock.mock.calls;
      if (!uploadCall) {
        throw new Error("expected upload");
      }
      const [, body, opts] = uploadCall;
      expect(body).toBe(stream);
      expect((opts as { duplex?: string }).duplex).toBe("half");
      expect(infoMock).toHaveBeenCalledTimes(1);
      expect(result.size).toBe(5);
      expect(result.etag).toBe("etag-a");
      expect(result.lastModified).toBe(STABLE_LAST_MODIFIED_MS);
    });
  });

  describe("download", () => {
    test("buffered: returns body and Blob.type as content type", async () => {
      const files = new Files({ adapter: makeAdapter() });
      const got = await files.download("a.txt");
      expect(await got.text()).toBe("hello");
      expect(got.size).toBe(5);
      // Bun's Blob constructor normalizes "text/plain" to include charset.
      expect(got.type).toMatch(/^text\/plain/u);
    });

    test("buffered: falls back to info() when Blob.type is empty", async () => {
      downloadResolveMock.mockImplementationOnce(() =>
        Promise.resolve(ok(new Blob(["hello"], { type: "" })))
      );
      const got = await makeAdapter().download("a.txt");
      expect(got.type).toBe("text/plain");
      expect(got.etag).toBe("etag-a");
      expect(infoMock).toHaveBeenCalledTimes(1);
    });

    test("as: 'stream' returns a stream and pulls metadata from info()", async () => {
      const files = new Files({ adapter: makeAdapter() });
      const got = await files.download("a.txt", { as: "stream" });
      expect(downloadStreamMock).toHaveBeenCalledTimes(1);
      expect(infoMock).toHaveBeenCalledTimes(1);
      expect(got.type).toBe("text/plain");
      expect(got.size).toBe(5);
      const total = await drainStream(got.stream());
      expect(total).toBe(5);
    });
  });

  describe("head", () => {
    test("returns metadata and does not pre-fetch the body", async () => {
      const files = new Files({ adapter: makeAdapter() });
      const info = await files.head("a.txt");
      expect(info.size).toBe(5);
      expect(info.contentType).toBe("text/plain");
      expect(info.etag).toBe("etag-a");
      expect(info.lastModified).toBe(STABLE_LAST_MODIFIED_MS);
      expect(info).not.toHaveProperty("text");
      expect(downloadResolveMock).not.toHaveBeenCalled();
    });

    test("exists returns true for present keys and false for missing keys", async () => {
      const files = new Files({ adapter: makeAdapter() });
      await expect(files.exists("a.txt")).resolves.toBe(true);

      infoMock.mockImplementationOnce(() =>
        Promise.resolve(fail(404, "NotFound", "missing"))
      );
      await expect(files.exists("missing.txt")).resolves.toBe(false);
    });

    test("exists is false for Supabase's HTTP 400 + statusCode '404' NoSuchKey shape", async () => {
      // What storage-js builds from the real response: HTTP 400 on `status`,
      // the body's `statusCode: "404"` and `code: "NoSuchKey"`.
      infoMock.mockImplementationOnce(() =>
        Promise.resolve(fail(400, "404", "Object not found", "NoSuchKey"))
      );
      await expect(makeAdapter().exists("missing.txt")).resolves.toBe(false);
    });

    test("a real StorageClient maps Supabase's missing-object response to NotFound", async () => {
      // End to end through storage-js's own error handling: the server
      // answers HTTP 400 with the real status in the JSON body.
      const fetchMock = mock((_url: string, _init?: RequestInit) =>
        Promise.resolve(
          Response.json(
            {
              code: "NoSuchKey",
              error: "not_found",
              message: "Object not found",
              statusCode: "404",
            },
            { status: 400 }
          )
        )
      );
      const adapter = supabase({
        bucket: BUCKET,
        client: new RealStorageClient(
          STORAGE_URL,
          { apikey: KEY },
          fetchMock as unknown as typeof fetch
        ),
      });
      await expect(adapter.exists("missing.txt")).resolves.toBe(false);
      await expect(adapter.head("missing.txt")).rejects.toMatchObject({
        code: "NotFound",
        message: "Object not found",
      });
      await expect(adapter.download("missing.txt")).rejects.toMatchObject({
        code: "NotFound",
      });
      // exists + head (the info endpoint), then download's body and info
      // requests, which run concurrently.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    test("exists rethrows a non-NotFound error rather than reporting false", async () => {
      // Only a NotFound is swallowed into `false`; anything else (auth,
      // transport) must surface so callers don't mistake it for absence.
      infoMock.mockImplementationOnce(() =>
        Promise.resolve(fail(403, "Unauthorized", "denied"))
      );
      try {
        await makeAdapter().exists("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("Unauthorized");
      }
    });
  });

  describe("delete", () => {
    test("delegates to remove([key])", async () => {
      const files = new Files({ adapter: makeAdapter() });
      await files.delete("a.txt");
      expect(removeMock).toHaveBeenCalledTimes(1);
      const [removeCall] = removeMock.mock.calls;
      if (!removeCall) {
        throw new Error("expected remove");
      }
      expect(removeCall[0]).toEqual(["a.txt"]);
    });

    test("does NOT throw on missing key (idempotent)", async () => {
      removeMock.mockImplementationOnce(() => Promise.resolve(ok([])));
      await expect(makeAdapter().delete("nope.txt")).resolves.toBeUndefined();
    });

    test("deleteMany delegates to remove(keys)", async () => {
      const files = new Files({ adapter: makeAdapter() });
      const result = await files.delete(["a.txt", "b.txt"]);
      expect(result).toEqual({ results: ["a.txt", "b.txt"] });
      expect(removeMock).toHaveBeenCalledTimes(1);
      const [removeCall] = removeMock.mock.calls;
      if (!removeCall) {
        throw new Error("expected remove");
      }
      expect(removeCall[0]).toEqual(["a.txt", "b.txt"]);
    });

    test("deleteMany short-circuits an empty list without calling remove", async () => {
      const files = new Files({ adapter: makeAdapter() });
      const result = await files.delete([]);
      expect(result).toEqual({ results: [] });
      expect(removeMock).not.toHaveBeenCalled();
    });

    test("deleteMany maps a batch-level remove() error onto every key", async () => {
      removeMock.mockImplementationOnce(() =>
        Promise.resolve(fail(403, "Unauthorized", "denied"))
      );
      const files = new Files({ adapter: makeAdapter() });
      const result = await files.delete(["a.txt", "b.txt"]);
      expect(result.results).toEqual([]);
      expect(result.errors?.map((e) => e.key)).toEqual(["a.txt", "b.txt"]);
      for (const entry of result.errors ?? []) {
        expect(entry.error).toBeInstanceOf(FilesError);
        expect(entry.error.code).toBe("Unauthorized");
      }
    });

    test("deleteMany sends at most 1000 keys per remove() and scopes a batch error to that batch", async () => {
      const keys = Array.from({ length: 2500 }, (_, i) => `k${i}`);
      removeMock
        .mockImplementationOnce(() => Promise.resolve(ok([])))
        .mockImplementationOnce(() =>
          Promise.resolve(fail(400, "500", "bulk limit", "InvalidRequest"))
        )
        .mockImplementationOnce(() => Promise.resolve(ok([])));
      const result = await makeAdapter().deleteMany?.(keys);
      expect(removeMock.mock.calls.map(([batch]) => batch.length)).toEqual([
        1000, 1000, 500,
      ]);
      expect(removeMock.mock.calls[1]?.[0][0]).toBe("k1000");
      expect(result?.results).toEqual([
        ...keys.slice(0, 1000),
        ...keys.slice(2000),
      ]);
      expect(result?.errors?.map((e) => e.key)).toEqual(keys.slice(1000, 2000));
      expect(result?.errors?.[0]?.error.code).toBe("Provider");
    });

    test("a bulk delete with stopOnError runs per key through delete() and stops at the first failure", async () => {
      // Files never hands stopOnError to the native batch: each key goes
      // through `delete()` (one remove() per key).
      removeMock
        .mockImplementationOnce(() => Promise.resolve(ok([])))
        .mockImplementationOnce(() =>
          Promise.resolve(fail(404, "NotFound", "gone"))
        );
      const files = new Files({ adapter: makeAdapter() });
      const result = await files.delete(["a.txt", "b.txt", "c.txt"], {
        stopOnError: true,
      });
      expect(result.results).toEqual(["a.txt"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors?.[0]?.key).toBe("b.txt");
      expect(result.errors?.[0]?.error.code).toBe("NotFound");
      expect(removeMock).toHaveBeenCalledTimes(2);
    });

    test("deleteMany with stopOnError removes one key at a time and stops at the first failure", async () => {
      // stopOnError takes the per-key fallback path (one remove() per key)
      // rather than the single batched remove().
      removeMock
        .mockImplementationOnce(() => Promise.resolve(ok([])))
        .mockImplementationOnce(() =>
          Promise.resolve(fail(404, "NotFound", "gone"))
        );
      const adapter = makeAdapter();
      const result = await adapter.deleteMany?.(["a.txt", "b.txt", "c.txt"], {
        stopOnError: true,
      });
      if (!result) {
        throw new Error("expected a deleteMany result");
      }
      expect(result.results).toEqual(["a.txt"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors?.[0]?.key).toBe("b.txt");
      expect(result.errors?.[0]?.error.code).toBe("NotFound");
      // The third key is never attempted once the second fails.
      expect(removeMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("copy", () => {
    test("delegates to native copy()", async () => {
      const files = new Files({ adapter: makeAdapter() });
      await files.copy("a.txt", "b.txt");
      expect(copyMock).toHaveBeenCalledTimes(1);
      const [copyCall] = copyMock.mock.calls;
      if (!copyCall) {
        throw new Error("expected copy");
      }
      expect(copyCall[0]).toBe("a.txt");
      expect(copyCall[1]).toBe("b.txt");
    });
  });

  describe("list", () => {
    test("flat list goes through listV2 and returns full (nested) keys", async () => {
      const files = new Files({ adapter: makeAdapter() });
      const out = await files.list({ limit: 10, prefix: "a/" });
      // Names are full keys — including nested ones the legacy folder-scoped
      // V1 list() never surfaced.
      expect(out.items.map((i) => i.key)).toEqual([
        "a/1.txt",
        "a/nested/2.txt",
      ]);
      expect(listMock).not.toHaveBeenCalled();
      const [v2Call] = listV2Mock.mock.calls;
      if (!v2Call) {
        throw new Error("expected listV2");
      }
      expect(v2Call[0]).toEqual({ limit: 10, prefix: "a/" });
    });

    test("keys from a flat list round-trip through head/download", async () => {
      const files = new Files({ adapter: makeAdapter() });
      const out = await files.list({ limit: 10, prefix: "a/" });
      const item = out.items.at(-1);
      if (!item) {
        throw new Error("expected at least one item");
      }
      expect(item.key).toBe("a/nested/2.txt");
      await expect(files.head(item.key)).resolves.toBeDefined();
      await expect(files.download(item.key)).resolves.toBeDefined();
    });

    test("a delimiter lists via listV2 and maps folders to prefixes", async () => {
      const out = await makeAdapter().list({ delimiter: "/", prefix: "a/" });
      expect(out.items.map((i) => i.key)).toEqual(["a/1.txt"]);
      // folder "a/c" (no trailing slash) is normalized to "a/c/".
      expect(out.prefixes).toEqual(["a/b/", "a/c/"]);
      const [v2Call] = listV2Mock.mock.calls;
      if (!v2Call) {
        throw new Error("expected listV2");
      }
      expect(v2Call[0]).toMatchObject({ prefix: "a/", with_delimiter: true });
    });

    test("rejects a non-slash delimiter", async () => {
      await expect(
        makeAdapter().list({ delimiter: "|" })
      ).rejects.toMatchObject({ code: "Unsupported" });
    });

    test("emits the V2 cursor when the server reports more", async () => {
      listV2Mock.mockImplementationOnce(() =>
        Promise.resolve(
          ok({
            folders: [],
            hasNext: true,
            nextCursor: "tok-2",
            objects: [
              { metadata: baseListItem("a/1.txt").metadata, name: "a/1.txt" },
            ],
          })
        )
      );
      const out = await makeAdapter().list({ limit: 1 });
      expect(out.cursor).toBe("tok-2");
    });

    test("omits cursor on the final page", async () => {
      const out = await makeAdapter().list({ limit: 100 });
      expect(out.cursor).toBeUndefined();
    });

    test("threads the cursor back into listV2", async () => {
      await makeAdapter().list({ cursor: "tok-2", limit: 50 });
      const [v2Call] = listV2Mock.mock.calls;
      if (!v2Call) {
        throw new Error("expected listV2");
      }
      expect(v2Call[0]).toEqual({ cursor: "tok-2", limit: 50 });
    });

    test("items do not surface Supabase's system metadata block as user metadata", async () => {
      // The listing row's `metadata` is eTag/size/mimetype/cacheControl/…
      // — system fields head()/download() never report as `metadata`.
      const out = await makeAdapter().list();
      expect(out.items.length).toBeGreaterThan(0);
      for (const item of out.items) {
        expect(item.metadata).toBeUndefined();
      }
      const [first] = out.items;
      expect(first?.etag).toBe("etag-a");
      expect(first?.size).toBe(5);
      expect(first?.contentType).toBe("text/plain");
      expect(first?.lastModified).toBe(STABLE_LAST_MODIFIED_MS);
    });

    test("items surface user_metadata when the listing carries it", async () => {
      const objects = [
        {
          metadata: baseListItem("a/1.txt").metadata,
          name: "a/1.txt",
          user_metadata: { author: "me", count: 2, missing: null },
        },
      ];
      listV2Mock.mockImplementationOnce(() =>
        Promise.resolve(ok({ folders: [], hasNext: false, objects }))
      );
      const out = await makeAdapter().list();
      expect(out.items[0]?.metadata).toEqual({ author: "me", count: "2" });
    });
  });

  describe("url", () => {
    test("publicBaseUrl short-circuits without signing or hitting getPublicUrl", async () => {
      const adapter = makeAdapter({
        publicBaseUrl: "https://cdn.example.com",
      });
      expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
      expect(getPublicUrlMock).not.toHaveBeenCalled();
      expect(createSignedUrlMock).not.toHaveBeenCalled();
    });

    test("publicBaseUrl tolerates trailing slash", async () => {
      const adapter = makeAdapter({
        publicBaseUrl: "https://cdn.example.com/",
      });
      expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
    });

    test("public: true uses getPublicUrl() (no signing)", async () => {
      const adapter = makeAdapter({ public: true });
      const url = await adapter.url("a.txt");
      expect(url).toContain(`/object/public/${BUCKET}/a.txt`);
      expect(getPublicUrlMock).toHaveBeenCalledTimes(1);
      expect(createSignedUrlMock).not.toHaveBeenCalled();
    });

    test("expiresIn forces signing even when publicBaseUrl set", async () => {
      const files = new Files({
        adapter: makeAdapter({ publicBaseUrl: "https://cdn.example.com" }),
      });
      expect(await files.url("a.txt")).toBe("https://cdn.example.com/a.txt");
      expect(createSignedUrlMock).not.toHaveBeenCalled();
      const url = await files.url("a.txt", { expiresIn: 60 });
      expect(url).toContain("/object/sign/");
      expect(getPublicUrlMock).not.toHaveBeenCalled();
      const [signCall] = createSignedUrlMock.mock.calls;
      if (!signCall) {
        throw new Error("expected createSignedUrl");
      }
      expect(signCall[0]).toBe("a.txt");
      expect(signCall[1]).toBe(60);
      expect(signCall[2]).toEqual({});
    });

    test("expiresIn forces signing even when public:true", async () => {
      const files = new Files({ adapter: makeAdapter({ public: true }) });
      expect(await files.url("a.txt")).toContain(
        `/object/public/${BUCKET}/a.txt`
      );
      expect(getPublicUrlMock).toHaveBeenCalledTimes(1);
      expect(createSignedUrlMock).not.toHaveBeenCalled();
      const url = await files.url("a.txt", { expiresIn: 60 });
      expect(url).toContain("/object/sign/");
      expect(getPublicUrlMock).toHaveBeenCalledTimes(1);
      const [signCall] = createSignedUrlMock.mock.calls;
      if (!signCall) {
        throw new Error("expected createSignedUrl");
      }
      expect(signCall[1]).toBe(60);
    });

    test("default: signs with createSignedUrl and honors per-call expiresIn", async () => {
      const adapter = makeAdapter();
      const url = await adapter.url("a.txt", { expiresIn: 60 });
      expect(url).toContain("/object/sign/");
      const [signCall] = createSignedUrlMock.mock.calls;
      if (!signCall) {
        throw new Error("expected createSignedUrl");
      }
      expect(signCall[0]).toBe("a.txt");
      expect(signCall[1]).toBe(60);
    });

    test("uses defaultUrlExpiresIn when expiresIn not passed", async () => {
      const adapter = makeAdapter({ defaultUrlExpiresIn: 90 });
      await adapter.url("a.txt");
      const [signCall] = createSignedUrlMock.mock.calls;
      if (!signCall) {
        throw new Error("expected createSignedUrl");
      }
      expect(signCall[1]).toBe(90);
    });

    test("responseContentDisposition forces signing even when public:true", async () => {
      const adapter = makeAdapter({ public: true });
      await adapter.url("a.txt", { responseContentDisposition: "attachment" });
      expect(getPublicUrlMock).not.toHaveBeenCalled();
      expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
      const [signCall] = createSignedUrlMock.mock.calls;
      if (!signCall) {
        throw new Error("expected createSignedUrl");
      }
      // Supabase's `download: string` means "attachment *named* this" — a
      // bare "attachment" header value maps to `true` (server-chosen name),
      // not to a file literally named "attachment".
      expect(signCall[2]?.download).toBe(true);
    });

    test("responseContentDisposition with a filename maps it to download", async () => {
      const adapter = makeAdapter();
      await adapter.url("a.txt", {
        responseContentDisposition: 'attachment; filename="report.pdf"',
      });
      const [signCall] = createSignedUrlMock.mock.calls;
      if (!signCall) {
        throw new Error("expected createSignedUrl");
      }
      expect(signCall[2]?.download).toBe("report.pdf");
    });

    test("responseContentDisposition with an unquoted filename works too", async () => {
      const adapter = makeAdapter();
      await adapter.url("a.txt", {
        responseContentDisposition: "attachment; filename=report.pdf",
      });
      const [signCall] = createSignedUrlMock.mock.calls;
      if (!signCall) {
        throw new Error("expected createSignedUrl");
      }
      expect(signCall[2]?.download).toBe("report.pdf");
    });

    test("an inline responseContentDisposition is rejected", async () => {
      const adapter = makeAdapter();
      await expect(
        adapter.url("a.txt", { responseContentDisposition: "inline" })
      ).rejects.toMatchObject({
        code: "Unsupported",
        message: expect.stringMatching(/only force an attachment/u),
      });
      await expectDispositionRefusal(
        adapter.url("a.txt", { responseContentDisposition: "inline" })
      );
    });

    test("responseContentDisposition forces signing even when publicBaseUrl set", async () => {
      const adapter = makeAdapter({
        publicBaseUrl: "https://cdn.example.com",
      });
      const url = await adapter.url("a.txt", {
        responseContentDisposition: "attachment",
      });
      expect(url).toContain("/object/sign/");
      expect(createSignedUrlMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("capabilities", () => {
    test("declares signed URLs, signed uploads without bound limits, and slash folding", () => {
      const { capabilities } = new Files({ adapter: makeAdapter() });
      expect(capabilities).toMatchObject({
        cacheControl: true,
        delimiter: "slash",
        metadata: true,
        publicUrl: false,
        rangeRead: false,
        resumable: true,
        serverSideCopy: true,
        uploadProgress: false,
      });
      expect(capabilities.signedUrl).toEqual({
        disposition: true,
        expiry: "exact",
        supported: true,
      });
      expect(capabilities.signedUpload).toEqual({
        contentType: false,
        maxSize: false,
        supported: true,
      });
    });

    test("publicUrl follows publicBaseUrl and public: true", () => {
      for (const opts of [
        { publicBaseUrl: "https://cdn.example.com" },
        { public: true },
      ]) {
        const { capabilities } = new Files({ adapter: makeAdapter(opts) });
        expect(capabilities.publicUrl).toBe(true);
        expect(capabilities.signedUrl.supported).toBe(true);
      }
      expect(
        new Files({ adapter: makeAdapter({ public: false }) }).capabilities
          .publicUrl
      ).toBe(false);
    });
  });

  describe("signedUploadUrl", () => {
    test("returns PUT URL with x-upsert header", async () => {
      const adapter = makeAdapter();
      const out = await adapter.signedUploadUrl("a.txt", { expiresIn: 60 });
      if (out.method !== "PUT") {
        throw new Error("expected PUT");
      }
      expect(out.url).toContain("/object/upload/sign/");
      expect(out.headers?.["x-upsert"]).toBe("true");
      expect(createSignedUploadUrlMock).toHaveBeenCalledTimes(1);
    });

    test("throws when contentType is set (Supabase can't bind it)", async () => {
      // An advisory Content-Type header isn't enforcement; the contract says
      // throw instead of returning one.
      await expect(
        makeAdapter().signedUploadUrl("a.png", {
          contentType: "image/png",
          expiresIn: 60,
        })
      ).rejects.toMatchObject({
        code: "Unsupported",
        message: expect.stringMatching(/`contentType` is not supported/u),
      });
      expect(createSignedUploadUrlMock).not.toHaveBeenCalled();
    });

    test("throws when maxSize is set", async () => {
      try {
        await makeAdapter().signedUploadUrl("a.txt", {
          expiresIn: 60,
          maxSize: 1000,
        });
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).message).toMatch(/maxSize/u);
      }
    });

    test("throws on a positive minSize and accepts minSize: 0", async () => {
      // A signed upload token can't enforce a minimum size, so a positive
      // floor fails closed instead of being silently dropped.
      await expect(
        makeAdapter().signedUploadUrl("a.txt", { expiresIn: 60, minSize: 1 })
      ).rejects.toThrow(/`minSize` is not supported/u);
      expect(createSignedUploadUrlMock).not.toHaveBeenCalled();
      const out = await makeAdapter().signedUploadUrl("a.txt", {
        expiresIn: 60,
        minSize: 0,
      });
      expect(out.method).toBe("PUT");
    });
  });

  describe("error mapping", () => {
    test("status 404 maps to NotFound", () => {
      const err = mapSupabaseError(
        Object.assign(new Error("missing"), { status: 404 })
      );
      expect(err.code).toBe("NotFound");
      expect(err.message).toBe("missing");
    });

    test("statusCode 'NotFound' maps to NotFound", () => {
      const err = mapSupabaseError(
        Object.assign(new Error("missing"), {
          status: 400,
          statusCode: "NotFound",
        })
      );
      expect(err.code).toBe("NotFound");
    });

    test("status 401 maps to Unauthorized", () => {
      const err = mapSupabaseError(
        Object.assign(new Error("unauth"), { status: 401 })
      );
      expect(err.code).toBe("Unauthorized");
    });

    test("statusCode 'InvalidJWT' maps to Unauthorized", () => {
      const err = mapSupabaseError(
        Object.assign(new Error("bad jwt"), {
          status: 400,
          statusCode: "InvalidJWT",
        })
      );
      expect(err.code).toBe("Unauthorized");
    });

    test("statusCode 'Duplicate' maps to Conflict", () => {
      const err = mapSupabaseError(
        Object.assign(new Error("exists"), {
          status: 409,
          statusCode: "Duplicate",
        })
      );
      expect(err.code).toBe("Conflict");
    });

    test("a numeric body statusCode wins over the HTTP 400", () => {
      const err = mapSupabaseError(
        new StorageApiError("Object not found", 400, "404", "storage")
      );
      expect(err.code).toBe("NotFound");
      expect(err.message).toBe("Object not found");
      expect(
        mapSupabaseError(new StorageApiError("denied", 400, "403", "storage"))
          .code
      ).toBe("Unauthorized");
      expect(
        mapSupabaseError(
          new StorageApiError(
            "exists",
            400,
            "409",
            "storage",
            "KeyAlreadyExists"
          )
        ).code
      ).toBe("Conflict");
    });

    test("the body's `code` classifies when statusCode is absent", () => {
      // Without a body statusCode, storage-js copies `code` into statusCode.
      const err = mapSupabaseError(
        new StorageApiError("gone", 400, "NoSuchKey", "storage", "NoSuchKey")
      );
      expect(err.code).toBe("NotFound");
    });

    test("a raw body's legacy `error` field classifies", () => {
      expect(
        mapSupabaseError({ error: "not_found", message: "nope", status: 400 })
          .code
      ).toBe("NotFound");
    });

    test("InvalidKey (a malformed object key) is not Unauthorized", () => {
      const err = mapSupabaseError(
        new StorageApiError("bad key", 400, "400", "storage", "InvalidKey")
      );
      expect(err.code).toBe("Provider");
    });

    test("status 500 maps to Provider", () => {
      const err = mapSupabaseError(
        Object.assign(new Error("oops"), { status: 500 })
      );
      expect(err.code).toBe("Provider");
    });

    test("falls back to numeric statusCode when status is absent", () => {
      // Some transport errors arrive with only `statusCode` (a number)
      // populated — extractStatus should reach for that branch.
      const err = mapSupabaseError(
        Object.assign(new Error("teapot"), { statusCode: 404 })
      );
      expect(err.code).toBe("NotFound");
    });

    test("plain object errors fall through to the default message", () => {
      // Not an Error and no message — exercises the default-message branch
      // on `mapSupabaseError`.
      const err = mapSupabaseError({ status: 500 });
      expect(err.code).toBe("Provider");
      expect(err.message).toBe("Supabase error");
    });

    test("undefined errors fall through to the default message", () => {
      const err = mapSupabaseError();
      expect(err.code).toBe("Provider");
      expect(err.message).toBe("Supabase error");
    });
  });

  describe("metadata helpers", () => {
    test("stream download tolerates a NotFound from info()", async () => {
      // The body is in hand, so a NotFound info lookup (object deleted in
      // between, or a deployment without the info endpoint) degrades to
      // size 0 + octet-stream.
      infoMock.mockImplementationOnce(() =>
        Promise.resolve(fail(404, "NotFound", "gone"))
      );
      const got = await makeAdapter().download("a.txt", { as: "stream" });
      expect(got.size).toBe(0);
      expect(got.type).toBe("application/octet-stream");
      expect(got.metadata).toBeUndefined();
    });

    test("stream download fails when info() fails with anything but NotFound", async () => {
      // Returning the body without its metadata would hand the encryption
      // plugin ciphertext it can't recognise, so the failure surfaces.
      infoMock.mockImplementationOnce(() =>
        Promise.resolve(fail(500, "ServerError", "boom"))
      );
      await expect(
        makeAdapter().download("a.txt", { as: "stream" })
      ).rejects.toMatchObject({ code: "Provider", message: "boom" });
    });

    test("buffer download fails when info() throws", async () => {
      infoMock.mockImplementationOnce(() =>
        Promise.reject(new Error("info not supported"))
      );
      await expect(makeAdapter().download("a.txt")).rejects.toMatchObject({
        code: "Provider",
        message: "info not supported",
      });
    });

    test("the download's own error wins over a failing info()", async () => {
      downloadResolveMock.mockImplementationOnce(() =>
        Promise.resolve(fail(404, "NotFound", "not here"))
      );
      infoMock.mockImplementationOnce(() =>
        Promise.resolve(fail(500, "ServerError", "boom"))
      );
      await expect(makeAdapter().download("a.txt")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("stream download maps an asStream() error response to FilesError", async () => {
      // Drives downloadAsStreamFile's `throw mapSupabaseError(error)` path —
      // the asStream() builder returns a Supabase-shaped error envelope.
      downloadStreamMock.mockImplementationOnce(() =>
        Promise.resolve(fail(404, "NotFound", "stream gone"))
      );
      try {
        await makeAdapter().download("a.txt", { as: "stream" });
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("buffer download with empty Blob.type recovers via info()", async () => {
      // Drives toMs(Date) and stringifyMetadata branches via metadata that
      // arrives as a Date and a non-string value.
      downloadResolveMock.mockImplementationOnce(() =>
        Promise.resolve(ok(new Blob(["hi"], { type: "" })))
      );
      infoMock.mockImplementationOnce(() =>
        Promise.resolve(
          ok({
            contentType: "image/png",
            etag: '"abc"',
            lastModified: new Date(STABLE_LAST_MODIFIED),
            metadata: { count: 5, missing: null, name: "thing" },
            size: 2,
          })
        )
      );
      const got = await makeAdapter().download("a.txt");
      expect(got.type).toBe("image/png");
      expect(got.lastModified).toBe(STABLE_LAST_MODIFIED_MS);
      expect(got.metadata).toEqual({ count: "5", name: "thing" });
    });

    test("buffer download recovers when info() returns numeric lastModified", async () => {
      // toMs `typeof value === "number"` branch.
      downloadResolveMock.mockImplementationOnce(() =>
        Promise.resolve(ok(new Blob(["hi"], { type: "" })))
      );
      infoMock.mockImplementationOnce(() =>
        Promise.resolve(
          ok({
            contentType: "image/png",
            lastModified: 1_700_000_000_000,
            size: 2,
          })
        )
      );
      const got = await makeAdapter().download("a.txt");
      expect(got.lastModified).toBe(1_700_000_000_000);
    });

    test("buffer download with empty Blob.type and absent info() falls back to octet-stream", async () => {
      downloadResolveMock.mockImplementationOnce(() =>
        Promise.resolve(ok(new Blob(["hi"], { type: "" })))
      );
      infoMock.mockImplementationOnce(() =>
        Promise.resolve(fail(400, "404", "Object not found", "NoSuchKey"))
      );
      const got = await makeAdapter().download("a.txt");
      expect(got.type).toBe("application/octet-stream");
      expect(got.lastModified).toBeUndefined();
    });

    test("metadata containing only nullish values is dropped from the StoredFile", async () => {
      downloadResolveMock.mockImplementationOnce(() =>
        Promise.resolve(ok(new Blob(["hi"], { type: "" })))
      );
      infoMock.mockImplementationOnce(() =>
        Promise.resolve(
          ok({
            contentType: "image/png",
            metadata: { gone: null, missing: undefined },
            size: 2,
          })
        )
      );
      const got = await makeAdapter().download("a.txt");
      expect(got.metadata).toBeUndefined();
    });

    test("an existing FilesError passes through unchanged", () => {
      const original = new FilesError("Conflict", "already there", {
        original: true,
      });
      const out = mapSupabaseError(original);
      expect(out).toBe(original);
    });

    test("download error propagates as FilesError", async () => {
      downloadResolveMock.mockImplementationOnce(() =>
        Promise.resolve(fail(404, "NotFound", "not here"))
      );
      try {
        await makeAdapter().download("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("upload error propagates as FilesError", async () => {
      uploadMock.mockImplementationOnce(() =>
        Promise.resolve(fail(403, "Unauthorized", "denied"))
      );
      try {
        await makeAdapter().upload("a.txt", "x");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("Unauthorized");
      }
    });

    test("head error propagates as FilesError", async () => {
      infoMock.mockImplementationOnce(() =>
        Promise.resolve(fail(404, "NotFound", "missing"))
      );
      try {
        await makeAdapter().head("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("delete error propagates as FilesError", async () => {
      removeMock.mockImplementationOnce(() =>
        Promise.resolve(fail(403, "Unauthorized", "denied"))
      );
      try {
        await makeAdapter().delete("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("Unauthorized");
      }
    });

    test("copy error propagates as FilesError", async () => {
      copyMock.mockImplementationOnce(() =>
        Promise.resolve(fail(404, "NotFound", "no source"))
      );
      try {
        await makeAdapter().copy("a.txt", "b.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("list error propagates as FilesError", async () => {
      listV2Mock.mockImplementationOnce(() =>
        Promise.resolve(fail(403, "Unauthorized", "denied"))
      );
      try {
        await makeAdapter().list();
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("Unauthorized");
      }
    });

    test("createSignedUrl error propagates as FilesError", async () => {
      createSignedUrlMock.mockImplementationOnce(() =>
        Promise.resolve(fail(404, "NotFound", "no key"))
      );
      try {
        await makeAdapter().url("a.txt");
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("NotFound");
      }
    });

    test("createSignedUploadUrl error propagates as FilesError", async () => {
      createSignedUploadUrlMock.mockImplementationOnce(() =>
        Promise.resolve(fail(403, "Unauthorized", "denied"))
      );
      try {
        await makeAdapter().signedUploadUrl("a.txt", { expiresIn: 60 });
        throw new Error("should have thrown");
      } catch (error) {
        expect((error as FilesError).code).toBe("Unauthorized");
      }
    });
  });

  describe("signal forwarding", () => {
    test("buffer download forwards the signal as FetchParameters", async () => {
      const { signal } = new AbortController();
      await new Files({ adapter: makeAdapter() }).download("a.txt", { signal });
      // download(path, options, parameters) — parameters is the 3rd arg.
      expect(sigOf(downloadResolveMock, 1)?.signal).toBe(signal);
    });

    test("stream download forwards the signal as FetchParameters", async () => {
      const { signal } = new AbortController();
      await new Files({ adapter: makeAdapter() }).download("a.txt", {
        as: "stream",
        signal,
      });
      expect(sigOf(downloadStreamMock, 0)?.signal).toBe(signal);
    });

    test("list forwards the signal as FetchParameters", async () => {
      const { signal } = new AbortController();
      await new Files({ adapter: makeAdapter() }).list({ signal });
      // listV2(options, parameters) — parameters is the 2nd arg.
      expect(sigOf(listV2Mock, 1)?.signal).toBe(signal);
    });
  });
});

describe("supabase resumable uploads (TUS)", () => {
  const TUS = `${STORAGE_URL}/upload/resumable`;
  const SESSION = `${TUS}/uploads-file`;
  const SIX_MIB = 6 * 1024 * 1024;
  let restoreFetch: () => void;
  afterEach(() => {
    restoreFetch?.();
  });
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

  test("fresh upload creates a session and PATCHes chunks", async () => {
    const offsets: string[] = [];
    installFetch((_url, init) => {
      if (init.method === "POST") {
        return new Response(null, {
          headers: { Location: SESSION },
          status: 201,
        });
      }
      const headers = init.headers as Record<string, string>;
      offsets.push(headers["Upload-Offset"] ?? "");
      const next =
        Number(headers["Upload-Offset"]) +
        ((init.body as Uint8Array)?.byteLength ?? 0);
      return new Response(null, {
        headers: { "Upload-Offset": String(next) },
        status: 204,
      });
    });
    const files = new Files({ adapter: makeAdapter() });
    const control = new UploadControl();
    const result = await files.upload("file", new Uint8Array(SIX_MIB + 10), {
      control,
      multipart: { partSize: SIX_MIB },
    });
    expect(result.size).toBe(SIX_MIB + 10);
    expect(control.status).toBe("completed");
    expect(control.session?.provider).toBe("supabase");
    expect(offsets).toEqual(["0", String(SIX_MIB)]);
  });

  test("the TUS session carries cacheControl (as seconds) and user metadata", async () => {
    let uploadMetadata = "";
    installFetch((_url, init) => {
      const headers = init.headers as Record<string, string>;
      if (init.method === "POST") {
        uploadMetadata = headers["Upload-Metadata"] ?? "";
        return new Response(null, {
          headers: { Location: SESSION },
          status: 201,
        });
      }
      return new Response(null, {
        headers: {
          "Upload-Offset": String(
            Number(headers["Upload-Offset"]) +
              ((init.body as Uint8Array)?.byteLength ?? 0)
          ),
        },
        status: 204,
      });
    });
    const files = new Files({ adapter: makeAdapter() });
    await files.upload("file", "hello", {
      cacheControl: "public, max-age=60",
      control: new UploadControl(),
      metadata: { author: "me" },
    });
    const pairs = Object.fromEntries(
      uploadMetadata.split(",").map((pair) => {
        const [name = "", value = ""] = pair.split(" ");
        return [name, Buffer.from(value, "base64").toString()];
      })
    );
    expect(pairs).toEqual({
      bucketName: BUCKET,
      cacheControl: "60",
      contentType: "text/plain; charset=utf-8",
      metadata: JSON.stringify({ author: "me" }),
      objectName: "file",
    });
  });

  test("an unrepresentable cacheControl rejects before the TUS session opens", async () => {
    const fetchSpy = mock(() => new Response(null, { status: 201 }));
    installFetch(fetchSpy);
    const files = new Files({ adapter: makeAdapter() });
    await expect(
      files.upload("file", "hello", {
        cacheControl: "no-store",
        control: new UploadControl(),
      })
    ).rejects.toThrow(/stores only a max-age/u);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("chunks stay 6 MiB whatever multipart.partSize asks for", async () => {
    // Supabase's TUS endpoint requires exactly 6 MiB chunks.
    const offsets: string[] = [];
    installFetch((_url, init) => {
      if (init.method === "POST") {
        return new Response(null, {
          headers: { Location: SESSION },
          status: 201,
        });
      }
      const headers = init.headers as Record<string, string>;
      offsets.push(headers["Upload-Offset"] ?? "");
      const next =
        Number(headers["Upload-Offset"]) +
        ((init.body as Uint8Array)?.byteLength ?? 0);
      return new Response(null, {
        headers: { "Upload-Offset": String(next) },
        status: 204,
      });
    });
    const files = new Files({ adapter: makeAdapter() });
    await files.upload("file", new Uint8Array(SIX_MIB + 10), {
      control: new UploadControl(),
      multipart: { partSize: 1024 * 1024 },
    });
    expect(offsets).toEqual(["0", String(SIX_MIB)]);
  });

  test("resume reads Upload-Offset via HEAD, then sends the rest", async () => {
    const patched: string[] = [];
    installFetch((_url, init) => {
      if (init.method === "HEAD") {
        return new Response(null, {
          headers: { "Upload-Offset": String(SIX_MIB) },
          status: 200,
        });
      }
      const headers = init.headers as Record<string, string>;
      patched.push(headers["Upload-Offset"] ?? "");
      return new Response(null, {
        headers: { "Upload-Offset": String(SIX_MIB + 10) },
        status: 204,
      });
    });
    const files = new Files({ adapter: makeAdapter() });
    const token: ResumableUploadSession = {
      contentType: "application/octet-stream",
      key: "file",
      provider: "supabase",
      uri: SESSION,
    };
    const result = await files.upload("file", new Uint8Array(SIX_MIB + 10), {
      control: UploadControl.from(token),
      multipart: { partSize: SIX_MIB },
    });
    expect(result.size).toBe(SIX_MIB + 10);
    expect(patched).toEqual([String(SIX_MIB)]);
  });

  test("resuming a cross-origin session uri is rejected", async () => {
    installFetch(() => new Response(null, { status: 204 }));
    const files = new Files({ adapter: makeAdapter() });
    const token: ResumableUploadSession = {
      contentType: "application/octet-stream",
      key: "file",
      provider: "supabase",
      uri: "https://attacker.example/upload",
    };
    await expect(
      files.upload("file", new Uint8Array(SIX_MIB + 10), {
        control: UploadControl.from(token),
        multipart: { partSize: SIX_MIB },
      })
    ).rejects.toThrow(/origin does not match/u);
  });

  test("abort deletes the session", async () => {
    const methods: string[] = [];
    installFetch((_url, init) => {
      methods.push(init.method ?? "GET");
      if (init.method === "POST") {
        return new Response(null, {
          headers: { Location: SESSION },
          status: 201,
        });
      }
      if (init.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      const headers = init.headers as Record<string, string>;
      const next =
        Number(headers["Upload-Offset"]) +
        ((init.body as Uint8Array)?.byteLength ?? 0);
      return new Response(null, {
        headers: { "Upload-Offset": String(next) },
        status: 204,
      });
    });
    const files = new Files({ adapter: makeAdapter() });
    const control = new UploadControl();
    let aborting: Promise<void> | undefined;
    const promise = files.upload("ab", new Uint8Array(SIX_MIB * 2 + 5), {
      control,
      multipart: { partSize: SIX_MIB },
      onProgress: ({ loaded }) => {
        if (loaded >= SIX_MIB && !aborting) {
          aborting = control.abort();
        }
      },
    });
    await expect(promise).rejects.toMatchObject({ aborted: true });
    await aborting;
    expect(methods).toContain("DELETE");
  });

  test("a failed session init throws", async () => {
    installFetch(() => new Response(null, { status: 500 }));
    const files = new Files({ adapter: makeAdapter() });
    await expect(
      files.upload("x", "data", { control: new UploadControl() })
    ).rejects.toThrow(/session init failed/u);
  });

  test("a failed chunk PATCH throws", async () => {
    installFetch((_url, init) =>
      init.method === "POST"
        ? new Response(null, { headers: { Location: SESSION }, status: 201 })
        : new Response(null, { status: 500 })
    );
    const files = new Files({ adapter: makeAdapter() });
    await expect(
      files.upload("x", "data", { control: new UploadControl(), retries: 0 })
    ).rejects.toThrow(/chunk upload failed/u);
  });

  test("a session init rejected with 403 maps to Unauthorized", async () => {
    installFetch(() => new Response(null, { status: 403 }));
    const files = new Files({ adapter: makeAdapter() });
    await expect(
      files.upload("x", "data", { control: new UploadControl() })
    ).rejects.toMatchObject({
      code: "Unauthorized",
      message: "supabase: resumable session init failed (HTTP 403).",
    });
  });

  test("a TUS offset mismatch (409) is a Conflict and isn't re-sent", async () => {
    let patches = 0;
    installFetch((_url, init) => {
      if (init.method === "POST") {
        return new Response(null, {
          headers: { Location: SESSION },
          status: 201,
        });
      }
      patches += 1;
      return new Response(null, { status: 409 });
    });
    const files = new Files({ adapter: makeAdapter() });
    await expect(
      files.upload("x", "data", { control: new UploadControl(), retries: 3 })
    ).rejects.toMatchObject({ code: "Conflict" });
    expect(patches).toBe(1);
  });

  test("the client escape hatch can't do resumable (no url/key)", async () => {
    installFetch(() => new Response(null, { status: 201 }));
    // A pre-built client lets construction succeed, but there's no URL/key to
    // reach the TUS endpoint with — so no resumable driver is attached and
    // `capabilities.resumable` says so.
    const adapter = supabase({
      bucket: BUCKET,
      client: new StorageClientStub(STORAGE_URL, {}) as never,
    });
    expect(adapter.resumableUpload).toBeUndefined();
    const files = new Files({ adapter });
    expect(files.capabilities.resumable).toBe(false);
    await expect(
      files.upload("x", "data", { control: new UploadControl() })
    ).rejects.toMatchObject({
      code: "Unsupported",
      message: expect.stringMatching(/resumable uploads are not supported/u),
    });
  });

  test("url + key credentials attach the resumable driver", () => {
    expect(new Files({ adapter: makeAdapter() }).capabilities.resumable).toBe(
      true
    );
  });

  test("abortUpload cancels the TUS session and checks the DELETE status", async () => {
    const token: ResumableUploadSession = {
      contentType: "application/octet-stream",
      key: "file",
      provider: "supabase",
      uri: SESSION,
    };
    const deletes: string[] = [];
    let status = 204;
    installFetch((url, init) => {
      deletes.push(`${init.method} ${url}`);
      return new Response(null, { status });
    });
    const files = new Files({ adapter: makeAdapter(), retries: 0 });
    await files.abortUpload("file", token);
    expect(deletes).toEqual([`DELETE ${SESSION}`]);
    // Already completed or expired: the session is gone either way.
    status = 404;
    await expect(files.abortUpload("file", token)).resolves.toBeUndefined();
    // A refused or failed cancel leaves the session live, so it rejects.
    status = 403;
    await expect(files.abortUpload("file", token)).rejects.toMatchObject({
      code: "Unauthorized",
      message: expect.stringMatching(/upload session cancel failed/u),
    });
    status = 500;
    await expect(files.abortUpload("file", token)).rejects.toMatchObject({
      code: "Provider",
    });
  });

  test("abortUpload maps a transport failure on the cancel", async () => {
    const original = globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
    globalThis.fetch = (() =>
      Promise.reject(new TypeError("offline"))) as unknown as typeof fetch;
    const files = new Files({ adapter: makeAdapter(), retries: 0 });
    await expect(
      files.abortUpload("file", {
        contentType: "application/octet-stream",
        key: "file",
        provider: "supabase",
        uri: SESSION,
      })
    ).rejects.toMatchObject({ code: "Provider", message: "offline" });
  });

  test("a session response missing Location throws", async () => {
    installFetch(() => new Response(null, { status: 201 }));
    const files = new Files({ adapter: makeAdapter() });
    await expect(
      files.upload("x", "data", { control: new UploadControl() })
    ).rejects.toThrow(/missing Location/u);
  });

  test("a failed resume HEAD throws", async () => {
    installFetch(() => new Response(null, { status: 410 }));
    const files = new Files({ adapter: makeAdapter() });
    const token: ResumableUploadSession = {
      contentType: "application/octet-stream",
      key: "file",
      provider: "supabase",
      uri: SESSION,
    };
    await expect(
      files.upload("file", new Uint8Array(SIX_MIB + 10), {
        control: UploadControl.from(token),
        multipart: { partSize: SIX_MIB },
        retries: 0,
      })
    ).rejects.toMatchObject({
      // An expired or terminated TUS upload (410) is NotFound, so a caller
      // can tell "start over" apart from a transient failure.
      code: "NotFound",
      message: expect.stringMatching(/status check failed/u),
    });
  });

  test("a trailing-slash project url still resolves the TUS endpoint", async () => {
    let posted = "";
    installFetch((url, init) => {
      if (init.method === "POST") {
        posted = url;
        return new Response(null, {
          headers: { Location: SESSION },
          status: 201,
        });
      }
      const headers = init.headers as Record<string, string>;
      return new Response(null, {
        headers: {
          "Upload-Offset": String(
            Number(headers["Upload-Offset"]) +
              ((init.body as Uint8Array)?.byteLength ?? 0)
          ),
        },
        status: 204,
      });
    });
    const files = new Files({
      adapter: makeAdapter({ url: `${PROJECT_URL}/` }),
    });
    await files.upload("file", "hello", { control: new UploadControl() });
    expect(posted).toBe(TUS);
  });

  test("resuming a mismatched key throws", async () => {
    installFetch(() => new Response(null, { status: 201 }));
    const files = new Files({ adapter: makeAdapter() });
    const token: ResumableUploadSession = {
      contentType: "application/octet-stream",
      key: "other",
      provider: "supabase",
      uri: SESSION,
    };
    await expect(
      files.upload("file", "data", { control: UploadControl.from(token) })
    ).rejects.toMatchObject({
      code: "Invalid",
      message: expect.stringMatching(/does not match/u),
    });
  });

  test("resuming a non-supabase token throws", async () => {
    installFetch(() => new Response(null, { status: 201 }));
    const files = new Files({ adapter: makeAdapter() });
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

describe("supabase object info (real storage-js client)", () => {
  interface StoredObject {
    bytes: Uint8Array<ArrayBuffer>;
    metadata?: Record<string, unknown>;
    type: string;
  }

  // A minimal Supabase Storage server behind storage-js's injectable fetch:
  // uploads keep the `x-metadata` user metadata, `/object/info` answers with
  // the server's snake_case body, and downloads serve the stored bytes.
  const fakeServer = () => {
    const objects = new Map<string, StoredObject>();
    const requests: { init: RequestInit; url: string }[] = [];
    const fetchMock = mock(async (input: string, init: RequestInit = {}) => {
      requests.push({ init, url: input });
      const url = new URL(input);
      const method = (init.method ?? "GET").toUpperCase();
      const path = url.pathname.replace("/storage/v1", "");
      const headers = new Headers(init.headers);
      const upload = /^\/object\/uploads\/(?<key>.+)$/u.exec(path);
      if (method === "POST" && upload?.groups?.key) {
        const meta = headers.get("x-metadata");
        objects.set(decodeURIComponent(upload.groups.key), {
          bytes: new Uint8Array(await new Response(init.body).arrayBuffer()),
          type: headers.get("content-type") ?? "",
          ...(meta && { metadata: JSON.parse(atob(meta)) }),
        });
        return Response.json({ Id: "1", Key: `uploads/${upload.groups.key}` });
      }
      const info = /^\/object\/info\/uploads\/(?<key>.+)$/u.exec(path);
      if (info?.groups?.key) {
        const found = objects.get(decodeURIComponent(info.groups.key));
        if (!found) {
          return Response.json(
            {
              error: "not_found",
              message: "Object not found",
              statusCode: "404",
            },
            { status: 400 }
          );
        }
        return Response.json({
          bucket_id: BUCKET,
          cache_control: "max-age=3600",
          content_type: found.type,
          etag: '"etag-raw"',
          last_modified: STABLE_LAST_MODIFIED,
          metadata: found.metadata ?? null,
          size: found.bytes.byteLength,
        });
      }
      const download = /^\/object\/uploads\/(?<key>.+)$/u.exec(path);
      const found =
        download?.groups?.key &&
        objects.get(decodeURIComponent(download.groups.key));
      if (found) {
        return new Response(found.bytes, {
          headers: { "content-type": found.type },
        });
      }
      return Response.json(
        { error: "not_found", message: "Object not found", statusCode: "404" },
        { status: 400 }
      );
    });
    const adapter = supabase({
      bucket: BUCKET,
      client: new RealStorageClient(
        STORAGE_URL,
        { Authorization: `Bearer ${KEY}`, apikey: KEY },
        fetchMock as unknown as typeof fetch
      ),
    });
    return { adapter, fetchMock, objects, requests };
  };

  const META = { fsenc_dek_iv: "abc", user_id: "42", "x-trace": "t" };

  test("user metadata keys round-trip unchanged through head and both download modes", async () => {
    const { adapter } = fakeServer();
    const files = new Files({ adapter });
    await files.upload("a.txt", "hi", { metadata: META });
    const head = await files.head("a.txt");
    expect(head.metadata).toEqual(META);
    expect(head.etag).toBe("etag-raw");
    expect(head.lastModified).toBe(STABLE_LAST_MODIFIED_MS);
    expect(head.size).toBe(2);
    const buffered = await files.download("a.txt");
    expect(buffered.metadata).toEqual(META);
    expect(buffered.etag).toBe("etag-raw");
    expect(buffered.lastModified).toBe(STABLE_LAST_MODIFIED_MS);
    expect(await buffered.text()).toBe("hi");
    const streamed = await files.download("a.txt", { as: "stream" });
    expect(streamed.metadata).toEqual(META);
    expect(streamed.size).toBe(2);
    expect(await drainStream(streamed.stream())).toBe(2);
  });

  test("the encryption plugin round-trips through a real client", async () => {
    const { adapter, objects } = fakeServer();
    const files = new Files({
      adapter,
      plugins: [encryption(await generateEncryptionKey())],
    });
    await files.upload("s.txt", "top secret");
    expect(new TextDecoder().decode(objects.get("s.txt")?.bytes)).not.toBe(
      "top secret"
    );
    const decrypted = await files.download("s.txt");
    expect(await decrypted.text()).toBe("top secret");
  });

  test("the info request uses the client's headers, encodes the key, and forwards the signal", async () => {
    const { adapter, objects, requests } = fakeServer();
    objects.set("dir/a b?.txt", { bytes: new Uint8Array(1), type: "x/y" });
    const { signal } = new AbortController();
    await adapter.head("dir/a b?.txt", { signal });
    const [request] = requests;
    expect(request?.url).toBe(
      `${STORAGE_URL}/object/info/${BUCKET}/dir/a%20b%3F.txt`
    );
    expect(new Headers(request?.init.headers).get("apikey")).toBe(KEY);
    expect(request?.init.signal).toBe(signal);
  });

  test("head maps a non-JSON error body by its HTTP status", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response("denied", { status: 403 }))
    );
    const adapter = supabase({
      bucket: BUCKET,
      client: new RealStorageClient(
        STORAGE_URL,
        { apikey: KEY },
        fetchMock as unknown as typeof fetch
      ),
    });
    await expect(adapter.head("a.txt")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("head maps a 5xx body to a retryable Provider error", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        Response.json(
          { error: "internal", message: "boom", statusCode: "500" },
          { status: 500 }
        )
      )
    );
    const adapter = supabase({
      bucket: BUCKET,
      client: new RealStorageClient(
        STORAGE_URL,
        { apikey: KEY },
        fetchMock as unknown as typeof fetch
      ),
    });
    await expect(adapter.head("a.txt")).rejects.toMatchObject({
      code: "Provider",
      message: "boom",
    });
  });

  test("head maps a transport failure to Provider", async () => {
    const fetchMock = mock(() => Promise.reject(new TypeError("offline")));
    const adapter = supabase({
      bucket: BUCKET,
      client: new RealStorageClient(
        STORAGE_URL,
        { apikey: KEY },
        fetchMock as unknown as typeof fetch
      ),
    });
    await expect(adapter.head("a.txt")).rejects.toMatchObject({
      code: "Provider",
      message: "offline",
    });
  });

  test("a non-object info body yields defaults, and updated_at stands in for last_modified", async () => {
    let body: unknown = null;
    const fetchMock = mock(() => Promise.resolve(Response.json(body)));
    const adapter = supabase({
      bucket: BUCKET,
      client: new RealStorageClient(
        STORAGE_URL,
        { apikey: KEY },
        fetchMock as unknown as typeof fetch
      ),
    });
    expect(await adapter.head("a.txt")).toEqual({
      contentType: "application/octet-stream",
      key: "a.txt",
      size: 0,
    });
    body = { metadata: [], updated_at: 1_700_000_000_000 };
    const head = await adapter.head("a.txt");
    expect(head.lastModified).toBe(1_700_000_000_000);
    expect(head.metadata).toBeUndefined();
  });

  test("a duck-typed bucket client with request internals uses the raw info endpoint", async () => {
    const fetchMock = mock((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({ content_type: "a/b", metadata: { k_v: "1" } })
      )
    );
    const adapter = supabase({
      bucket: BUCKET,
      client: {
        from: () => ({
          ...bucketRef,
          fetch: fetchMock,
          headers: { apikey: KEY, ignored: 1 },
          url: STORAGE_URL,
        }),
      } as never,
    });
    const head = await adapter.head("a.txt");
    expect(head.metadata).toEqual({ k_v: "1" });
    expect(infoMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ apikey: KEY });
  });

  test("a bucket client whose internals have the wrong shape falls back to info()", async () => {
    const adapter = supabase({
      bucket: BUCKET,
      client: {
        from: () => ({ ...bucketRef, fetch: "nope", headers: {}, url: 1 }),
      } as never,
    });
    await adapter.head("a.txt");
    expect(infoMock).toHaveBeenCalledTimes(1);
  });
});

interface DelimStored {
  bytes: Uint8Array<ArrayBuffer>;
  metadata?: Record<string, unknown>;
  type: string;
}

interface DelimRequest {
  body: RequestInit["body"];
  headers: Headers;
  method: string;
  /** Path segments after `/storage/v1/`, each decoded as storage-api does. */
  segments: string[];
  url: URL;
}

const delimToken = (url: string) => `tok.${btoa(encodeURIComponent(url))}`;
const delimTokenUrl = (token: string | null) =>
  token?.startsWith("tok.") ? decodeURIComponent(atob(token.slice(4))) : "";
const delimNotFound = () =>
  Response.json(
    { error: "not_found", message: "Object not found", statusCode: "404" },
    { status: 400 }
  );
const delimServe = (found: DelimStored | undefined) =>
  found
    ? new Response(found.bytes, { headers: { "content-type": found.type } })
    : delimNotFound();
const delimBytes = async (body: RequestInit["body"]) =>
  new Uint8Array(await new Response(body).arrayBuffer());
const delimFetchText = async (
  fetchMock: (input: string, init?: RequestInit) => Promise<Response>,
  url: string
) => {
  const res = await fetchMock(url);
  return res.ok ? await res.text() : `HTTP ${res.status}`;
};
const delimText = (stored: DelimStored | undefined) =>
  new TextDecoder().decode(stored?.bytes);
const delimDuplex = (init: RequestInit | undefined): string | undefined =>
  init && "duplex" in init && typeof init.duplex === "string"
    ? init.duplex
    : undefined;
const delimForm = (init: RequestInit | undefined): FormData => {
  if (!(init?.body instanceof FormData)) {
    throw new TypeError("expected a multipart body");
  }
  return init.body;
};

/**
 * A Storage server that routes and decodes paths the way storage-api does
 * (fastify decodes each `/`-separated segment of the wildcard), so a key that
 * reached it intact is stored and looked up under its real name. Signed
 * tokens bind `${bucket}/${decodedKey}`, as storage-api's do.
 */
class DelimServer {
  readonly objects = new Map<string, DelimStored>();
  private readonly legacySignedUpload: boolean;

  constructor(legacySignedUpload: boolean) {
    this.legacySignedUpload = legacySignedUpload;
  }

  copy(req: DelimRequest): Response {
    const body = JSON.parse(String(req.body));
    const source = this.objects.get(body.sourceKey);
    if (!source) {
      return delimNotFound();
    }
    if (
      this.objects.has(body.destinationKey) &&
      req.headers.get("x-upsert") !== "true"
    ) {
      return Response.json(
        {
          code: "KeyAlreadyExists",
          error: "Duplicate",
          message: "The resource already exists",
          statusCode: "409",
        },
        { status: 400 }
      );
    }
    this.objects.set(body.destinationKey, source);
    return Response.json({ Key: `${BUCKET}/${body.destinationKey}` });
  }

  sign(req: DelimRequest): Response {
    if (req.method === "POST") {
      const { paths } = JSON.parse(String(req.body));
      return Response.json(
        paths.map((path: string) =>
          this.objects.has(path)
            ? {
                error: null,
                path,
                signedURL: `/object/sign/${BUCKET}/${path}?token=${delimToken(`${BUCKET}/${path}`)}`,
              }
            : {
                error:
                  "Either the object does not exist or you do not have access to it",
                path,
                signedURL: null,
              }
        )
      );
    }
    const key = req.segments.slice(3).join("/");
    if (
      delimTokenUrl(req.url.searchParams.get("token")) !== `${BUCKET}/${key}`
    ) {
      return Response.json(
        { error: "InvalidSignature", message: "bad", statusCode: "400" },
        { status: 400 }
      );
    }
    return delimServe(this.objects.get(key));
  }

  async uploadSign(req: DelimRequest): Promise<Response> {
    const key = req.segments.slice(4).join("/");
    if (req.method === "POST") {
      const token = delimToken(`${BUCKET}/${key}`);
      const url = `/object/upload/sign/${BUCKET}/${key}?token=${token}`;
      return Response.json(this.legacySignedUpload ? { url } : { token, url });
    }
    if (
      delimTokenUrl(req.url.searchParams.get("token")) !== `${BUCKET}/${key}`
    ) {
      return Response.json({ message: "bad" }, { status: 400 });
    }
    this.objects.set(key, {
      bytes: await delimBytes(req.body),
      type: req.headers.get("content-type") ?? "",
    });
    return Response.json({ Key: `${BUCKET}/${key}` });
  }

  remove(req: DelimRequest): Response {
    const { prefixes } = JSON.parse(String(req.body));
    for (const prefix of prefixes) {
      this.objects.delete(prefix);
    }
    return Response.json([]);
  }

  info(req: DelimRequest): Response {
    const found = this.objects.get(req.segments.slice(3).join("/"));
    if (!found) {
      return delimNotFound();
    }
    return Response.json({
      content_type: found.type,
      metadata: found.metadata ?? null,
      size: found.bytes.byteLength,
    });
  }

  async upload(req: DelimRequest): Promise<Response> {
    const key = req.segments.slice(2).join("/");
    if (req.body instanceof FormData) {
      const file = req.body.get("");
      const formMeta = req.body.get("metadata");
      if (!(file instanceof Blob)) {
        throw new TypeError("expected a file part");
      }
      this.objects.set(key, {
        bytes: await delimBytes(file),
        type: file.type,
        ...(typeof formMeta === "string" && { metadata: JSON.parse(formMeta) }),
      });
    } else {
      const meta = req.headers.get("x-metadata");
      this.objects.set(key, {
        bytes: await delimBytes(req.body),
        type: req.headers.get("content-type") ?? "",
        ...(meta && { metadata: JSON.parse(atob(meta)) }),
      });
    }
    return Response.json({ Id: "1", Key: `${BUCKET}/${key}` });
  }

  handle(req: DelimRequest): Response | Promise<Response> {
    const [, area] = req.segments;
    if (area === "copy") {
      return this.copy(req);
    }
    if (area === "sign") {
      return this.sign(req);
    }
    if (area === "upload") {
      return this.uploadSign(req);
    }
    if (req.method === "DELETE") {
      return this.remove(req);
    }
    if (area === "info") {
      return this.info(req);
    }
    if (area === "public") {
      return delimServe(this.objects.get(req.segments.slice(3).join("/")));
    }
    if (req.method === "POST") {
      return this.upload(req);
    }
    return delimServe(this.objects.get(req.segments.slice(2).join("/")));
  }
}

describe("supabase keys with URL delimiters (real storage-js client)", () => {
  const SPECIAL_KEYS = [
    "uploads/Invoice #42.pdf",
    "q?x=1.txt",
    "100%.txt",
    "a%41.txt",
    "my file.txt",
    "日本語/ファイル.txt",
    "a+b&c=d,e;f:g@h$.txt",
    "x?token=y.txt",
  ];

  const fakeServer = (opts: { legacySignedUpload?: boolean } = {}) => {
    const server = new DelimServer(opts.legacySignedUpload ?? false);
    const requests: { init: RequestInit; url: string }[] = [];
    const fetchMock = mock((input: string, init: RequestInit = {}) => {
      requests.push({ init, url: input });
      const url = new URL(input);
      return Promise.resolve(
        server.handle({
          body: init.body,
          headers: new Headers(init.headers),
          method: (init.method ?? "GET").toUpperCase(),
          segments: url.pathname
            .replace("/storage/v1/", "")
            .split("/")
            .map(decodeURIComponent),
          url,
        })
      );
    });
    const client = new RealStorageClient(
      STORAGE_URL,
      { Authorization: `Bearer ${KEY}`, apikey: KEY },
      fetchMock as unknown as typeof fetch
    );
    const adapter = supabase({ bucket: BUCKET, client });
    const publicAdapter = supabase({ bucket: BUCKET, client, public: true });
    return {
      adapter,
      fetchMock,
      objects: server.objects,
      publicAdapter,
      requests,
    };
  };

  test.each(SPECIAL_KEYS)(
    "%s round-trips through upload, head, exists, and both download modes",
    async (key) => {
      const { adapter, objects } = fakeServer();
      const files = new Files({ adapter });
      await files.upload(key, `body of ${key}`, { metadata: { k: "v" } });
      expect([...objects.keys()]).toEqual([key]);
      expect(await files.exists(key)).toBe(true);
      const head = await files.head(key);
      expect(head.metadata).toEqual({ k: "v" });
      expect(head.size).toBe(new TextEncoder().encode(`body of ${key}`).length);
      const buffered = await files.download(key);
      expect(await buffered.text()).toBe(`body of ${key}`);
      const streamed = await files.download(key, { as: "stream" });
      expect(await new Response(streamed.stream()).text()).toBe(
        `body of ${key}`
      );
    }
  );

  test("keys that differ only after a # or ? are distinct objects", async () => {
    const { adapter, objects } = fakeServer();
    await adapter.upload("uploads/Invoice #42.pdf", "42");
    await adapter.upload("uploads/Invoice #43.pdf", "43");
    await adapter.upload("q?a=1", "a");
    await adapter.upload("q?a=2", "b");
    expect([...objects.keys()].toSorted()).toEqual([
      "q?a=1",
      "q?a=2",
      "uploads/Invoice #42.pdf",
      "uploads/Invoice #43.pdf",
    ]);
    expect(await adapter.exists("uploads/Invoice ")).toBe(false);
    expect(await adapter.exists("q")).toBe(false);
  });

  test("the key is percent-encoded per segment in the request path", async () => {
    const { adapter, requests } = fakeServer();
    await adapter.upload("dir/a #?%.txt", "x");
    expect(requests[0]?.url).toBe(
      `${STORAGE_URL}/object/${BUCKET}/dir/a%20%23%3F%25.txt`
    );
  });

  test.each(SPECIAL_KEYS)(
    "a signed URL for %s fetches that object",
    async (key) => {
      const { adapter, fetchMock } = fakeServer();
      await adapter.upload(key, "signed body");
      await adapter.upload(key.slice(0, 1), "decoy");
      const url = await adapter.url(key, { expiresIn: 60 });
      expect(await delimFetchText(fetchMock, url)).toBe("signed body");
    }
  );

  test("a signed URL signs the raw key through the batch endpoint and binds the expiry and download name", async () => {
    const { adapter, requests } = fakeServer();
    await adapter.upload("a b.txt", "x");
    const url = await adapter.url("a b.txt", {
      expiresIn: 90,
      responseContentDisposition: 'attachment; filename="r.pdf"',
    });
    const sign = requests.at(-1);
    expect(sign?.url).toBe(`${STORAGE_URL}/object/sign/${BUCKET}`);
    expect(JSON.parse(String(sign?.init.body))).toEqual({
      expiresIn: 90,
      paths: ["a b.txt"],
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/storage/v1/object/sign/${BUCKET}/a%20b.txt`);
    expect(parsed.searchParams.get("download")).toBe("r.pdf");
    const bare = new URL(
      await adapter.url("a b.txt", { responseContentDisposition: "attachment" })
    );
    expect(bare.searchParams.get("download")).toBe("");
  });

  test("signing a missing object is NotFound", async () => {
    const { adapter } = fakeServer();
    await expect(adapter.url("nope?.txt")).rejects.toMatchObject({
      code: "NotFound",
      message: expect.stringMatching(/does not exist/u),
    });
  });

  test("a sign answer with no usable entry is NotFound, and one without a token is a Provider error", async () => {
    let body: unknown = {};
    const fetchMock = mock(() => Promise.resolve(Response.json(body)));
    const adapter = supabase({
      bucket: BUCKET,
      client: new RealStorageClient(
        STORAGE_URL,
        { apikey: KEY },
        fetchMock as unknown as typeof fetch
      ),
    });
    await expect(adapter.url("a.txt")).rejects.toMatchObject({
      code: "NotFound",
      message: "Object not found",
    });
    body = [{ error: null, path: "a.txt", signedURL: "/object/sign/x/a.txt" }];
    await expect(adapter.url("a.txt")).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringMatching(/no token/u),
    });
  });

  test.each(SPECIAL_KEYS)(
    "a public URL for %s fetches that object",
    async (key) => {
      const { publicAdapter, fetchMock } = fakeServer();
      await publicAdapter.upload(key, "public body");
      await publicAdapter.upload(key.slice(0, 1), "decoy");
      const url = await publicAdapter.url(key);
      expect(url.startsWith(`${STORAGE_URL}/object/public/${BUCKET}/`)).toBe(
        true
      );
      expect(await delimFetchText(fetchMock, url)).toBe("public body");
    }
  );

  test.each(SPECIAL_KEYS)(
    "a signed upload URL for %s stores that key",
    async (key) => {
      const { adapter, fetchMock, objects } = fakeServer();
      const signed = await adapter.signedUploadUrl(key, { expiresIn: 60 });
      if (signed.method !== "PUT") {
        throw new Error("expected a PUT signed upload");
      }
      expect(signed.headers).toEqual({ "x-upsert": "true" });
      const res = await fetchMock(signed.url, {
        body: "via signed upload",
        headers: signed.headers,
        method: "PUT",
      });
      expect(res.ok).toBe(true);
      expect(delimText(objects.get(key))).toBe("via signed upload");
    }
  );

  test("a signed upload request asks for upsert, and a server answering only `url` still yields its token", async () => {
    const { adapter, fetchMock, objects, requests } = fakeServer({
      legacySignedUpload: true,
    });
    const signed = await adapter.signedUploadUrl("x?token=y", {
      expiresIn: 60,
    });
    expect(new Headers(requests[0]?.init.headers).get("x-upsert")).toBe("true");
    await fetchMock(signed.url, { body: "z", method: "PUT" });
    expect(objects.has("x?token=y")).toBe(true);
  });

  test("a signed upload answer without a token is a Provider error", async () => {
    let body: unknown = { url: "/object/upload/sign/x/a.txt" };
    const fetchMock = mock(() => Promise.resolve(Response.json(body)));
    const adapter = supabase({
      bucket: BUCKET,
      client: new RealStorageClient(
        STORAGE_URL,
        { apikey: KEY },
        fetchMock as unknown as typeof fetch
      ),
    });
    await expect(
      adapter.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toMatchObject({ code: "Provider" });
    body = [];
    await expect(
      adapter.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toMatchObject({ code: "Provider" });
  });

  test("copy and move replace an existing destination (x-upsert)", async () => {
    const { adapter, objects, requests } = fakeServer();
    const files = new Files({ adapter });
    await files.upload("a #1.txt", "new");
    await files.upload("b?.txt", "old");
    await files.copy("a #1.txt", "b?.txt");
    expect(delimText(objects.get("b?.txt"))).toBe("new");
    const copyRequest = requests.find((r) => r.url.endsWith("/object/copy"));
    expect(new Headers(copyRequest?.init.headers).get("x-upsert")).toBe("true");
    expect(JSON.parse(String(copyRequest?.init.body))).toEqual({
      bucketId: BUCKET,
      destinationKey: "b?.txt",
      sourceKey: "a #1.txt",
    });
    await files.upload("c.txt", "c");
    await files.move("c.txt", "b?.txt");
    expect(delimText(objects.get("b?.txt"))).toBe("c");
    expect(objects.has("c.txt")).toBe(false);
  });

  test("copy forwards the signal and maps a missing source to NotFound", async () => {
    const { adapter, requests } = fakeServer();
    const { signal } = new AbortController();
    await expect(adapter.copy("nope", "b", { signal })).rejects.toMatchObject({
      code: "NotFound",
    });
    expect(requests[0]?.init.signal).toBe(signal);
  });

  test("Blob bodies go multipart with the cache seconds and metadata as form fields", async () => {
    const { adapter, objects, requests } = fakeServer();
    await adapter.upload("b #.bin", new Blob(["blob"], { type: "x/blob" }), {
      cacheControl: "max-age=60",
      metadata: { m: "1" },
    });
    const form = delimForm(requests[0]?.init);
    expect(form.get("cacheControl")).toBe("60");
    expect(new Headers(requests[0]?.init.headers).get("x-upsert")).toBe("true");
    expect(objects.get("b #.bin")).toMatchObject({
      metadata: { m: "1" },
      type: "x/blob",
    });
    await adapter.upload("plain.bin", new Blob(["p"]));
    expect(delimForm(requests.at(-1)?.init).get("cacheControl")).toBe("3600");
    expect(delimForm(requests.at(-1)?.init).has("metadata")).toBe(false);
  });

  test("raw bodies carry cache-control, content-type and x-upsert headers; streams are half-duplex", async () => {
    const { adapter, objects, requests } = fakeServer();
    const { signal } = new AbortController();
    await adapter.upload("s?.txt", new Blob(["streamed"]).stream(), {
      cacheControl: "120",
      contentType: "text/x",
      signal,
    });
    const [request] = requests;
    const headers = new Headers(request?.init.headers);
    expect(headers.get("cache-control")).toBe("max-age=120");
    expect(headers.get("content-type")).toBe("text/x");
    expect(headers.get("x-upsert")).toBe("true");
    expect(headers.get("x-metadata")).toBeNull();
    expect(headers.get("apikey")).toBe(KEY);
    expect(delimDuplex(request?.init)).toBe("half");
    expect(request?.init.signal).toBe(signal);
    expect(delimText(objects.get("s?.txt"))).toBe("streamed");
    await adapter.upload("bytes.bin", new Uint8Array([1, 2]));
    const last = new Headers(requests.at(-1)?.init.headers);
    expect(last.get("cache-control")).toBe("max-age=3600");
    expect(delimDuplex(requests.at(-1)?.init)).toBeUndefined();
  });

  test("an upload key is normalised the way storage-js normalises it", async () => {
    const { adapter, objects } = fakeServer();
    await adapter.upload("/a//b/", "x");
    expect([...objects.keys()]).toEqual(["a/b"]);
  });

  test("upload maps a refused write", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        Response.json(
          {
            error: "InvalidKey",
            message: "Invalid key: a#b",
            statusCode: "400",
          },
          { status: 400 }
        )
      )
    );
    const adapter = supabase({
      bucket: BUCKET,
      client: new RealStorageClient(
        STORAGE_URL,
        { apikey: KEY },
        fetchMock as unknown as typeof fetch
      ),
    });
    await expect(adapter.upload("a#b", "x")).rejects.toMatchObject({
      message: "Invalid key: a#b",
    });
  });

  test("a download answer without a body streams as empty", async () => {
    const fetchMock = mock((input: string) =>
      Promise.resolve(
        input.includes("/object/info/")
          ? Response.json({ size: 0 })
          : new Response(null, { status: 200 })
      )
    );
    const adapter = supabase({
      bucket: BUCKET,
      client: new RealStorageClient(
        STORAGE_URL,
        { apikey: KEY },
        fetchMock as unknown as typeof fetch
      ),
    });
    const file = await adapter.download("e", { as: "stream" });
    expect(await new Response(file.stream()).text()).toBe("");
  });

  test("download and exists forward the signal and map a missing object", async () => {
    const { adapter, requests } = fakeServer();
    const { signal } = new AbortController();
    await expect(adapter.download("gone?", { signal })).rejects.toMatchObject({
      code: "NotFound",
    });
    expect(requests.every((r) => r.init.signal === signal)).toBe(true);
    expect(await adapter.exists("gone?", { signal })).toBe(false);
    expect(requests.at(-1)?.init.signal).toBe(signal);
  });
});
