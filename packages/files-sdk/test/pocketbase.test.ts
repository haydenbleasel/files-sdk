import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Files, FilesError } from "../src/index.js";

const lastArgOf = (m: { mock: { calls: unknown[][] } }, index: number) =>
  m.mock.calls.at(-1)?.[index] as { signal?: AbortSignal } | undefined;

interface StoredEntry {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  recordId: string;
  updated: string;
}

const COLLECTION_ID = "col-files";
const COLLECTION_NAME = "files";

// Backing store mirrors a single PocketBase collection. Key = the
// user-supplied `key` field; value = the simulated record + file body.
const backing = new Map<string, StoredEntry>();
let recordCounter = 0;
const nextRecordId = (): string => {
  recordCounter += 1;
  return `rec-${recordCounter}`;
};

class FakeClientResponseError extends Error {
  override readonly name = "FakeClientResponseError";
  url = "";
  status: number;
  response: Record<string, unknown>;
  isAbort = false;
  originalError: unknown = null;
  constructor({
    status,
    message,
    response,
  }: {
    status: number;
    message?: string;
    response?: Record<string, unknown>;
  }) {
    super(message ?? "ClientResponseError");
    this.status = status;
    this.response = response ?? {};
  }
}

const makeRecord = (
  key: string,
  entry: StoredEntry
): Record<string, unknown> => ({
  collectionId: COLLECTION_ID,
  collectionName: COLLECTION_NAME,
  created: "2024-01-01T00:00:00.000Z",
  file: entry.filename,
  id: entry.recordId,
  key,
  updated: entry.updated,
});

interface SimpleFilter {
  field: string;
  op: "=" | "~";
  value: string;
}

const parseFilter = (filter: string): SimpleFilter | undefined => {
  // The adapter only emits two shapes via `pb.filter`:
  //   key = 'value'
  //   key ~ 'prefix%'
  const m = /^(\w+)\s*([=~])\s*'((?:[^'\\]|\\.)*)'$/u.exec(filter);
  if (!m) {
    return;
  }
  const [, field, op, raw] = m;
  if (!field || !op || raw === undefined) {
    return;
  }
  const value = raw.replaceAll(/\\(.)/gu, "$1");
  return { field, op: op as "=" | "~", value };
};

const findRecord = (key: string): StoredEntry | undefined => backing.get(key);

const getFirstListItemMock = mock((filter: string) => {
  const parsed = parseFilter(filter);
  if (!parsed || parsed.op !== "=") {
    return Promise.reject(
      new FakeClientResponseError({ message: "bad filter", status: 400 })
    );
  }
  const entry = findRecord(parsed.value);
  if (!entry) {
    return Promise.reject(
      new FakeClientResponseError({ message: "not found", status: 404 })
    );
  }
  return Promise.resolve(makeRecord(parsed.value, entry));
});

const getListMock = mock(
  (
    page: number,
    perPage: number,
    opts?: { filter?: string; sort?: string }
  ) => {
    let keys = [...backing.keys()];
    if (opts?.filter) {
      const parsed = parseFilter(opts.filter);
      if (parsed?.op === "~") {
        const prefix = parsed.value.replace(/%$/u, "");
        keys = keys.filter((k) => k.startsWith(prefix));
      } else if (parsed?.op === "=") {
        keys = keys.filter((k) => k === parsed.value);
      }
    }
    keys.sort();
    const totalItems = keys.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
    const start = (page - 1) * perPage;
    const items = keys.slice(start, start + perPage).map((k) => {
      const entry = backing.get(k);
      if (!entry) {
        throw new Error("inconsistent backing store");
      }
      return makeRecord(k, entry);
    });
    return Promise.resolve({ items, page, perPage, totalItems, totalPages });
  }
);

