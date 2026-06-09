import { createStoredFile } from "../index.js";
import type {
  Files,
  FilesOperation,
  FilesPlugin,
  PluginNext,
  StoredFile,
  StoredFileMeta,
} from "../index.js";

/** The read verbs {@link cache} can serve from its store. */
export type CacheableOperation = "head" | "url" | "download";

/** Default TTL for every cached entry, in milliseconds (60s). */
const DEFAULT_TTL = 60_000;

/** Default ceiling on a cacheable `download` body, in bytes (1 MiB). */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Default number of distinct keys the in-memory store retains. */
const DEFAULT_MAX_ENTRIES = 1000;

/** The read verbs cached unless {@link CacheOptions.operations} overrides them. */
const DEFAULT_OPERATIONS: readonly CacheableOperation[] = ["head", "url"];

/**
 * One key's cached state, as held by a {@link CacheStore}. Treat it as
 * **opaque** — the in-memory store keeps it as-is; a remote/KV store must
 * (de)serialize it (it's JSON-able apart from `downloads[*].bytes`, a
 * `Uint8Array` of the cached body). Keeping every verb for a key under one
 * record is what makes invalidation a single `delete(key)`.
 */
export interface CacheRecord {
  /** Cached `head` metadata and when it goes stale (ms epoch). */
  head?: { meta: StoredFileMeta; expiresAt: number };
  /** Cached `url` strings, keyed by their url-options signature. */
  urls?: Record<string, { value: string; expiresAt: number }>;
  /** Cached `download` bodies, keyed by their byte-range signature. */
  downloads?: Record<
    string,
    { meta: StoredFileMeta; bytes: Uint8Array; expiresAt: number }
  >;
}

/**
 * The backing store for {@link cache}. Keyed by the **caller-facing** object key
 * (never the internal prefixed path), each entry is the whole {@link CacheRecord}
 * for that key — so a write invalidates every cached verb in one `delete`.
 * Defaults to a bounded in-memory LRU; pass your own to share a cache across
 * instances or processes (e.g. a Redis-backed store that serializes the record).
 *
 * Methods may be sync or async; the plugin awaits them either way. A distributed
 * store has an inherent read-modify-write race when two different verbs for the
 * same key are first cached at the exact same moment — harmless, it just costs a
 * re-fetch next time.
 */
export interface CacheStore {
  /** Read a key's record, or `undefined` on a miss. */
  get(key: string): CacheRecord | undefined | Promise<CacheRecord | undefined>;
  /** Write (replace) a key's record. */
  set(key: string, record: CacheRecord): void | Promise<void>;
  /** Drop a key's record — the unit of invalidation. */
  delete(key: string): void | Promise<void>;
  /** Drop every record. */
  clear(): void | Promise<void>;
}

export interface CacheOptions {
  /**
   * Where cached records live. Defaults to a bounded in-memory LRU keyed by
   * object key (see {@link CacheOptions.maxEntries}). Pass a {@link CacheStore}
   * to back the cache with your own KV — shared across instances/processes.
   */
  store?: CacheStore;
  /**
   * Time-to-live for cached entries, in milliseconds. Defaults to `60_000`
   * (60s). `0` or negative disables time-based expiry (entries live until
   * evicted or invalidated). A cached `url` is **additionally** capped at its
   * own `expiresIn`, so a presigned URL is never served past its signature —
   * but keep `ttl` comfortably below your URL expiry so reads stay fresh.
   */
  ttl?: number;
  /**
   * Which read verbs to cache. Defaults to `["head", "url"]` — the cheap,
   * body-free ones. Add `"download"` to also cache **small** bodies (gated by
   * {@link CacheOptions.maxBytes}); larger or unknown-length downloads stream
   * through uncached so streaming is never broken.
   */
  operations?: readonly CacheableOperation[];
  /**
   * Largest `download` body eligible for caching, in bytes. Defaults to
   * `1_048_576` (1 MiB). A response larger than this — or one whose length the
   * adapter doesn't report — is returned untouched and not buffered, so
   * streaming and large objects keep working. Only consulted when `"download"`
   * is in {@link CacheOptions.operations}.
   */
  maxBytes?: number;
  /**
   * Maximum number of distinct keys the **default** in-memory store retains
   * before evicting the least-recently-used. Defaults to `1000`. Ignored when a
   * custom {@link CacheOptions.store} is supplied. Note the worst-case memory is
   * roughly `maxEntries * maxBytes` once `download` caching is on.
   */
  maxEntries?: number;
  /**
   * Clock backing TTL and expiry, defaulting to `Date.now`. Inject a fake for
   * deterministic expiry in tests.
   */
  clock?: () => number;
}

