import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";

import { convex } from "../src/convex/index.js";
import type { ConvexAdapterOptions, ConvexCtx } from "../src/convex/index.js";
import { Files } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";

// --- Type-level guarantee --------------------------------------------------
//
// A real Convex function context must be structurally assignable to the
// adapter's `ctx` option. These identity functions only type-check (under
// `bun run types`); if Convex changes its context shape incompatibly, this
// breaks the build rather than silently shipping a broken adapter.
const acceptsActionCtx = (c: GenericActionCtx<GenericDataModel>): ConvexCtx =>
  c;
const acceptsMutationCtx = (
  c: GenericMutationCtx<GenericDataModel>
): ConvexCtx => c;
const acceptsQueryCtx = (c: GenericQueryCtx<GenericDataModel>): ConvexCtx => c;

// --- In-memory fake of Convex's storage + system table --------------------
//
// Mirrors how Convex gates capabilities by function context: actions expose
// store/get (and the writer + reader methods); mutations expose the writer +
// reader methods plus ctx.db; queries expose only the reader methods plus
// ctx.db. We build the three context shapes from one shared backend.

interface Entry {
  bytes: Uint8Array;
  contentType?: string;
  sha256: string;
  creationTime: number;
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const makeBackend = () => {
  const store = new Map<string, Entry>();
  let counter = 0;
  let clock = 1_700_000_000_000;

  const put = (bytes: Uint8Array, contentType?: string): string => {
    const id = `kg${counter.toString().padStart(6, "0")}`;
    counter += 1;
    const creationTime = clock;
    clock += 1;
    store.set(id, {
      bytes,
      contentType,
      creationTime,
      sha256: sha256Hex(bytes),
    });
    return id;
  };

  const docOf = (id: string) => {
    const e = store.get(id);
    if (!e) {
      return null;
    }
    return {
      _creationTime: e.creationTime,
      _id: id,
      sha256: e.sha256,
      size: e.bytes.byteLength,
      ...(e.contentType ? { contentType: e.contentType } : {}),
    };
  };

  const reader = {
    getMetadata: (id: string) => {
      const e = store.get(id);
      return Promise.resolve(
        e
          ? {
              contentType: e.contentType ?? null,
              sha256: e.sha256,
              size: e.bytes.byteLength,
            }
          : null
      );
    },
    getUrl: (id: string) =>
      Promise.resolve(
        store.has(id) ? `https://fake.convex.cloud/api/storage/${id}` : null
      ),
  };

  const writer = {
    delete: (id: string) => {
      if (!store.has(id)) {
        return Promise.reject(new Error("storage id not found"));
      }
      store.delete(id);
      return Promise.resolve();
    },
    generateUploadUrl: () =>
      Promise.resolve(`https://fake.convex.cloud/upload?token=${counter}`),
  };

  const action = {
    get: (id: string) => {
      const e = store.get(id);
      return Promise.resolve(
        e
          ? new Blob(
              [e.bytes as BlobPart],
              e.contentType ? { type: e.contentType } : {}
            )
          : null
      );
    },
    store: (blob: Blob) =>
      blob
        .arrayBuffer()
        .then((ab) => put(new Uint8Array(ab), blob.type || undefined)),
  };

  const system = {
    get: (_table: "_storage", id: string) => Promise.resolve(docOf(id)),
    query: (_table: "_storage") => ({
      paginate: ({
        cursor,
        numItems,
      }: {
        numItems: number;
        cursor: string | null;
      }) => {
        const ids = [...store.keys()];
        const start = cursor ? Number(cursor) : 0;
        const slice = ids.slice(start, start + numItems);
        const next = start + slice.length;
        return Promise.resolve({
          continueCursor: String(next),
          isDone: next >= ids.length,
          page: slice.map(
            (id) => docOf(id) as NonNullable<ReturnType<typeof docOf>>
          ),
        });
      },
    }),
  };

  return {
    actionCtx: { storage: { ...reader, ...writer, ...action } },
    mutationCtx: { db: { system }, storage: { ...reader, ...writer } },
    put,
    queryCtx: { db: { system }, storage: { ...reader } },
    store,
  };
};

describe("convex adapter", () => {
  describe("construction", () => {
    test("throws without a ctx", () => {
      expect(() => convex({} as ConvexAdapterOptions)).toThrow(
        /`ctx` is required/u
      );
    });

    test("exposes name and ctx as raw", () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      expect(adapter.name).toBe("convex");
      expect(adapter.raw).toBe(actionCtx);
    });
  });

  describe("upload + download (action context)", () => {
    test("upload returns the Convex-assigned id as the key", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      const result = await adapter.upload("ignored-key", "hello world");
      expect(result.key).toMatch(/^kg\d+$/u);
      expect(result.key).not.toBe("ignored-key");
      expect(result.size).toBe("hello world".length);
      expect(result.contentType).toBe("text/plain; charset=utf-8");
      expect(result.etag).toBe(
        sha256Hex(new TextEncoder().encode("hello world"))
      );
    });

    test("round-trips text, bytes, Blob, and stream bodies", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });

      const text = await adapter.upload("k", "plain text");
      const textDown = await adapter.download(text.key);
      expect(await textDown.text()).toBe("plain text");

      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const u8 = await adapter.upload("k", bytes);
      const u8Down = await adapter.download(u8.key);
      const back = new Uint8Array(await u8Down.arrayBuffer());
      expect([...back]).toEqual([...bytes]);

      const blobUp = await adapter.upload(
        "k",
        new Blob(["blobby"], { type: "text/html" })
      );
      const blobDown = await adapter.download(blobUp.key);
      // Bun's Blob appends `;charset=utf-8` to text MIME types; Convex's
      // runtime stores it verbatim. Assert the base type, not the charset.
      expect(blobDown.type).toContain("text/html");
      expect(await blobDown.text()).toBe("blobby");

      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("streamed"));
          c.close();
        },
      });
      const streamUp = await adapter.upload("k", stream);
      const streamDown = await adapter.download(streamUp.key);
      expect(await streamDown.text()).toBe("streamed");
    });

    test("explicit contentType wins", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      const up = await adapter.upload("k", "x", {
        contentType: "application/json",
      });
      const jsonDown = await adapter.download(up.key);
      expect(up.contentType).toContain("application/json");
      expect(jsonDown.type).toContain("application/json");
    });

    test("download throws NotFound for a missing id", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      await expect(adapter.download("kg999999")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("rejects unsupported metadata and cacheControl", async () => {
      const { actionCtx } = makeBackend();
      // The Files wrapper gates centrally on supportsMetadata/supportsCacheControl,
      // which this adapter leaves unset.
      const files = new Files({ adapter: convex({ ctx: actionCtx }) });
      await expect(
        files.upload("k", "x", { metadata: { a: "b" } })
      ).rejects.toMatchObject({ code: "Provider" });
      await expect(
        files.upload("k", "x", { cacheControl: "max-age=60" })
      ).rejects.toMatchObject({ code: "Provider" });
    });
  });

  describe("context gating", () => {
    test("upload/download require an action context", async () => {
      const { mutationCtx } = makeBackend();
      const adapter = convex({ ctx: mutationCtx });
      await expect(adapter.upload("k", "x")).rejects.toMatchObject({
        code: "Provider",
      });
      await expect(adapter.download("kg000000")).rejects.toThrow(
        /requires an action context/u
      );
    });

    test("list requires a query/mutation context (ctx.db)", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      await expect(adapter.list()).rejects.toThrow(
        /requires a query or mutation/u
      );
    });

    test("signedUploadUrl requires a writer context", async () => {
      const { queryCtx } = makeBackend();
      const adapter = convex({ ctx: queryCtx });
      await expect(
        adapter.signedUploadUrl("k", { expiresIn: 60 })
      ).rejects.toMatchObject({ code: "Provider" });
    });
  });

  describe("head / exists / delete", () => {
    test("head returns metadata; body is lazy", async () => {
      const backend = makeBackend();
      const adapter = convex({ ctx: backend.actionCtx });
      const { key } = await adapter.upload("k", "head me");
      const file = await adapter.head(key);
      expect(file.size).toBe("head me".length);
      expect(file.key).toBe(key);
      expect(file.etag).toBeDefined();
      expect(await file.text()).toBe("head me");
    });

    test("head metadata from a query context carries lastModified", async () => {
      const backend = makeBackend();
      const id = backend.put(new TextEncoder().encode("abc"), "text/plain");
      const adapter = convex({ ctx: backend.queryCtx });
      const file = await adapter.head(id);
      expect(file.size).toBe(3);
      expect(file.lastModified).toBeGreaterThan(0);
      // No action context, so reading the body throws.
      await expect(file.arrayBuffer()).rejects.toThrow(/action context/u);
    });

    test("head throws NotFound for a missing id", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      await expect(adapter.head("kg999999")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("exists reflects presence", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      const { key } = await adapter.upload("k", "here");
      expect(await adapter.exists(key)).toBe(true);
      expect(await adapter.exists("kg999999")).toBe(false);
    });

    test("delete removes and is idempotent on missing ids", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      const { key } = await adapter.upload("k", "bye");
      await adapter.delete(key);
      expect(await adapter.exists(key)).toBe(false);
      await expect(adapter.delete(key)).resolves.toBeUndefined();
    });
  });

  describe("url", () => {
    test("returns the Convex serving URL", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      const { key } = await adapter.upload("k", "x");
      expect(await adapter.url(key)).toBe(
        `https://fake.convex.cloud/api/storage/${key}`
      );
    });

    test("missing id throws NotFound", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      await expect(adapter.url("kg999999")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("responseContentDisposition is rejected", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      const { key } = await adapter.upload("k", "x");
      await expect(
        adapter.url(key, { responseContentDisposition: "attachment" })
      ).rejects.toMatchObject({ code: "Provider" });
    });
  });

  describe("signedUploadUrl", () => {
    test("throws because Convex upload URLs cannot bind SDK keys or limits", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      await expect(
        adapter.signedUploadUrl("k", { expiresIn: 60 })
      ).rejects.toThrow(/not supported.*key.*maxSize/u);
    });
  });

  describe("copy", () => {
    test("is unsupported", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      await expect(adapter.copy("a", "b")).rejects.toThrow(/not supported/u);
    });
  });

  describe("list (query context)", () => {
    test("lists stored files keyed by storage id, paginating via cursor", async () => {
      const backend = makeBackend();
      const ids = [
        backend.put(new TextEncoder().encode("one")),
        backend.put(new TextEncoder().encode("two")),
        backend.put(new TextEncoder().encode("three")),
      ];
      const adapter = convex({ ctx: backend.queryCtx });

      const first = await adapter.list({ limit: 2 });
      expect(first.items.map((i) => i.key)).toEqual(ids.slice(0, 2));
      expect(first.cursor).toBeDefined();

      const second = await adapter.list({ cursor: first.cursor, limit: 2 });
      expect(second.items.map((i) => i.key)).toEqual(ids.slice(2));
      expect(second.cursor).toBeUndefined();

      // List items carry metadata from the system table.
      expect(first.items[0]?.size).toBe(3);
      expect(first.items[0]?.etag).toBeDefined();
    });

    test("a listed item's body is lazy and needs an action context to read", async () => {
      const backend = makeBackend();
      backend.put(new TextEncoder().encode("payload"), "text/plain");
      // Listed from a query context (no ctx.storage.get), so reading the lazy
      // body throws — exercising the list item's factory.
      const queryAdapter = convex({ ctx: backend.queryCtx });
      const fromQuery = await queryAdapter.list();
      await expect(fromQuery.items[0]?.text()).rejects.toThrow(
        /action context/u
      );

      // The same id, listed from a mutation context that also wires
      // ctx.storage.get, resolves the lazy body to the stored bytes.
      const actionable: ConvexCtx = {
        db: backend.mutationCtx.db,
        storage: {
          ...backend.mutationCtx.storage,
          get: backend.actionCtx.storage.get,
        },
      };
      const actionableAdapter = convex({ ctx: actionable });
      const fromActionable = await actionableAdapter.list();
      expect(await fromActionable.items[0]?.text()).toBe("payload");
    });
  });

  describe("Files integration", () => {
    test("upload + download through the Files wrapper", async () => {
      const { actionCtx } = makeBackend();
      const files = new Files({ adapter: convex({ ctx: actionCtx }) });
      const { key } = await files.upload("whatever", "via Files");
      const downloaded = await files.download(key);
      expect(await downloaded.text()).toBe("via Files");
      expect(files.raw).toBe(actionCtx);
    });
  });

  describe("error mapping", () => {
    test("a thrown FilesError passes through unchanged (Provider stays Provider)", async () => {
      const sentinel = new FilesError("Provider", "boom from getUrl");
      const ctx: ConvexCtx = {
        storage: {
          getUrl: () => Promise.reject(sentinel),
        },
      };
      const adapter = convex({ ctx });
      // exists() routes the thrown error through mapConvexError; a FilesError
      // is returned as-is, and a non-NotFound code re-throws.
      await expect(adapter.exists("kg000000")).rejects.toBe(sentinel);
    });

    test("a not-found-phrased provider error becomes NotFound", async () => {
      const ctx: ConvexCtx = {
        storage: {
          getUrl: () => Promise.reject(new Error("storage id does not exist")),
        },
      };
      const adapter = convex({ ctx });
      // exists() maps NotFound to false rather than throwing.
      expect(await adapter.exists("kg000000")).toBe(false);
    });

    test("a generic provider error stays Provider", async () => {
      const ctx: ConvexCtx = {
        storage: {
          getUrl: () => Promise.reject(new Error("network exploded")),
        },
      };
      const adapter = convex({ ctx });
      await expect(adapter.url("kg000000")).rejects.toMatchObject({
        code: "Provider",
        message: "network exploded",
      });
    });

    test("exists rethrows a non-NotFound provider failure", async () => {
      const ctx: ConvexCtx = {
        storage: {
          getUrl: () => Promise.reject(new Error("permission denied")),
        },
      };
      const adapter = convex({ ctx });
      await expect(adapter.exists("kg000000")).rejects.toMatchObject({
        code: "Provider",
        message: "permission denied",
      });
    });
  });

  describe("readMeta edge cases", () => {
    test("readMeta returns undefined for a missing doc in a db context", async () => {
      const { queryCtx } = makeBackend();
      const adapter = convex({ ctx: queryCtx });
      // No matching system row, but getUrl will also report missing -> NotFound.
      await expect(adapter.head("kg999999")).rejects.toMatchObject({
        code: "NotFound",
      });
    });

    test("head falls back to getMetadata in an action context", async () => {
      const backend = makeBackend();
      const adapter = convex({ ctx: backend.actionCtx });
      const id = backend.put(new TextEncoder().encode("meta"), "text/plain");
      const file = await adapter.head(id);
      // actionCtx has no ctx.db, so metadata comes from storage.getMetadata.
      // That source carries no _creationTime, so lastModified is absent.
      expect(file.size).toBe(4);
      expect(file.type).toBe("text/plain");
      expect(file.lastModified).toBeUndefined();
    });

    test("getMetadata returning null surfaces as NotFound via getUrl", async () => {
      // No ctx.db and getMetadata yields null -> readMeta returns undefined,
      // then head confirms absence through getUrl.
      const ctx: ConvexCtx = {
        storage: {
          getMetadata: () => Promise.resolve(null),
          getUrl: () => Promise.resolve(null),
        },
      };
      const adapter = convex({ ctx });
      await expect(adapter.head("kg000000")).rejects.toMatchObject({
        code: "NotFound",
      });
    });
  });

  describe("head fallbacks", () => {
    test("a metadata-less but present file heads with minimal info", async () => {
      // getMetadata says no metadata, but getUrl confirms the file exists.
      const ctx: ConvexCtx = {
        storage: {
          getMetadata: () => Promise.resolve(null),
          getUrl: () =>
            Promise.resolve("https://fake.convex.cloud/api/storage/kg000000"),
        },
      };
      const adapter = convex({ ctx });
      const file = await adapter.head("kg000000");
      expect(file.size).toBe(0);
      expect(file.type).toBe("application/octet-stream");
      expect(file.etag).toBeUndefined();
    });

    test("head rethrows when readMeta itself fails", async () => {
      const ctx: ConvexCtx = {
        db: {
          system: {
            get: () => Promise.reject(new Error("db read failed")),
            query: () => {
              throw new Error("unused");
            },
          },
        },
        storage: {
          getUrl: () => Promise.resolve(null),
        },
      };
      const adapter = convex({ ctx });
      await expect(adapter.head("kg000000")).rejects.toMatchObject({
        code: "Provider",
        message: "db read failed",
      });
    });

    test("head rethrows when the existence getUrl probe fails", async () => {
      // No metadata source, so head probes getUrl, which rejects.
      const ctx: ConvexCtx = {
        storage: {
          getMetadata: () => Promise.resolve(null),
          getUrl: () => Promise.reject(new Error("getUrl exploded")),
        },
      };
      const adapter = convex({ ctx });
      await expect(adapter.head("kg000000")).rejects.toMatchObject({
        code: "Provider",
        message: "getUrl exploded",
      });
    });
  });

  describe("lazy body factory errors", () => {
    test("reading a head() body rethrows a get() failure", async () => {
      const ctx: ConvexCtx = {
        storage: {
          get: () => Promise.reject(new Error("get blew up")),
          getMetadata: () =>
            Promise.resolve({
              contentType: "text/plain",
              sha256: "abc",
              size: 3,
            }),
          getUrl: () =>
            Promise.resolve("https://fake.convex.cloud/api/storage/kg000000"),
        },
      };
      const adapter = convex({ ctx });
      const file = await adapter.head("kg000000");
      await expect(file.arrayBuffer()).rejects.toMatchObject({
        code: "Provider",
        message: "get blew up",
      });
    });

    test("reading a head() body throws NotFound when get() yields null", async () => {
      const ctx: ConvexCtx = {
        storage: {
          get: () => Promise.resolve(null),
          getMetadata: () =>
            Promise.resolve({
              contentType: "text/plain",
              sha256: "abc",
              size: 3,
            }),
          getUrl: () =>
            Promise.resolve("https://fake.convex.cloud/api/storage/kg000000"),
        },
      };
      const adapter = convex({ ctx });
      const file = await adapter.head("kg000000");
      await expect(file.arrayBuffer()).rejects.toMatchObject({
        code: "NotFound",
      });
    });
  });

  describe("delete gating + errors", () => {
    test("delete throws in a query-only context", async () => {
      const { queryCtx } = makeBackend();
      const adapter = convex({ ctx: queryCtx });
      await expect(adapter.delete("kg000000")).rejects.toThrow(
        /delete\(\) requires a mutation or action/u
      );
    });

    test("delete is idempotent when the provider reports not-found", async () => {
      const ctx: ConvexCtx = {
        storage: {
          delete: () => Promise.reject(new Error("could not find file")),
          getUrl: () => Promise.resolve(null),
        },
      };
      const adapter = convex({ ctx });
      await expect(adapter.delete("kg000000")).resolves.toBeUndefined();
    });

    test("delete rethrows a non-NotFound provider failure", async () => {
      const ctx: ConvexCtx = {
        storage: {
          delete: () => Promise.reject(new Error("delete denied")),
          getUrl: () => Promise.resolve(null),
        },
      };
      const adapter = convex({ ctx });
      await expect(adapter.delete("kg000000")).rejects.toMatchObject({
        code: "Provider",
        message: "delete denied",
      });
    });
  });

  describe("download errors", () => {
    test("download rethrows a get() failure as a mapped error", async () => {
      const ctx: ConvexCtx = {
        storage: {
          get: () => Promise.reject(new Error("download blew up")),
          getUrl: () => Promise.resolve(null),
        },
      };
      const adapter = convex({ ctx });
      await expect(adapter.download("kg000000")).rejects.toMatchObject({
        code: "Provider",
        message: "download blew up",
      });
    });
  });

  describe("list errors", () => {
    test("list rethrows a paginate failure as a mapped error", async () => {
      const ctx: ConvexCtx = {
        db: {
          system: {
            get: () => Promise.resolve(null),
            query: () => ({
              paginate: () => Promise.reject(new Error("paginate exploded")),
            }),
          },
        },
        storage: {
          getUrl: () => Promise.resolve(null),
        },
      };
      const adapter = convex({ ctx });
      await expect(adapter.list()).rejects.toMatchObject({
        code: "Provider",
        message: "paginate exploded",
      });
    });
  });

  describe("signedUploadUrl errors", () => {
    test("signedUploadUrl does not mint an unbound Convex upload URL", async () => {
      let called = false;
      const ctx: ConvexCtx = {
        storage: {
          generateUploadUrl: () => {
            called = true;
            return Promise.resolve("https://fake.convex.cloud/upload");
          },
          getUrl: () => Promise.resolve(null),
        },
      };
      const adapter = convex({ ctx });
      await expect(
        adapter.signedUploadUrl("k", { expiresIn: 60 })
      ).rejects.toThrow(/not supported/u);
      expect(called).toBe(false);
    });
  });

  describe("upload errors", () => {
    test("upload rethrows a store() failure as a mapped error", async () => {
      const ctx: ConvexCtx = {
        storage: {
          getUrl: () => Promise.resolve(null),
          store: () => Promise.reject(new Error("store blew up")),
        },
      };
      const adapter = convex({ ctx });
      await expect(adapter.upload("k", "x")).rejects.toMatchObject({
        code: "Provider",
        message: "store blew up",
      });
    });
  });
});

describe("type assignability", () => {
  test("real Convex contexts satisfy ConvexAdapterOptions['ctx']", () => {
    expect(
      [acceptsActionCtx, acceptsMutationCtx, acceptsQueryCtx].every(
        (f) => typeof f === "function"
      )
    ).toBe(true);
  });
});
