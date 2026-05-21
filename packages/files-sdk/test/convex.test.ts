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
      const adapter = convex({ ctx: actionCtx });
      await expect(
        adapter.upload("k", "x", { metadata: { a: "b" } })
      ).rejects.toMatchObject({ code: "Provider" });
      await expect(
        adapter.upload("k", "x", { cacheControl: "max-age=60" })
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
    test("returns a raw-body POST target", async () => {
      const { actionCtx } = makeBackend();
      const adapter = convex({ ctx: actionCtx });
      const signed = await adapter.signedUploadUrl("k", { expiresIn: 60 });
      expect(signed).toEqual({
        fields: {},
        method: "POST",
        url: expect.stringContaining("https://fake.convex.cloud/upload"),
      });
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
