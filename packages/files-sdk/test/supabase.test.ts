import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Files, FilesError, UploadControl } from "../src/index.js";
import type { ResumableUploadSession } from "../src/index.js";

const sigOf = (m: { mock: { calls: unknown[][] } }, index: number) =>
  m.mock.calls.at(-1)?.[index] as { signal?: AbortSignal } | undefined;

const STABLE_LAST_MODIFIED = "2024-01-02T03:04:05.000Z";
const STABLE_LAST_MODIFIED_MS = new Date(STABLE_LAST_MODIFIED).getTime();
const PROJECT_URL = "https://abc.supabase.co";
const STORAGE_URL = `${PROJECT_URL}/storage/v1`;
const KEY = "service-role-key";
const BUCKET = "uploads";

type SupaErr = Error & {
  name: string;
  status: number;
  statusCode: string;
};
type SupaResult<T> = { data: T; error: null } | { data: null; error: SupaErr };

const ok = <T>(data: T): SupaResult<T> => ({ data, error: null });
const fail = (
  status: number,
  statusCode: string,
  message: string
): SupaResult<never> => ({
  data: null,
  error: Object.assign(new Error(message), {
    name: "StorageApiError",
    status,
    statusCode,
  }),
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
const infoMock = mock(
  (_path: string): Promise<SupaResult<SupaInfo>> =>
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
      expect(o.cacheControl).toBe("public, max-age=60");
      expect(o.metadata).toEqual({ author: "me" });
      expect(o.upsert).toBe(true);
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
      expect(info.type).toBe("text/plain");
      expect(info.etag).toBe("etag-a");
      expect(info.lastModified).toBe(STABLE_LAST_MODIFIED_MS);
      expect(downloadResolveMock).not.toHaveBeenCalled();
    });

    test("body is lazy — text() triggers a download", async () => {
      const info = await makeAdapter().head("a.txt");
      downloadResolveMock.mockClear();
      expect(await info.text()).toBe("hello");
      expect(downloadResolveMock).toHaveBeenCalledTimes(1);
    });

    test("exists returns true for present keys and false for missing keys", async () => {
      const files = new Files({ adapter: makeAdapter() });
      await expect(files.exists("a.txt")).resolves.toBe(true);

      infoMock.mockImplementationOnce(() =>
        Promise.resolve(fail(404, "NotFound", "missing"))
      );
      await expect(files.exists("missing.txt")).resolves.toBe(false);
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
      expect(result).toEqual({ deleted: ["a.txt", "b.txt"] });
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
      expect(result).toEqual({ deleted: [] });
      expect(removeMock).not.toHaveBeenCalled();
    });

    test("deleteMany maps a batch-level remove() error onto every key", async () => {
      removeMock.mockImplementationOnce(() =>
        Promise.resolve(fail(403, "Unauthorized", "denied"))
      );
      const files = new Files({ adapter: makeAdapter() });
      const result = await files.delete(["a.txt", "b.txt"]);
      expect(result.deleted).toEqual([]);
      expect(result.errors?.map((e) => e.key)).toEqual(["a.txt", "b.txt"]);
      for (const entry of result.errors ?? []) {
        expect(entry.error).toBeInstanceOf(FilesError);
        expect(entry.error.code).toBe("Unauthorized");
      }
    });

    test("deleteMany with stopOnError removes one key at a time and stops at the first failure", async () => {
      // stopOnError takes the per-key fallback path (one remove() per key)
      // rather than the single batched remove().
      removeMock
        .mockImplementationOnce(() => Promise.resolve(ok([])))
        .mockImplementationOnce(() =>
          Promise.resolve(fail(404, "NotFound", "gone"))
        );
      const files = new Files({ adapter: makeAdapter() });
      const result = await files.delete(["a.txt", "b.txt", "c.txt"], {
        stopOnError: true,
      });
      expect(result.deleted).toEqual(["a.txt"]);
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
      ).rejects.toMatchObject({ code: "Provider" });
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

    test("items expose lazy bodies that fetch via download()", async () => {
      const out = await makeAdapter().list();
      const [item] = out.items;
      if (!item) {
        throw new Error("expected at least one item");
      }
      downloadResolveMock.mockClear();
      expect(await item.text()).toBe("hello");
      expect(downloadResolveMock).toHaveBeenCalledTimes(1);
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
      ).rejects.toThrow(/only force an attachment/u);
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

    test("includes Content-Type header when contentType passed", async () => {
      const out = await makeAdapter().signedUploadUrl("a.png", {
        contentType: "image/png",
        expiresIn: 60,
      });
      if (out.method !== "PUT") {
        throw new Error("expected PUT");
      }
      expect(out.headers?.["Content-Type"]).toBe("image/png");
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
    test("stream download tolerates info() returning an error", async () => {
      // safeInfo's `if (error || !data) return undefined` branch — the
      // stream path falls back to size 0 + octet-stream when info errors.
      infoMock.mockImplementationOnce(() =>
        Promise.resolve(fail(500, "ServerError", "boom"))
      );
      const got = await makeAdapter().download("a.txt", { as: "stream" });
      expect(got.size).toBe(0);
      expect(got.type).toBe("application/octet-stream");
    });

    test("stream download tolerates info() throwing", async () => {
      // safeInfo's catch swallows thrown errors (older Supabase deployments
      // don't expose info()). The stream path should still resolve.
      infoMock.mockImplementationOnce(() =>
        Promise.reject(new Error("info not supported"))
      );
      const got = await makeAdapter().download("a.txt", { as: "stream" });
      expect(got.size).toBe(0);
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
        Promise.resolve(fail(500, "ServerError", "boom"))
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

    test("head's lazy body propagates download errors as FilesError", async () => {
      // Drives `downloadAsBytes`'s `throw mapSupabaseError(error)` path.
      const info = await makeAdapter().head("a.txt");
      downloadResolveMock.mockImplementationOnce(() =>
        Promise.resolve(fail(404, "NotFound", "vanished"))
      );
      try {
        await info.text();
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(FilesError);
        expect((error as FilesError).code).toBe("NotFound");
      }
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

  test("the client escape hatch can't do resumable (no url/key)", async () => {
    installFetch(() => new Response(null, { status: 201 }));
    // A pre-built client lets construction succeed, but there's no URL/key to
    // reach the TUS endpoint with — so resumable must reject.
    const files = new Files({
      adapter: supabase({
        bucket: BUCKET,
        client: new StorageClientStub(STORAGE_URL, {}) as never,
      }),
    });
    await expect(
      files.upload("x", "data", { control: new UploadControl() })
    ).rejects.toThrow(/require `url` \+ `key`/u);
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
    ).rejects.toThrow(/status check failed/u);
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
    ).rejects.toThrow(/does not match/u);
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