const createMock = mock(async (formData: FormData) => {
  // Find the non-"file" string field; that's the user-configured keyField.
  let key: string | undefined;
  for (const [name, value] of formData.entries()) {
    if (name === "file") {
      continue;
    }
    if (typeof value === "string") {
      key = value;
      break;
    }
  }
  const fileBlob = formData.get("file");
  if (typeof key !== "string") {
    throw new FakeClientResponseError({
      message: "missing key field",
      status: 400,
    });
  }
  if (backing.has(key)) {
    throw new FakeClientResponseError({
      message: "duplicate key",
      status: 409,
    });
  }
  if (!(fileBlob instanceof Blob)) {
    throw new FakeClientResponseError({
      message: "missing file field",
      status: 400,
    });
  }
  const bytes = new Uint8Array(await fileBlob.arrayBuffer());
  const filename =
    fileBlob instanceof File ? fileBlob.name : `${key.split("/").pop()}`;
  const entry: StoredEntry = {
    bytes,
    contentType: fileBlob.type || "application/octet-stream",
    filename,
    recordId: nextRecordId(),
    updated: "2024-01-02T03:04:05.000Z",
  };
  backing.set(key, entry);
  return makeRecord(key, entry);
});

const updateMock = mock(async (id: string, formData: FormData) => {
  // Find by record id
  for (const [key, entry] of backing.entries()) {
    if (entry.recordId !== id) {
      continue;
    }
    const fileBlob = formData.get("file");
    if (fileBlob instanceof Blob) {
      const bytes = new Uint8Array(await fileBlob.arrayBuffer());
      const filename =
        fileBlob instanceof File ? fileBlob.name : entry.filename;
      const updated: StoredEntry = {
        bytes,
        contentType: fileBlob.type || "application/octet-stream",
        filename,
        recordId: entry.recordId,
        updated: "2024-01-03T03:04:05.000Z",
      };
      backing.set(key, updated);
      return makeRecord(key, updated);
    }
    return makeRecord(key, entry);
  }
  throw new FakeClientResponseError({ message: "not found", status: 404 });
});

const deleteMock = mock((id: string) => {
  for (const [key, entry] of backing.entries()) {
    if (entry.recordId === id) {
      backing.delete(key);
      return Promise.resolve(true);
    }
  }
  return Promise.reject(
    new FakeClientResponseError({ message: "not found", status: 404 })
  );
});

const authWithPasswordMock = mock((_email: string, _password: string) =>
  Promise.resolve({
    record: { id: "su-1" },
    token: "mock-admin-token",
  })
);

const getTokenMock = mock(() => Promise.resolve("mock-file-token"));

const getURLMock = mock(
  (
    record: { collectionId?: string; collectionName?: string; id?: string },
    filename: string,
    queryParams?: Record<string, string | number | boolean>
  ) => {
    let url = `http://pb.test/api/files/${record.collectionId ?? record.collectionName ?? ""}/${record.id ?? ""}/${filename}`;
    if (queryParams) {
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(queryParams)) {
        search.set(k, String(v));
      }
      const qs = search.toString();
      if (qs) {
        url += `?${qs}`;
      }
    }
    return url;
  }
);

const filterMock = mock((template: string, params: Record<string, string>) =>
  template.replaceAll(/\{:(\w+)\}/gu, (_, name: string) => {
    const v = params[name] ?? "";
    return `'${v.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`)}'`;
  })
);

// `FakeClientResponseError` above must extend Error for `instanceof` checks;
// FakePocketBase must be `new`-able because the adapter calls
// `new PocketBaseClient(url)`. Both classes are genuinely required.
// oxlint-disable-next-line max-classes-per-file
class FakePocketBase {
  baseURL: string;
  authStore: {
    token: string;
    isValid: boolean;
    save: (token: string, model: unknown) => void;
    clear: () => void;
  };
  files: {
    getURL: typeof getURLMock;
    getToken: typeof getTokenMock;
  };
  // Arrow-function fields rather than class methods so they capture the
  // module-level mocks via closure without triggering `class-methods-use-this`.
  filter: (template: string, params: Record<string, string>) => string;
  collection: (name: string) => {
    authWithPassword: typeof authWithPasswordMock;
    create: typeof createMock;
    delete: typeof deleteMock;
    getFirstListItem: typeof getFirstListItemMock;
    getList: typeof getListMock;
    update: typeof updateMock;
  };
  constructor(baseURL = "http://pb.test") {
    this.baseURL = baseURL;
    let token = "";
    let valid = false;
    this.authStore = {
      clear: () => {
        token = "";
        valid = false;
      },
      get isValid() {
        return valid;
      },
      save: (t: string) => {
        token = t;
        valid = Boolean(t);
      },
      get token() {
        return token;
      },
    };
    this.files = { getToken: getTokenMock, getURL: getURLMock };
    this.filter = (template, params) => filterMock(template, params);
    this.collection = (_name) => ({
      authWithPassword: authWithPasswordMock,
      create: createMock,
      delete: deleteMock,
      getFirstListItem: getFirstListItemMock,
      getList: getListMock,
      update: updateMock,
    });
  }
}

