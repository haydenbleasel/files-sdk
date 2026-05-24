import type {
  Adapter,
  Body,
  ListResult,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import { collectStream } from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

/**
 * A value the {@link MemoryAdapterOptions.initial} seed accepts for one key.
 *
 * The constructor is synchronous, so a seed body must be convertible to bytes
 * without awaiting — that rules out `Blob`/`File` (their `arrayBuffer()` is
 * async) and `ReadableStream`. Seed those by calling `upload()` after
 * construction instead. The object form lets a fixture pin a `contentType` /
 * `metadata` / `cacheControl` the way an `upload()` call would.
 */
export type MemorySeed =
  | string
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | {
      body: string | Uint8Array | ArrayBuffer | ArrayBufferView;
      contentType?: string;
      metadata?: Record<string, string>;
      cacheControl?: string;
    };

export interface MemoryAdapterOptions {
  /**
   * Keys to pre-populate the store with, useful for tests that need fixtures
   * present up front. Each value is a body (string or bytes) or an object that
   * also pins `contentType` / `metadata` / `cacheControl`. Bodies are copied
   * in, so later mutation of a passed buffer does not change the stored bytes.
   */
  initial?: Record<string, MemorySeed>;
}

/** One stored object: its bytes plus the metadata reads round-trip. */
export interface MemoryEntry {
  bytes: Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
  cacheControl?: string;
  etag: string;
  lastModified: number;
}

/**
 * The `raw` escape hatch is the backing `Map`, so callers can inspect or reset
 * the store directly in tests — `adapter.raw.clear()`, `adapter.raw.size`, etc.
 *
 * `move` is narrowed to required: the adapter always re-keys natively (no
 * copy+delete fallback), so callers can rely on it without an optional guard.
 */
export type MemoryAdapter = Adapter<Map<string, MemoryEntry>> &
  Required<Pick<Adapter<Map<string, MemoryEntry>>, "move">>;

// 2^31 - 1 (a Mersenne prime). The polynomial hash below stays an exact
// integer because `hash * MULTIPLIER + byte` peaks around 31 * 2^31 ≈ 6.7e10,
// well under `Number.MAX_SAFE_INTEGER` (2^53), so no precision is lost.
const ETAG_MODULUS = 2_147_483_647;
const ETAG_MULTIPLIER = 31;
const ETAG_HEX_LEN = 8;

// Content-derived ETag via a polynomial rolling hash over the bytes. Pure
// integer arithmetic keeps the adapter isomorphic (no `node:crypto`, no
// bitwise ops), so it runs unchanged in the browser, edge runtimes, and Deno —
// the environments a dependency-free test/reference adapter is most useful in.
// Identical bytes hash to the same value, matching how a real backend returns
// a stable content ETag for an unchanged object.
const contentEtag = (bytes: Uint8Array): string => {
  let hash = 0;
  for (const byte of bytes) {
    hash = (hash * ETAG_MULTIPLIER + byte) % ETAG_MODULUS;
  }
  return `"${hash.toString(16).padStart(ETAG_HEX_LEN, "0")}"`;
};

const textEncoder = new TextEncoder();

/** The rich object form of a seed value, narrowed away from the bytes forms. */
type SeedObject = Exclude<
  MemorySeed,
  string | Uint8Array | ArrayBuffer | ArrayBufferView
>;

const isSeedObject = (seed: MemorySeed): seed is SeedObject =>
  typeof seed === "object" &&
  !(seed instanceof Uint8Array) &&
  !(seed instanceof ArrayBuffer) &&
  !ArrayBuffer.isView(seed);

const inferContentType = (body: Body, override?: string): string => {
  if (override) {
    return override;
  }
  if (typeof body === "string") {
    return "text/plain; charset=utf-8";
  }
  if (body instanceof Blob && body.type) {
    return body.type;
  }
  return "application/octet-stream";
};

// Bytes-shaped seed values convert synchronously; the constructor cannot await.
const seedBytes = (
  body: string | Uint8Array | ArrayBuffer | ArrayBufferView
): Uint8Array => {
  if (typeof body === "string") {
    return textEncoder.encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
};

const bodyToBytes = async (body: Body): Promise<Uint8Array> => {
  if (typeof body === "string") {
    return textEncoder.encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return await collectStream(body);
};

const compareKeys = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

// Every memory operation is synchronous, but the Adapter contract is
// promise-returning. `defer` lifts a sync body into a promise so a thrown
// `FilesError` (e.g. a missing key) surfaces as a rejection, not a synchronous
// throw — matching how the cloud adapters reject.
const defer = <T>(fn: () => T): Promise<T> => {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
};

export const memory = (opts?: MemoryAdapterOptions): MemoryAdapter => {
  const store = new Map<string, MemoryEntry>();

  // Copy the body in so a later mutation of the caller's buffer can't reach
  // into the store (and vice-versa on read) — value semantics, like a real
  // backend that owns its own bytes. `new Uint8Array(src)` clones into a fresh
  // buffer regardless of the source's shape.
  const put = (
    key: string,
    bytes: Uint8Array,
    contentType: string,
    meta?: { metadata?: Record<string, string>; cacheControl?: string }
  ): MemoryEntry => {
    const copy = new Uint8Array(bytes);
    const entry: MemoryEntry = {
      bytes: copy,
      contentType,
      etag: contentEtag(copy),
      lastModified: Date.now(),
      ...(meta?.metadata && { metadata: meta.metadata }),
      ...(meta?.cacheControl && { cacheControl: meta.cacheControl }),
    };
    store.set(key, entry);
    return entry;
  };

  for (const [key, seed] of Object.entries(opts?.initial ?? {})) {
    if (isSeedObject(seed)) {
      put(
        key,
        seedBytes(seed.body),
        inferContentType(seed.body, seed.contentType),
        { cacheControl: seed.cacheControl, metadata: seed.metadata }
      );
    } else {
      put(key, seedBytes(seed), inferContentType(seed));
    }
  }

  const toStored = (key: string, entry: MemoryEntry): StoredFile =>
    createStoredFile(
      {
        etag: entry.etag,
        key,
        lastModified: entry.lastModified,
        ...(entry.metadata && { metadata: entry.metadata }),
        size: entry.bytes.byteLength,
        type: entry.contentType,
      },
      { data: entry.bytes, kind: "buffer" }
    );

  const getOrThrow = (key: string): MemoryEntry => {
    const entry = store.get(key);
    if (!entry) {
      throw new FilesError("NotFound", `memory: not found: ${key}`);
    }
    return entry;
  };

  return {
    copy(from, to) {
      return defer(() => {
        const entry = getOrThrow(from);
        // Refresh lastModified (a fresh object at `to`), mirroring fs copy. The
        // etag is content-derived, so it lands identical to the source's.
        put(to, entry.bytes, entry.contentType, {
          cacheControl: entry.cacheControl,
          metadata: entry.metadata,
        });
      });
    },
    delete(key) {
      // Idempotent — deleting a missing key is a no-op, matching S3/fs.
      store.delete(key);
      return Promise.resolve();
    },
    download(key, downloadOpts) {
      return defer(() => {
        const entry = getOrThrow(key);
        const range = downloadOpts?.range;
        if (!range) {
          return toStored(key, entry);
        }
        // subarray is a view over the same buffer — no copy — and createStoredFile
        // narrows to the view's bytes when it reads. `end` is inclusive, so +1.
        const sliced = entry.bytes.subarray(
          range.start,
          range.end === undefined ? undefined : range.end + 1
        );
        return createStoredFile(
          {
            etag: entry.etag,
            key,
            lastModified: entry.lastModified,
            ...(entry.metadata && { metadata: entry.metadata }),
            size: sliced.byteLength,
            type: entry.contentType,
          },
          { data: sliced, kind: "buffer" }
        );
      });
    },
    exists(key) {
      return Promise.resolve(store.has(key));
    },
    head(key) {
      return defer(() => toStored(key, getOrThrow(key)));
    },
    list(options): Promise<ListResult> {
      const prefix = options?.prefix ?? "";
      const limit = options?.limit ?? 1000;
      const cursor = options?.cursor;
      const sorted = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .toSorted(([a], [b]) => compareKeys(a, b));
      // Cursor is the last key of the previous page; resume at the first key
      // strictly greater. Same scheme as the fs adapter for consistent
      // pagination across both.
      const startIdx = cursor ? sorted.findIndex(([key]) => key > cursor) : 0;
      const start = startIdx === -1 ? sorted.length : startIdx;
      const slice = sorted.slice(start, start + limit);
      const lastKey = slice.at(-1)?.[0];
      const more = start + slice.length < sorted.length;
      return Promise.resolve({
        items: slice.map(([key, entry]) => toStored(key, entry)),
        ...(more && lastKey && { cursor: lastKey }),
      });
    },
    move(from, to) {
      return defer(() => {
        const entry = getOrThrow(from);
        // Re-key in place — no byte round-trip, unlike the copy()+delete()
        // fallback the SDK would otherwise use. lastModified is preserved (the
        // bytes didn't change), mirroring fs move's rename of the sidecar.
        store.delete(from);
        store.set(to, entry);
      });
    },
    name: "memory",
    raw: store,
    signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      // No real upload endpoint exists; the URL is an inert placeholder, so
      // the key need not exist yet (this is an upload target). `expires`
      // round-trips the requested TTL for callers asserting it flows through.
      return Promise.resolve({
        headers: {
          ...(signOpts.contentType && { "Content-Type": signOpts.contentType }),
        },
        method: "PUT",
        url: `memory://${key}?expires=${signOpts.expiresIn}`,
      });
    },
    supportsRange: true,
    async upload(key, body, options) {
      const bytes = await bodyToBytes(body);
      const contentType = inferContentType(body, options?.contentType);
      const entry = put(key, bytes, contentType, {
        cacheControl: options?.cacheControl,
        metadata: options?.metadata,
      });
      return {
        contentType,
        etag: entry.etag,
        key,
        lastModified: entry.lastModified,
        size: entry.bytes.byteLength,
      } satisfies UploadResult;
    },
    url(key, urlOpts): Promise<string> {
      return defer(() => {
        // Surface a typo'd key the way a fetch against the URL would 404.
        getOrThrow(key);
        // Opaque, non-fetchable URL — there's no server backing the store.
        // Query params reflect the options a caller passed so URL-building
        // logic stays testable; the default call returns a clean
        // `memory://${key}`.
        const params = new URLSearchParams();
        if (urlOpts?.expiresIn !== undefined) {
          params.set("expires", String(urlOpts.expiresIn));
        }
        if (urlOpts?.responseContentDisposition) {
          params.set(
            "response-content-disposition",
            urlOpts.responseContentDisposition
          );
        }
        const query = params.toString();
        return `memory://${key}${query ? `?${query}` : ""}`;
      });
    },
  };
};
