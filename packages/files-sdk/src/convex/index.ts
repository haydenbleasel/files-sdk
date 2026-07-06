import type {
  Adapter,
  ListResult,
  SignedUpload,
  StoredFile,
  UploadResult,
  UrlOptions,
} from "../index.js";
import { collectStream, normalizeBody } from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

// Convex assigns the storage id (`Id<"_storage">`, an opaque string); the
// caller never chooses it. So the adapter treats that id as the unified
// `key`. We type ids as plain `string` here — a real `Id<"_storage">` is a
// branded string and assignable to it.
// oxlint-disable-next-line sonarjs/redundant-type-aliases -- names the domain concept (a Convex `_storage` id) at every use site; not dead weight.
type ConvexStorageId = string;

// A row of the `_storage` system table. Fields are fixed by Convex: there is
// no writable user-metadata field, so `metadata` always round-trips as
// `undefined`.
interface ConvexStorageDoc {
  _id: ConvexStorageId;
  _creationTime: number;
  contentType?: string | null;
  sha256: string;
  size: number;
}

// The subset of `ctx.storage` the adapter touches. A real `StorageReader` /
// `StorageWriter` / `StorageActionWriter` stays structurally assignable here
// because these parameters (`ConvexStorageId` = `string`) are wider than
// Convex's `Id<"_storage"> | string`. `getUrl` is the only member present in
// every function context; the rest are optional because Convex gates them by
// context (`store`/`get` are action-only; `delete` / `generateUploadUrl` are
// writer-only) and the adapter feature-detects them.
interface ConvexStorageLike {
  getUrl: (storageId: ConvexStorageId) => Promise<string | null>;
  store?: (
    blob: Blob,
    options?: { sha256?: string }
  ) => Promise<ConvexStorageId>;
  get?: (storageId: ConvexStorageId) => Promise<Blob | null>;
  getMetadata?: (storageId: ConvexStorageId) => Promise<{
    contentType: string | null;
    sha256: string;
    size: number;
  } | null>;
  delete?: (storageId: ConvexStorageId) => Promise<void>;
  generateUploadUrl?: () => Promise<string>;
}

interface ConvexPaginationResult {
  page: ConvexStorageDoc[];
  isDone: boolean;
  continueCursor: string;
}

interface ConvexSystemQuery {
  paginate: (opts: {
    numItems: number;
    cursor: string | null;
  }) => Promise<ConvexPaginationResult>;
}

// `ctx.db.system`, available only in queries and mutations. Used by `list()`
// (the only way to enumerate stored files) and as the preferred metadata
// source for `head()`. `get` takes the table name first to match Convex's
// primary `db.get(table, id)` overload.
interface ConvexSystemReader {
  // Method syntax (not an arrow property) is deliberate: TypeScript checks
  // method parameters bivariantly, which lets Convex's real `db.system.get`
  // (whose `id` is a branded `Id<"_storage">`) be assigned here despite our
  // widened `string` parameter. An arrow-property/function type would be
  // checked contravariantly and reject that assignment.
  // oxlint-disable-next-line typescript/method-signature-style -- see above; method bivariance is required for the real Convex ctx to be assignable.
  get(
    table: "_storage",
    storageId: ConvexStorageId
  ): Promise<ConvexStorageDoc | null>;
  query: (tableName: "_storage") => ConvexSystemQuery;
}

/**
 * The Convex function context the adapter wraps — the `ctx` passed to your
 * `action`, `mutation`, or `query` handler. Only `ctx.storage` (with `getUrl`)
 * and the optional `ctx.db.system` are used, so any real Convex context is
 * structurally assignable.
 */
export interface ConvexCtx {
  storage: ConvexStorageLike;
  db?: { system: ConvexSystemReader };
}

export interface ConvexAdapterOptions {
  /**
   * The Convex function context (`ctx`) for the current request. Construct the
   * adapter per-call inside a Convex function: `convex({ ctx })`.
   *
   * Which operations work depends on the context Convex gives you:
   * - **action / httpAction** — `upload`, `download`, `delete`, `url`, `head`,
   *   `exists`. `list` throws (no `ctx.db`).
   * - **mutation** — `delete`, `url`, `head`, `exists`, `list`. `upload` /
   *   `download` throw (no `ctx.storage.store` / `get` outside actions).
   * - **query** — `url`, `head`, `exists`, `list` (all read-only).
   *
   * The adapter feature-detects the underlying primitive and throws a
   * descriptive error when it is unavailable in the current context.
   */
  ctx: ConvexCtx;
}

export type ConvexAdapter = Adapter<ConvexCtx>;

const OCTET_STREAM = "application/octet-stream";