mock.module("pocketbase", () => ({
  ClientResponseError: FakeClientResponseError,
  default: FakePocketBase,
}));

// Stub global fetch — adapter calls fetch(url) for file downloads.
const fetchMock = mock((url: string | URL | Request) => {
  const urlStr = typeof url === "string" ? url : url.toString();
  // Parse /api/files/<collectionId>/<recordId>/<filename>(?token=...)
  const m = /\/api\/files\/[^/]+\/([^/]+)\/([^?]+)/u.exec(urlStr);
  if (!m) {
    return Promise.resolve(new Response("not found", { status: 404 }));
  }
  const [, recordId] = m;
  for (const entry of backing.values()) {
    if (entry.recordId === recordId) {
      return Promise.resolve(
        new Response(entry.bytes as BodyInit, {
          headers: { "Content-Type": entry.contentType },
          status: 200,
        })
      );
    }
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
});

const { pocketbase, mapPocketBaseError } =
  await import("../src/pocketbase/index.js");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  backing.clear();
  recordCounter = 0;
  getFirstListItemMock.mockClear();
  getListMock.mockClear();
  createMock.mockClear();
  updateMock.mockClear();
  deleteMock.mockClear();
  authWithPasswordMock.mockClear();
  getTokenMock.mockClear();
  getURLMock.mockClear();
  filterMock.mockClear();
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  delete process.env.POCKETBASE_URL;
  delete process.env.POCKETBASE_ADMIN_EMAIL;
  delete process.env.POCKETBASE_ADMIN_PASSWORD;
  delete process.env.POCKETBASE_AUTH_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("pocketbase adapter", () => {
  test("missing collection throws at construction", () => {
    expect(() => pocketbase({ collection: "", url: "http://pb.test" })).toThrow(
      /collection/u
    );
  });

  test("missing url and no client throws at construction", () => {
    expect(() => pocketbase({ collection: "files" })).toThrow(/url/u);
  });

  test("constructs from env fallbacks", () => {
    process.env.POCKETBASE_URL = "http://pb.test";
    const adapter = pocketbase({ collection: "files" });
    expect(adapter.name).toBe("pocketbase");
    expect(adapter.collection).toBe("files");
  });

  test("accepts an existing client without instantiating a new one", () => {
    const client = new FakePocketBase("http://pb.test");
    const adapter = pocketbase({
      client: client as unknown as Parameters<typeof pocketbase>[0]["client"],
      collection: "files",
    });
    expect(adapter.raw as unknown as FakePocketBase).toBe(client);
  });

  test("upload creates a new record with key and file fields", async () => {
    const files = new Files({
      adapter: pocketbase({ collection: "files", url: "http://pb.test" }),
    });
    const result = await files.upload("docs/a.txt", "hello", {
      contentType: "text/plain",
    });
    expect(result.key).toBe("docs/a.txt");
    expect(result.size).toBe(5);
    expect(result.contentType).toBe("text/plain");
    expect(createMock).toHaveBeenCalledTimes(1);
    const [createCall] = createMock.mock.calls;
    if (!createCall) {
      throw new Error("expected create to have been called");
    }
    const formData = createCall[0] as FormData;
    expect(formData.get("key")).toBe("docs/a.txt");
    const blob = formData.get("file");
    expect(blob).toBeInstanceOf(Blob);
  });

  test("upload of an existing key issues an update instead of a create", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    createMock.mockClear();
    await adapter.upload("a.txt", "world");
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
    const entry = backing.get("a.txt");
    if (!entry) {
      throw new Error("expected entry");
    }
    expect(new TextDecoder().decode(entry.bytes)).toBe("world");
  });

  test("upload rejects cacheControl", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await expect(
      adapter.upload("a.txt", "hello", { cacheControl: "max-age=60" })
    ).rejects.toThrow(/cacheControl.*not supported/u);
  });

  test("upload rejects non-empty metadata", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await expect(
      adapter.upload("a.txt", "hello", { metadata: { author: "me" } })
    ).rejects.toThrow(/metadata.*not supported/u);
  });

  test("download fetches the file body via the file URL", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello", { contentType: "text/plain" });
    const file = await adapter.download("a.txt");
    expect(await file.text()).toBe("hello");
    expect(file.size).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("download forwards a Range header and reports the slice length", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "0123456789", { contentType: "text/plain" });
    let seenRange: string | null | undefined;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      seenRange = new Headers(init?.headers).get("range");
      return Promise.resolve(
        new Response("234", {
          headers: { "Content-Type": "text/plain" },
          status: 206,
        })
      );
    }) as unknown as typeof fetch;
    const file = await adapter.download("a.txt", {
      range: { end: 4, start: 2 },
    });
    expect(seenRange).toBe("bytes=2-4");
    expect(await file.text()).toBe("234");
    expect(file.size).toBe(3);
  });

  test("download includes a file token when auth store is valid", async () => {
    process.env.POCKETBASE_AUTH_TOKEN = "user-token";
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    fetchMock.mockClear();
    getTokenMock.mockClear();
    await adapter.download("a.txt");
    expect(getTokenMock).toHaveBeenCalledTimes(1);
    const [fetchCall] = fetchMock.mock.calls;
    if (!fetchCall) {
      throw new Error("expected fetch to have been called");
    }
    expect(String(fetchCall[0])).toContain("token=mock-file-token");
  });

  test("download falls back to unsigned URL when token issuance fails", async () => {
    process.env.POCKETBASE_AUTH_TOKEN = "user-token";
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    getTokenMock.mockImplementationOnce(() =>
      Promise.reject(new Error("nope"))
    );
    const file = await adapter.download("a.txt");
    expect(await file.text()).toBe("hello");
  });

  test("head returns metadata only and is lazy on body", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    fetchMock.mockClear();
    const info = await adapter.head("a.txt");
    expect(info.key).toBe("a.txt");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await info.text()).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("exists returns true for present keys and false for missing keys", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    await expect(adapter.exists("a.txt")).resolves.toBe(true);
    await expect(adapter.exists("missing.txt")).resolves.toBe(false);
  });

  test("delete removes the underlying record", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    await adapter.delete("a.txt");
    expect(backing.has("a.txt")).toBe(false);
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  test("delete is idempotent on missing keys", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await expect(adapter.delete("missing.txt")).resolves.toBeUndefined();
  });

  test("copy creates a new record with the same file body", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    await adapter.copy("a.txt", "b.txt");
    expect(backing.has("b.txt")).toBe(true);
    const copied = backing.get("b.txt");
    if (!copied) {
      throw new Error("expected copy");
    }
    expect(new TextDecoder().decode(copied.bytes)).toBe("hello");
  });

  test("list with no prefix returns all items sorted by key", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("b.txt", "b");
    await adapter.upload("a.txt", "a");
    await adapter.upload("c.txt", "c");
    const result = await adapter.list();
    expect(result.items.map((i) => i.key)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("list with prefix filters via the configured key field", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("docs/a.txt", "a");
    await adapter.upload("docs/b.txt", "b");
    await adapter.upload("other.txt", "x");
    const result = await adapter.list({ prefix: "docs/" });
    expect(result.items.map((i) => i.key)).toEqual([
      "docs/a.txt",
      "docs/b.txt",
    ]);
  });

  test("list paginates via cursor when more pages exist", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    for (let i = 0; i < 5; i += 1) {
      await adapter.upload(`f-${i}.txt`, String(i));
    }
    const page1 = await adapter.list({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.cursor).toBe("2");
    const page2 = await adapter.list({ cursor: page1.cursor, limit: 2 });
    expect(page2.items).toHaveLength(2);
    expect(page2.cursor).toBe("3");
    const page3 = await adapter.list({ cursor: page2.cursor, limit: 2 });
    expect(page3.items).toHaveLength(1);
    expect(page3.cursor).toBeUndefined();
  });

  test("url returns the PocketBase file URL when publicBaseUrl is unset", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    const url = await adapter.url("a.txt");
    expect(url).toContain("/api/files/");
    expect(url).toContain("/a.txt");
  });

  test("url returns publicBaseUrl-joined URL when configured", async () => {
    const adapter = pocketbase({
      collection: "files",
      publicBaseUrl: "https://cdn.example.com",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
  });

  test("url throws when responseContentDisposition is requested", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    await expect(
      adapter.url("a.txt", { responseContentDisposition: "attachment" })
    ).rejects.toThrow(/responseContentDisposition.*not supported/u);
  });

  test("signedUploadUrl is not supported", async () => {
    const adapter = pocketbase({
      collection: "files",
      url: "http://pb.test",
    });
    await expect(
      adapter.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toThrow(/signedUploadUrl is not supported/u);
  });

  test("admin auth runs once on first authenticated call", async () => {
    const adapter = pocketbase({
      adminEmail: "admin@test",
      adminPassword: "pw",
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    await adapter.upload("b.txt", "world");
    expect(authWithPasswordMock).toHaveBeenCalledTimes(1);
    expect(authWithPasswordMock).toHaveBeenCalledWith("admin@test", "pw");
  });

  test("explicit authToken wins over admin email/password", async () => {
    const adapter = pocketbase({
      adminEmail: "admin@test",
      adminPassword: "pw",
      authToken: "preissued",
      collection: "files",
      url: "http://pb.test",
    });
    await adapter.upload("a.txt", "hello");
    expect(authWithPasswordMock).not.toHaveBeenCalled();
  });

  test("custom keyField is honored for filters, formdata, and storage", async () => {
    const adapter = pocketbase({
      collection: "files",
      keyField: "path",
      url: "http://pb.test",
    });
    await adapter.upload("docs/a.txt", "hello");
    const [createCall] = createMock.mock.calls;
    if (!createCall) {
      throw new Error("expected create to have been called");
    }
    const formData = createCall[0] as FormData;
    expect(formData.get("path")).toBe("docs/a.txt");
    expect(formData.get("key")).toBeNull();
  });

  describe("error mapping", () => {
    test("404 ClientResponseError maps to NotFound", () => {
      const err = mapPocketBaseError(
        new FakeClientResponseError({ message: "missing", status: 404 })
      );
      expect(err.code).toBe("NotFound");
      expect(err.message).toBe("missing");
    });

    test("403 maps to Unauthorized", () => {
      const err = mapPocketBaseError(
        new FakeClientResponseError({ message: "forbidden", status: 403 })
      );
      expect(err.code).toBe("Unauthorized");
    });

    test("409 maps to Conflict", () => {
      const err = mapPocketBaseError(
        new FakeClientResponseError({ message: "dup", status: 409 })
      );
      expect(err.code).toBe("Conflict");
    });

    test("500 maps to Provider", () => {
      const err = mapPocketBaseError(
        new FakeClientResponseError({ message: "boom", status: 500 })
      );
      expect(err.code).toBe("Provider");
    });

    test("FilesError passthrough is preserved", () => {
      const original = new FilesError("NotFound", "wrapped");
      const err = mapPocketBaseError(original);
      expect(err).toBe(original);
    });

    test("non-ClientResponseError plain Error with status is honored", () => {
      const err = mapPocketBaseError(
        Object.assign(new Error("transport"), { status: 401 })
      );
      expect(err.code).toBe("Unauthorized");
      expect(err.message).toBe("transport");
    });

    test("non-ClientResponseError without status falls through to Provider", () => {
      const err = mapPocketBaseError(new Error("opaque"));
      expect(err.code).toBe("Provider");
      expect(err.message).toBe("opaque");
    });
  });

  describe("error paths and edge cases", () => {
    test("upload rejects unsupported Body types", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      await expect(
        adapter.upload(
          "a.txt",
          // A symbol is not a supported Body shape.
          Symbol("nope") as unknown as Parameters<typeof adapter.upload>[1]
        )
      ).rejects.toThrow(/Unsupported body type/u);
    });

    test("download propagates a non-OK fetch as a Provider error", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      await adapter.upload("a.txt", "hello");
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(new Response("server error", { status: 500 }))
      );
      await expect(adapter.download("a.txt")).rejects.toMatchObject({
        code: "Provider",
      });
    });

    test("download propagates a 404 fetch as NotFound", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      await adapter.upload("a.txt", "hello");
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(new Response("missing", { status: 404 }))
      );
      await expect(adapter.download("a.txt")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("download throws Provider when the record has no file in fileField", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      // Inject a record whose `file` field is empty so filenameOf() throws.
      backing.set("ghost.txt", {
        bytes: new Uint8Array(),
        contentType: "application/octet-stream",
        filename: "",
        recordId: nextRecordId(),
        updated: "2024-01-01T00:00:00.000Z",
      });
      await expect(adapter.download("ghost.txt")).rejects.toThrow(
        /has no file in field/u
      );
    });

    test("upload rethrows non-NotFound errors from the dedupe probe", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      getFirstListItemMock.mockImplementationOnce(() =>
        Promise.reject(
          new FakeClientResponseError({ message: "boom", status: 500 })
        )
      );
      await expect(adapter.upload("a.txt", "hello")).rejects.toMatchObject({
        code: "Provider",
      });
    });

    test("upload wraps create() errors", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      createMock.mockImplementationOnce(() =>
        Promise.reject(
          new FakeClientResponseError({ message: "duplicate", status: 409 })
        )
      );
      await expect(adapter.upload("a.txt", "hello")).rejects.toMatchObject({
        code: "Conflict",
      });
    });

    test("delete rethrows non-NotFound errors", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      await adapter.upload("a.txt", "hello");
      deleteMock.mockImplementationOnce(() =>
        Promise.reject(
          new FakeClientResponseError({ message: "forbidden", status: 403 })
        )
      );
      await expect(adapter.delete("a.txt")).rejects.toMatchObject({
        code: "Unauthorized",
      });
    });

    test("head wraps lookup errors", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      getFirstListItemMock.mockImplementationOnce(() =>
        Promise.reject(
          new FakeClientResponseError({ message: "boom", status: 500 })
        )
      );
      await expect(adapter.head("a.txt")).rejects.toMatchObject({
        code: "Provider",
      });
    });

    test("list throws on a non-numeric cursor", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      await expect(adapter.list({ cursor: "not-a-number" })).rejects.toThrow(
        /invalid list cursor/u
      );
    });

    test("list throws on a negative cursor", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      await expect(adapter.list({ cursor: "-1" })).rejects.toThrow(
        /invalid list cursor/u
      );
    });

    test("list wraps underlying getList errors", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      getListMock.mockImplementationOnce(() =>
        Promise.reject(
          new FakeClientResponseError({ message: "boom", status: 500 })
        )
      );
      await expect(adapter.list()).rejects.toMatchObject({
        code: "Provider",
      });
    });

    test("url() falls back to unsigned when getToken fails for authenticated client", async () => {
      process.env.POCKETBASE_AUTH_TOKEN = "user-token";
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      await adapter.upload("a.txt", "hello");
      getTokenMock.mockImplementationOnce(() =>
        Promise.reject(new Error("nope"))
      );
      const url = await adapter.url("a.txt");
      expect(url).toContain("/api/files/");
      expect(url).not.toContain("token=");
    });

    test("url() includes a file token when auth store is valid", async () => {
      process.env.POCKETBASE_AUTH_TOKEN = "user-token";
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      await adapter.upload("a.txt", "hello");
      getTokenMock.mockClear();
      const url = await adapter.url("a.txt");
      expect(getTokenMock).toHaveBeenCalledTimes(1);
      expect(url).toContain("token=mock-file-token");
    });

    test("url() wraps lookup errors", async () => {
      const adapter = pocketbase({
        collection: "files",
        url: "http://pb.test",
      });
      getFirstListItemMock.mockImplementationOnce(() =>
        Promise.reject(
          new FakeClientResponseError({ message: "boom", status: 500 })
        )
      );
      await expect(adapter.url("a.txt")).rejects.toMatchObject({
        code: "Provider",
      });
    });

    test("publicBaseUrl tolerates a trailing slash", async () => {
      const adapter = pocketbase({
        collection: "files",
        publicBaseUrl: "https://cdn.example.com/",
        url: "http://pb.test",
      });
      await adapter.upload("a.txt", "hello");
      expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
    });

    test("auth promise resets after a failed admin login so a retry can succeed", async () => {
      const adapter = pocketbase({
        adminEmail: "admin@test",
        adminPassword: "pw",
        collection: "files",
        url: "http://pb.test",
      });
      authWithPasswordMock.mockImplementationOnce(() =>
        Promise.reject(new Error("bad password"))
      );
      await expect(adapter.upload("a.txt", "hello")).rejects.toThrow(
        /bad password/u
      );
      // The next call should retry authentication rather than reusing
      // the rejected promise.
      await adapter.upload("b.txt", "world");
      expect(authWithPasswordMock).toHaveBeenCalledTimes(2);
      expect(backing.has("b.txt")).toBe(true);
    });
  });

  describe("signal forwarding", () => {
    const makeFiles = () =>
      new Files({
        adapter: pocketbase({ collection: "files", url: "http://pb.test" }),
      });

    test("upload forwards the signal to create", async () => {
      const { signal } = new AbortController();
      await makeFiles().upload("a.txt", "hello", { signal });
      expect(lastArgOf(createMock, 1)?.signal).toBe(signal);
    });

    test("upload forwards the signal to update on an existing key", async () => {
      const files = makeFiles();
      await files.upload("a.txt", "hello");
      const { signal } = new AbortController();
      await files.upload("a.txt", "world", { signal });
      expect(lastArgOf(updateMock, 2)?.signal).toBe(signal);
    });

    test("download forwards the signal to getFirstListItem and fetch", async () => {
      const files = makeFiles();
      await files.upload("a.txt", "hello");
      const { signal } = new AbortController();
      await files.download("a.txt", { signal });
      expect(lastArgOf(getFirstListItemMock, 1)?.signal).toBe(signal);
      expect(lastArgOf(fetchMock, 1)?.signal).toBe(signal);
    });

    test("head forwards the signal to getFirstListItem", async () => {
      const files = makeFiles();
      await files.upload("a.txt", "hello");
      const { signal } = new AbortController();
      await files.head("a.txt", { signal });
      expect(lastArgOf(getFirstListItemMock, 1)?.signal).toBe(signal);
    });

    test("delete forwards the signal to delete", async () => {
      const files = makeFiles();
      await files.upload("a.txt", "hello");
      const { signal } = new AbortController();
      await files.delete("a.txt", { signal });
      expect(lastArgOf(deleteMock, 1)?.signal).toBe(signal);
    });

    test("copy forwards the signal to create and the download fetch", async () => {
      const files = makeFiles();
      await files.upload("a.txt", "hello");
      const { signal } = new AbortController();
      await files.copy("a.txt", "b.txt", { signal });
      expect(lastArgOf(createMock, 1)?.signal).toBe(signal);
      expect(lastArgOf(fetchMock, 1)?.signal).toBe(signal);
    });

    test("list forwards the signal to getList", async () => {
      const { signal } = new AbortController();
      await makeFiles().list({ signal });
      expect(lastArgOf(getListMock, 2)?.signal).toBe(signal);
    });
  });
});