/**
 * The methods {@link cache} grafts onto a {@link Files} instance. A `type`
 * rather than an `interface` so it satisfies the `Record<string, unknown>`
 * constraint on {@link FilesPlugin}'s extension parameter — an interface has no
 * implicit index signature and wouldn't be assignable.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- must be a type alias for the Record<string, unknown> constraint above.
export type CacheApi = {
  /**
   * Drop the cached entries for one key — or the **entire** cache when `key` is
   * omitted. Reach for this after a change the plugin couldn't see (a write
   * through a presigned URL, or directly against the provider), to stop serving
   * stale reads.
   */
  invalidateCache(key?: string): Promise<void>;
  /** A fresh snapshot of cache hit/miss counts since construction (or last reset). */
  cacheStats(): CacheStats;
  /** Zero the hit/miss counters, starting a fresh accounting window. */
  resetCacheStats(): void;
};

/** Point-in-time hit/miss tally from {@link CacheApi.cacheStats}. */
export interface CacheStats {
  /** Reads served from the cache. */
  hits: number;
  /** Reads that fell through to the provider. */
  misses: number;
}

/** A bounded, least-recently-used in-memory {@link CacheStore}. */
const createMemoryStore = (max: number): CacheStore => {
  const map = new Map<string, CacheRecord>();
  return {
    clear: () => map.clear(),
    delete: (key) => {
      map.delete(key);
    },
    get: (key) => {
      const record = map.get(key);
      if (record !== undefined) {
        // Re-insert to mark most-recently-used: Map preserves insertion order,
        // so the first key is always the LRU victim.
        map.delete(key);
        map.set(key, record);
      }
      return record;
    },
    set: (key, record) => {
      map.delete(key);
      map.set(key, record);
      while (map.size > max) {
        // The loop only runs while the map is non-empty, so the oldest key
        // (insertion-order first) is always present.
        map.delete(map.keys().next().value as string);
      }
    },
  };
};

/** Pull the cacheable metadata off a {@link StoredFile}. */
const metaOf = (file: StoredFile): StoredFileMeta => ({
  key: file.key,
  size: file.size,
  type: file.type,
  ...(file.lastModified !== undefined && { lastModified: file.lastModified }),
  ...(file.etag !== undefined && { etag: file.etag }),
  ...(file.metadata !== undefined && { metadata: file.metadata }),
});

/** Stable signature for the url-affecting options, so variants cache apart. */
const urlSignature = (options?: {
  expiresIn?: number;
  responseContentDisposition?: string;
}): string =>
  JSON.stringify([
    options?.expiresIn ?? null,
    options?.responseContentDisposition ?? null,
  ]);

/** Stable signature for a download's byte range (empty string = whole object). */
const rangeSignature = (range?: { start: number; end?: number }): string =>
  range ? `${range.start}-${range.end ?? ""}` : "";