// Convex surfaces "missing" mostly as `null` returns (handled inline), so the
// mapper just classifies thrown errors: not-found phrasing → NotFound, every
// other failure → Provider with the original preserved as `cause`.
const mapConvexError = (err: unknown): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/not found|could not find|does not exist|nonexistent/iu.test(message)) {
    return new FilesError("NotFound", message, err);
  }
  return new FilesError("Provider", message, err);
};

const REQUIRES_ACTION =
  "requires an action context (ctx.storage.store / ctx.storage.get), which is unavailable in queries and mutations. Call it from a Convex action.";

export const convex = (opts: ConvexAdapterOptions): ConvexAdapter => {
  const ctx = opts?.ctx;
  if (
    !ctx ||
    typeof ctx !== "object" ||
    typeof (ctx as ConvexCtx).storage?.getUrl !== "function"
  ) {
    throw new FilesError(
      "Provider",
      "convex adapter: `ctx` is required. Pass the Convex function context — `convex({ ctx })` — from inside an action, mutation, or query."
    );
  }

  const { storage } = ctx;

  // Read sha256/size/contentType for `key`. Prefers the system table
  // (`ctx.db.system`, queries/mutations) which also carries `_creationTime`;
  // falls back to the deprecated `ctx.storage.getMetadata` (actions). Returns
  // `undefined` when the file is missing or no metadata source is available.
  const readMeta = async (
    key: ConvexStorageId
  ): Promise<
    | {
        size: number;
        contentType: string;
        sha256: string;
        lastModified?: number;
      }
    | undefined
  > => {
    if (ctx.db) {
      const doc = await ctx.db.system.get("_storage", key);
      return doc
        ? {
            contentType: doc.contentType ?? OCTET_STREAM,
            lastModified: doc._creationTime,
            sha256: doc.sha256,
            size: doc.size,
          }
        : undefined;
    }
    if (typeof storage.getMetadata === "function") {
      const meta = await storage.getMetadata(key);
      return meta
        ? {
            contentType: meta.contentType ?? OCTET_STREAM,
            sha256: meta.sha256,
            size: meta.size,
          }
        : undefined;
    }
    return undefined;
  };

  // Read a file body into bytes. Requires an action context.
  const loadBytes = async (key: ConvexStorageId): Promise<Uint8Array> => {
    if (typeof storage.get !== "function") {
      throw new FilesError(
        "Provider",
        `convex: reading a file body ${REQUIRES_ACTION}`
      );
    }
    let blob: Blob | null;
    try {
      blob = await storage.get(key);
    } catch (error) {
      throw mapConvexError(error);
    }
    if (!blob) {
      throw new FilesError("NotFound", `convex: not found: ${key}`);
    }
    return new Uint8Array(await blob.arrayBuffer());
  };

  const adapter: ConvexAdapter = {
    copy(_from, _to): Promise<void> {
      return Promise.reject(
        new FilesError(
          "Provider",
          "convex: copy() is not supported. Convex assigns immutable storage ids and cannot copy to a caller-chosen key — download() the source and upload() it back, then track the new id."
        )
      );
    },

    async delete(key) {
      if (typeof storage.delete !== "function") {
        throw new FilesError(
          "Provider",
          "convex: delete() requires a mutation or action context (ctx.storage.delete); it is unavailable in queries."
        );
      }
      try {
        await storage.delete(key);
      } catch (error) {
        const mapped = mapConvexError(error);
        // Idempotent: deleting a missing key is a no-op, matching the contract.
        if (mapped.code === "NotFound") {
          return;
        }
        throw mapped;
      }
    },

    async download(key): Promise<StoredFile> {
      if (typeof storage.get !== "function") {
        throw new FilesError(
          "Provider",
          `convex: download() ${REQUIRES_ACTION}`
        );
      }
      let blob: Blob | null;
      try {
        blob = await storage.get(key);
      } catch (error) {
        throw mapConvexError(error);
      }
      if (!blob) {
        throw new FilesError("NotFound", `convex: not found: ${key}`);
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const meta = await readMeta(key);
      return createStoredFile(
        {
          ...(meta?.sha256 && { etag: meta.sha256 }),
          key,
          ...(meta?.lastModified !== undefined && {
            lastModified: meta.lastModified,
          }),
          size: meta?.size ?? bytes.byteLength,
          type: meta?.contentType ?? (blob.type || OCTET_STREAM),
        },
        { data: bytes, kind: "buffer" }
      );
    },

    async exists(key) {
      try {
        const url = await storage.getUrl(key);
        return url !== null;
      } catch (error) {
        const mapped = mapConvexError(error);
        if (mapped.code === "NotFound") {
          return false;
        }
        throw mapped;
      }
    },

    async head(key): Promise<StoredFile> {
      let meta: Awaited<ReturnType<typeof readMeta>>;
      try {
        meta = await readMeta(key);
      } catch (error) {
        throw mapConvexError(error);
      }
      if (!meta) {
        // No metadata row — confirm existence via getUrl so a present-but-
        // metadata-less file still heads with minimal info rather than 404ing.
        let url: string | null;
        try {
          url = await storage.getUrl(key);
        } catch (error) {
          throw mapConvexError(error);
        }
        if (url === null) {
          throw new FilesError("NotFound", `convex: not found: ${key}`);
        }
        meta = { contentType: OCTET_STREAM, sha256: "", size: 0 };
      }
      return createStoredFile(
        {
          ...(meta.sha256 && { etag: meta.sha256 }),
          key,
          ...(meta.lastModified !== undefined && {
            lastModified: meta.lastModified,
          }),
          size: meta.size,
          type: meta.contentType,
        },
        { factory: () => loadBytes(key), kind: "lazy" }
      );
    },

    async list(options): Promise<ListResult> {
      if (!ctx.db) {
        throw new FilesError(
          "Provider",
          "convex: list() requires a query or mutation context (ctx.db.system); it is unavailable in actions. Call files.list() from a Convex query or mutation."
        );
      }
      let result: ConvexPaginationResult;
      try {
        result = await ctx.db.system.query("_storage").paginate({
          cursor: options?.cursor ?? null,
          numItems: options?.limit ?? 1000,
        });
      } catch (error) {
        throw mapConvexError(error);
      }
      // Storage ids are opaque (not hierarchical), so `prefix` is rarely
      // meaningful here; applied as a literal id prefix for consistency.
      const prefix = options?.prefix;
      const items: StoredFile[] = result.page.flatMap((doc) =>
        prefix && !doc._id.startsWith(prefix)
          ? []
          : [
              createStoredFile(
                {
                  etag: doc.sha256,
                  key: doc._id,
                  lastModified: doc._creationTime,
                  size: doc.size,
                  type: doc.contentType ?? OCTET_STREAM,
                },
                { factory: () => loadBytes(doc._id), kind: "lazy" }
              ),
            ]
      );
      return {
        items,
        ...(result.isDone ? {} : { cursor: result.continueCursor }),
      };
    },

    name: "convex",
    raw: ctx,

    signedUploadUrl(_key): Promise<SignedUpload> {
      if (typeof storage.generateUploadUrl !== "function") {
        return Promise.reject(
          new FilesError(
            "Provider",
            "convex: signedUploadUrl() requires a mutation or action context (ctx.storage.generateUploadUrl); it is unavailable in queries."
          )
        );
      }
      return Promise.reject(
        new FilesError(
          "Provider",
          "convex: signedUploadUrl() is not supported. Convex generateUploadUrl() cannot bind the caller's key, expiresIn, maxSize, minSize, or contentType into the issued upload capability; upload through a Convex action with files.upload() instead."
        )
      );
    },
    // `url()` returns a permanent Convex serving URL — unsigned and
    // non-expiring (`expiresIn` is ignored), so not a signed URL.
    signedUrl: { supported: false },
    // Convex storage ids are immutable — `copy()` is unsupported (throws).
    supportsServerSideCopy: false,
    async upload(_key, body, options): Promise<UploadResult> {
      // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
      // (this adapter sets neither `supportsMetadata` nor `supportsCacheControl`)
      // — Convex's _storage table is fixed to contentType/sha256/size.
      if (typeof storage.store !== "function") {
        throw new FilesError("Provider", `convex: upload() ${REQUIRES_ACTION}`);
      }
      // The caller-supplied `key` is ignored: Convex assigns the id. It is
      // returned as `UploadResult.key`.
      const normalized = await normalizeBody(body, options?.contentType);
      const bytes =
        normalized.data instanceof ReadableStream
          ? await collectStream(normalized.data)
          : normalized.data;
      const blob = new Blob([bytes as BlobPart], {
        type: normalized.contentType,
      });
      let id: ConvexStorageId;
      try {
        id = await storage.store(blob);
      } catch (error) {
        throw mapConvexError(error);
      }
      const meta = await readMeta(id);
      return {
        contentType: meta?.contentType ?? normalized.contentType,
        ...(meta?.sha256 && { etag: meta.sha256 }),
        key: id,
        ...(meta?.lastModified !== undefined && {
          lastModified: meta.lastModified,
        }),
        size: meta?.size ?? blob.size,
      };
    },

    async url(key, urlOpts?: UrlOptions): Promise<string> {
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "convex: `responseContentDisposition` is not supported. Convex serving URLs have no signature in which to bind a Content-Disposition override; serve untrusted content through your own HTTP action instead."
        );
      }
      let url: string | null;
      try {
        url = await storage.getUrl(key);
      } catch (error) {
        throw mapConvexError(error);
      }
      // Convex URLs do not expire while the file exists, so `expiresIn` is
      // ignored.
      if (url === null) {
        throw new FilesError("NotFound", `convex: not found: ${key}`);
      }
      return url;
    },
  };

  return adapter;
};