/**
 * An LRU/KV cache in front of the cheap read verbs — `head`, `url`, and
 * (opt-in) small `download` bodies. A repeat read of an unchanged key is served
 * from memory instead of round-tripping to the provider; any write through the
 * instance (`upload`, `delete`, `copy`, `move`) invalidates the affected key so
 * the next read re-fetches.
 *
 * What's cached, and how it stays correct:
 * - **`head`** caches the metadata only. A hit returns a {@link StoredFile}
 *   whose body still lazy-fetches on access (the same contract an uncached
 *   `head` has), so nothing buffers.
 * - **`url`** caches the returned string per url-options signature, and **caps
 *   each entry at its own `expiresIn`** so a presigned URL is never handed out
 *   past its signature. Keep {@link CacheOptions.ttl} well below your URL expiry.
 * - **`download`** is **off by default** — add `"download"` to
 *   {@link CacheOptions.operations}. Even then only **known-length bodies at or
 *   under {@link CacheOptions.maxBytes}** are buffered and cached; anything
 *   larger or of unknown length streams through untouched, so streaming and
 *   range downloads keep working. A cached small body is re-served as a fresh,
 *   re-readable `StoredFile`.
 *
 * Invalidation is by **caller-facing key** (never the internal prefixed path):
 * `upload`/`delete` drop that key, `copy` drops the destination, `move` drops
 * both. Writes the plugin can't observe — a presigned-URL upload, or a change
 * made straight against the provider — won't invalidate; call
 * `files.invalidateCache(key)` (or `invalidateCache()` to clear all) when that
 * happens, and treat a cache as eventually-consistent. It writes **no object
 * metadata** and has **no native dependencies**, so it works on any adapter.
 *
 * Plugins run **outside** retries, so a cache hit skips the retry loop entirely
 * and a populated entry reflects one logical, post-retry result. Place `cache()`
 * **first** (outermost) so it short-circuits before the rest of the pipeline
 * does any work; place it after a body-transforming plugin (`encryption()`,
 * `compression()`) only if you intend to cache the transformed bytes.
 *
 * It uses `extend` (for `invalidateCache()` / `cacheStats()` / `resetCacheStats()`),
 * so reach for {@link createFiles} to surface those on the type.
 *
 * @param options optional `{ store, ttl, operations, maxBytes, maxEntries, clock }`.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { cache } from "files-sdk/cache";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [cache({ ttl: 30_000, operations: ["head", "url", "download"] })],
 * });
 *
 * await files.head("a.png"); // miss → provider
 * await files.head("a.png"); // hit  → memory
 * await files.upload("a.png", body); // invalidates "a.png"
 * await files.head("a.png"); // miss → provider again
 * files.cacheStats(); // { hits: 1, misses: 2 }
 * ```
 */
export const cache = (options: CacheOptions = {}): FilesPlugin<CacheApi> => {
  const ttl = options.ttl ?? DEFAULT_TTL;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const clock = options.clock ?? Date.now;
  const store =
    options.store ??
    createMemoryStore(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const enabled = new Set(options.operations ?? DEFAULT_OPERATIONS);

  const stats: CacheStats = { hits: 0, misses: 0 };

  // The fully-wrapped instance, captured at construction via `extend`. A `head`
  // cache hit lazy-fetches its body back through here, matching the uncached
  // `head` contract (body accessors download on call).
  let instance: Files | undefined;
  const downloadBytes = async (key: string): Promise<Uint8Array> => {
    // `extend` runs at construction, before any operation, so `instance` is
    // always set by the time a cached `head` body is read.
    const file = await (instance as Files).download(key);
    return new Uint8Array(await file.arrayBuffer());
  };

  /** Compute an absolute expiry, optionally capped by a verb-specific window. */
  const expiryFrom = (now: number, capMs?: number): number => {
    const base = ttl > 0 ? now + ttl : Number.POSITIVE_INFINITY;
    return capMs === undefined ? base : Math.min(base, now + capMs);
  };

  /** Read-modify-write a key's record through whichever store is configured. */
  const putRecord = async (
    key: string,
    update: (record: CacheRecord) => CacheRecord
  ): Promise<void> => {
    const current = (await store.get(key)) ?? {};
    await store.set(key, update(current));
  };

  const cachedHead = async (
    op: Extract<FilesOperation, { kind: "head" }>,
    next: PluginNext
  ): Promise<StoredFile> => {
    const now = clock();
    const record = await store.get(op.key);
    const entry = record?.head;
    if (entry && entry.expiresAt > now) {
      stats.hits += 1;
      return createStoredFile(entry.meta, {
        factory: () => downloadBytes(op.key),
        kind: "lazy",
      });
    }
    stats.misses += 1;
    const file = await next(op);
    const meta = metaOf(file);
    await putRecord(op.key, (prev) => ({
      ...prev,
      head: { expiresAt: expiryFrom(now), meta },
    }));
    return file;
  };

  const cachedUrl = async (
    op: Extract<FilesOperation, { kind: "url" }>,
    next: PluginNext
  ): Promise<string> => {
    const signature = urlSignature(op.options);
    const now = clock();
    const record = await store.get(op.key);
    const entry = record?.urls?.[signature];
    if (entry && entry.expiresAt > now) {
      stats.hits += 1;
      return entry.value;
    }
    stats.misses += 1;
    const value = await next(op);
    const capMs =
      op.options?.expiresIn === undefined
        ? undefined
        : op.options.expiresIn * 1000;
    await putRecord(op.key, (prev) => ({
      ...prev,
      urls: {
        ...prev.urls,
        [signature]: { expiresAt: expiryFrom(now, capMs), value },
      },
    }));
    return value;
  };

  const cachedDownload = async (
    op: Extract<FilesOperation, { kind: "download" }>,
    next: PluginNext
  ): Promise<StoredFile> => {
    const signature = rangeSignature(op.options?.range);
    const now = clock();
    const record = await store.get(op.key);
    const entry = record?.downloads?.[signature];
    if (entry && entry.expiresAt > now) {
      stats.hits += 1;
      return createStoredFile(entry.meta, {
        data: entry.bytes,
        kind: "buffer",
      });
    }
    stats.misses += 1;
    const file = await next(op);
    // Buffering an unknown-length or large body would break streaming, so only
    // small, known-length responses are cached — the rest passes through as-is.
    if (typeof file.size !== "number" || file.size > maxBytes) {
      return file;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = metaOf(file);
    await putRecord(op.key, (prev) => ({
      ...prev,
      downloads: {
        ...prev.downloads,
        [signature]: { bytes, expiresAt: expiryFrom(now), meta },
      },
    }));
    return createStoredFile(meta, { data: bytes, kind: "buffer" });
  };

  const wrap = (async (
    op: FilesOperation,
    next: PluginNext
  ): Promise<unknown> => {
    switch (op.kind) {
      case "head": {
        return enabled.has("head") ? cachedHead(op, next) : next(op);
      }
      case "url": {
        return enabled.has("url") ? cachedUrl(op, next) : next(op);
      }
      case "download": {
        return enabled.has("download") ? cachedDownload(op, next) : next(op);
      }
      // Writes always invalidate, regardless of which reads are cached — drop
      // the affected key(s) only after the mutation actually lands.
      case "upload":
      case "delete": {
        const result = await next(op);
        await store.delete(op.key);
        return result;
      }
      case "copy": {
        const result = await next(op);
        await store.delete(op.to);
        return result;
      }
      case "move": {
        const result = await next(op);
        await store.delete(op.from);
        await store.delete(op.to);
        return result;
      }
      default: {
        return next(op);
      }
    }
  }) as NonNullable<FilesPlugin["wrap"]>;

  return {
    extend: (files) => {
      instance = files;
      return {
        cacheStats: () => ({ ...stats }),
        invalidateCache: async (key?: string) => {
          if (key === undefined) {
            await store.clear();
            return;
          }
          await store.delete(key);
        },
        resetCacheStats: () => {
          stats.hits = 0;
          stats.misses = 0;
        },
      };
    },
    name: "cache",
    wrap,
  };
};
