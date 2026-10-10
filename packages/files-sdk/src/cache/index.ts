import { createStoredFile, isConditionalOperation } from "../index.js";
import type {
  Adapter,
  FileInfo,
  FilesOperation,
  FilesPlugin,
  OperationResult,
  PluginNext,
  StoredFile,
} from "../index.js";
import { DEFAULT_URL_EXPIRES_IN } from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { isNumber, isString } from "../internal/is.js";

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
  head?: { meta: FileInfo; expiresAt: number };
  /** Cached `url` strings, keyed by their url-options signature. */
  urls?: Record<string, { value: string; expiresAt: number }>;
  /** Cached `download` bodies, keyed by their byte-range signature. */
  downloads?: Record<
    string,
    { meta: FileInfo; bytes: Uint8Array; expiresAt: number }
  >;
}

/**
 * The backing store for {@link cache}. Each entry is the whole
 * {@link CacheRecord} for one object — so a write invalidates every cached verb
 * in one `delete`. Store keys are opaque strings that scope the
 * **caller-facing** object key by the {@link CacheOptions.namespace} and the
 * instance `prefix` (`<namespace>/<prefix>/<key>`, the first two
 * percent-encoded), so instances sharing one store never read each other's
 * entries unless they share both. Defaults to a bounded in-memory LRU; pass your
 * own to share a cache across instances or processes (e.g. a Redis-backed store
 * that serializes the record).
 *
 * Methods may be sync or async; the plugin awaits them either way. A distributed
 * store has an inherent read-modify-write race when two different verbs for the
 * same key are first cached at the exact same moment — harmless, it just costs a
 * re-fetch next time.
 */
export interface CacheStore {
  /** Read a key's record, or `undefined` on a miss. */
  get: (
    key: string
  ) => CacheRecord | undefined | Promise<CacheRecord | undefined>;
  /** Write (replace) a key's record. */
  set: (key: string, record: CacheRecord) => void | Promise<void>;
  /** Drop a key's record — the unit of invalidation. */
  delete: (key: string) => void | Promise<void>;
  /** Drop every record. */
  clear: () => void | Promise<void>;
}

export interface CacheOptions {
  /**
   * Where cached records live. Defaults to a bounded in-memory LRU keyed by
   * object key (see {@link CacheOptions.maxEntries}). Pass a {@link CacheStore}
   * to back the cache with your own KV — shared across instances/processes.
   * A custom store requires a {@link CacheOptions.namespace}.
   */
  store?: CacheStore;
  /**
   * The name that scopes this cache's entries inside a shared
   * {@link CacheOptions.store}, alongside the instance `prefix`. Required with a
   * custom `store` (`cache()` throws `Invalid` without one): the plugin can't
   * tell which bucket an adapter points at, so it can't keep two buckets'
   * entries apart on its own. Every `cache()` that shares a store **and** a
   * namespace (and the same `prefix`) serves the others' cached bytes, URLs,
   * and metadata, so give each bucket its own (e.g. `"uploads-prod"`), and
   * reuse one only across instances or processes that address the same bucket.
   * Instances with different `prefix`es stay apart even under one namespace.
   */
  namespace?: string;
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
  /**
   * The signature lifetime (in seconds) assumed for a `url()` call that omits
   * `expiresIn`. The adapter signs such calls with its own default, which the
   * plugin can't see — so cached entries are capped at this value to keep the
   * "never served past its signature" guarantee. Defaults to `3600` (the
   * SDK-wide default URL expiry); set it to match your adapter when you've
   * configured a different `defaultUrlExpiresIn` there.
   */
  defaultUrlExpiresIn?: number;
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
   * stale reads. With no `key` it calls the store's `clear()`, so on a shared
   * {@link CacheOptions.store} it drops every namespace's entries, not only
   * this instance's.
   */
  invalidateCache: (key?: string) => Promise<void>;
  /** A fresh snapshot of cache hit/miss counts since construction (or last reset). */
  cacheStats: () => CacheStats;
  /** Zero the hit/miss counters, starting a fresh accounting window. */
  resetCacheStats: () => void;
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
        // SAFETY: the loop only runs while the map is non-empty, so the oldest
        // key (insertion-order first) is always present.
        map.delete(map.keys().next().value as string);
      }
    },
  };
};

/**
 * Pull the cacheable {@link FileInfo} off a `head` or `download` result, with
 * its own copy of the `metadata` object — the caller keeps the original, and
 * mutating it must not reach the cached record.
 */
const metaOf = (file: FileInfo): FileInfo => ({
  contentType: file.contentType,
  key: file.key,
  size: file.size,
  ...(file.lastModified !== undefined && { lastModified: file.lastModified }),
  ...(file.etag !== undefined && { etag: file.etag }),
  ...(file.metadata !== undefined && { metadata: { ...file.metadata } }),
});

/**
 * A fresh copy of cached metadata for one hit. Every hit gets its own
 * `metadata` object, so a caller mutating one read can't corrupt the next.
 */
const cloneMeta = (meta: FileInfo): FileInfo => ({
  ...meta,
  ...(meta.metadata !== undefined && { metadata: { ...meta.metadata } }),
});

/** Query parameters that carry a presigned URL's lifetime, in seconds. */
const SIGNED_LIFETIME_PARAMS = ["X-Amz-Expires", "X-Goog-Expires"];
const DIGITS = /^\d+$/u;

/**
 * The lifetime (ms) a presigned URL declares for itself — `X-Amz-Expires` (S3
 * and every S3-compatible adapter) or `X-Goog-Expires` (GCS V4), both seconds
 * from signing — or `undefined` when it carries neither. Lets the expiry cap
 * follow what was actually signed when something inside the plugin (e.g.
 * `signedUrlPolicy()`) shortened the requested `expiresIn`.
 */
const signedLifetimeMs = (url: string): number | undefined => {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return;
  }
  for (const name of SIGNED_LIFETIME_PARAMS) {
    const raw = params.get(name);
    if (raw !== null && DIGITS.test(raw)) {
      return Number(raw) * 1000;
    }
  }
};

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
 * The store-key prefix for one namespace and instance `prefix`. Both parts are
 * percent-encoded so neither can contain the `/` separators, which keeps the
 * mapping unambiguous whatever the caller-facing key holds.
 */
const scopeOf = (namespace: string, prefix: string): string =>
  `${encodeURIComponent(namespace)}/${encodeURIComponent(prefix)}/`;

/**
 * An LRU/KV cache in front of the cheap read verbs — `head`, `url`, and
 * (opt-in) small `download` bodies. A repeat read of an unchanged key is served
 * from memory instead of round-tripping to the provider; any write through the
 * instance (`upload`, `delete`, `copy`, `move`) invalidates the affected key so
 * the next read re-fetches.
 *
 * What's cached, and how it stays correct:
 * - **`head`** caches the {@link FileInfo} it returns — metadata only, no
 *   body — and a hit hands out a fresh copy of it.
 * - **`url`** caches the returned string per url-options signature, and **caps
 *   each entry at its own `expiresIn`** so a presigned URL is never handed out
 *   past its signature. A call without `expiresIn` is capped at
 *   {@link CacheOptions.defaultUrlExpiresIn} (default `3600`, the SDK-wide
 *   default) — lower it to match an adapter configured with a shorter
 *   `defaultUrlExpiresIn`. When the URL states its own lifetime
 *   (`X-Amz-Expires`, `X-Goog-Expires`) and it's shorter, that wins. Keep
 *   {@link CacheOptions.ttl} well below your URL expiry.
 * - **`download`** is **off by default** — add `"download"` to
 *   {@link CacheOptions.operations}. Even then only **known-length bodies at or
 *   under {@link CacheOptions.maxBytes}** are buffered and cached; anything
 *   larger or of unknown length streams through untouched, so streaming and
 *   range downloads keep working. A cached small body is re-served as a fresh,
 *   re-readable `StoredFile`.
 *
 * Invalidation is by **caller-facing key** (never the internal prefixed path):
 * `upload`/`delete` drop that key, `copy` drops the destination, `move` drops
 * both — before the write and again after it settles, failed writes included
 * (a timed-out write may still have landed). A read miss that overlaps a
 * write to its key returns what it fetched but never caches it, so a slow
 * read can't re-populate the bytes a write just replaced. A provider storage event from `files-sdk/events` (an upload through a
 * presigned URL, a write by another process) drops its key too, when the
 * instance has `events()` wired to a feed. Writes the plugin can't observe at
 * all won't invalidate; call `files.invalidateCache(key)` (or
 * `invalidateCache()` to clear all) when that happens, and treat a cache as
 * eventually-consistent. It writes **no object metadata** and has **no native
 * dependencies**, so it works on any adapter.
 *
 * Entries are scoped to the instance: the store key carries the instance
 * `prefix` (and, with a shared {@link CacheOptions.store}, the required
 * {@link CacheOptions.namespace}), so tenants that differ by `prefix` never see
 * each other's entries. One `cache()` serves one {@link Files} instance (and
 * its {@link Files.readonly} views); passing the same `cache()` to an instance
 * with another adapter or `prefix` throws `Invalid` at construction. To share
 * entries between instances, give each its own `cache()` with the same `store`
 * and `namespace`.
 *
 * Plugins run **outside** retries, so a cache hit skips the retry loop entirely
 * and a populated entry reflects one logical, post-retry result. Place `cache()`
 * **first** (outermost) so it short-circuits before the rest of the pipeline
 * does any work; place it after a body-transforming plugin (`encryption()`,
 * `compression()`) only if you intend to cache the transformed bytes. The one
 * plugin that belongs **before** it is `signedUrlPolicy()`: plugins run in
 * array order, so a policy placed after `cache()` rewrites `url()` options the
 * cache never sees — it would key and cap the entry by the caller's
 * `expiresIn` rather than the shorter one actually signed (only S3-style and
 * GCS URLs, which state their own lifetime, are caught regardless). Use
 * `plugins: [signedUrlPolicy({ maxExpiresIn }), cache()]`.
 *
 * It uses `extend` (for `invalidateCache()` / `cacheStats()` / `resetCacheStats()`),
 * so reach for {@link createFiles} to surface those on the type.
 *
 * @param options optional `{ store, namespace, ttl, operations, maxBytes,
 *   maxEntries, clock, defaultUrlExpiresIn }`.
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
  const { namespace } = options;
  if (namespace !== undefined && !isString(namespace)) {
    throw new FilesError("Invalid", "cache: `namespace` must be a string");
  }
  if (
    options.store !== undefined &&
    (namespace === undefined || namespace === "")
  ) {
    throw new FilesError(
      "Invalid",
      "cache: a custom `store` needs a `namespace` — every cache() sharing a store and namespace serves the others' cached bytes, and the plugin can't tell which bucket an adapter points at; name the bucket (e.g. `namespace: \"uploads-prod\"`)"
    );
  }
  const ttl = options.ttl ?? DEFAULT_TTL;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const defaultUrlExpiresIn =
    options.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;
  const clock = options.clock ?? Date.now;
  const store =
    options.store ??
    createMemoryStore(options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const enabled = new Set(options.operations ?? DEFAULT_OPERATIONS);

  const stats: CacheStats = { hits: 0, misses: 0 };

  // The instance this plugin serves, bound in `extend` (the only hook that sees
  // it). `wrap` can't tell instances apart, so one plugin object serving two
  // scopes would key both by whichever bound last — refused in `extend`.
  let bound: { adapter: Adapter; prefix: string } | undefined;
  let scope = scopeOf(namespace ?? "", "");
  /** The store key for a caller-facing key, scoped to the bound instance. */
  const keyOf = (key: string): string => `${scope}${key}`;

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

  /**
   * Per-store-key write counters, held only while a read miss of that key is
   * in flight — so the map is bounded by concurrent reads, not by every key
   * ever written. A write bumps the counter before and after it runs; a read
   * that sees it move never records what it fetched, which may predate the
   * write.
   */
  const inFlight = new Map<string, { reads: number; writes: number }>();

  /** Note a write to `storeKey` for any read miss of it still in flight. */
  const noteWrite = (storeKey: string): void => {
    const entry = inFlight.get(storeKey);
    if (entry) {
      entry.writes += 1;
    }
  };

  /**
   * Run a read miss and record what it fetched — unless a write to the same
   * key started or finished meanwhile. A slow `download("k")` would otherwise
   * store the bytes it read *before* an `upload("k")` landed and invalidated,
   * and serve that stale body for the full `ttl`. `run` fetches and returns
   * the caller's value plus the record update (none to skip caching); a write
   * that races the store round-trip itself has the record dropped again.
   */
  const watchedMiss = async <T>(
    key: string,
    run: () => Promise<{
      value: T;
      update?: (prev: CacheRecord) => CacheRecord;
    }>
  ): Promise<T> => {
    const storeKey = keyOf(key);
    const watched = inFlight.get(storeKey) ?? { reads: 0, writes: 0 };
    inFlight.set(storeKey, watched);
    watched.reads += 1;
    const start = watched.writes;
    try {
      const { update, value } = await run();
      if (update && watched.writes === start) {
        await putRecord(storeKey, update);
        // A write that began during the store round-trip may have dropped
        // the record before this set landed.
        if (watched.writes !== start) {
          await store.delete(storeKey);
        }
      }
      return value;
    } finally {
      watched.reads -= 1;
      if (watched.reads === 0) {
        inFlight.delete(storeKey);
      }
    }
  };

  /**
   * Drop the records of `keys`, noting the write for any read miss of them in
   * flight. `quiet` swallows the store's own failure, for the paths where the
   * caller must see the mutation's outcome, never a store hiccup.
   */
  const drop = async (
    keys: readonly string[],
    quiet: boolean
  ): Promise<void> => {
    await Promise.all(
      keys.map(async (key) => {
        const storeKey = keyOf(key);
        noteWrite(storeKey);
        try {
          await store.delete(storeKey);
        } catch (error) {
          if (!quiet) {
            throw error;
          }
        }
      })
    );
  };

  /**
   * Run a mutation with `keys` invalidated on both sides of it. Before it
   * runs, best-effort, so a record can't outlive a write whose process dies
   * before the second drop. After it settles — whether it succeeded or failed,
   * since a timed-out or otherwise failed write may still have landed — on
   * `failureKeys` when it failed (a conditional copy's rejected *source*
   * ETag is stale too). Only the success path lets a store failure surface:
   * a failed mutation's own error is the outcome the caller must see (a
   * `Conflict` is what drives a head() → retry loop).
   */
  const invalidating = async <T>(
    keys: readonly string[],
    failureKeys: readonly string[],
    run: () => Promise<T>
  ): Promise<T> => {
    await drop(keys, true);
    let result: T;
    try {
      result = await run();
    } catch (error) {
      await drop(failureKeys, true);
      throw error;
    }
    await drop(keys, false);
    return result;
  };

  const cachedHead = async (
    op: Extract<FilesOperation, { kind: "head" }>,
    next: PluginNext
  ): Promise<FileInfo> => {
    const now = clock();
    const record = await store.get(keyOf(op.key));
    const entry = record?.head;
    if (entry && entry.expiresAt > now) {
      stats.hits += 1;
      return cloneMeta(entry.meta);
    }
    stats.misses += 1;
    return watchedMiss(op.key, async () => {
      const file = await next(op);
      const meta = metaOf(file);
      return {
        update: (prev) => ({
          ...prev,
          head: { expiresAt: expiryFrom(now), meta },
        }),
        value: file,
      };
    });
  };

  const cachedUrl = async (
    op: Extract<FilesOperation, { kind: "url" }>,
    next: PluginNext
  ): Promise<string> => {
    const signature = urlSignature(op.options);
    const now = clock();
    const record = await store.get(keyOf(op.key));
    const entry = record?.urls?.[signature];
    if (entry && entry.expiresAt > now) {
      stats.hits += 1;
      return entry.value;
    }
    stats.misses += 1;
    return watchedMiss(op.key, async () => {
      const value = await next(op);
      // The signature-lifetime cap must apply even when the caller omits
      // `expiresIn` — the adapter still signs with a finite default — or a
      // long/disabled `ttl` would keep serving the URL past its signature.
      // When the URL states its own lifetime, a shorter one (an inner plugin
      // clamped the request) wins.
      const capMs = Math.min(
        (op.options?.expiresIn ?? defaultUrlExpiresIn) * 1000,
        signedLifetimeMs(value) ?? Number.POSITIVE_INFINITY
      );
      return {
        update: (prev) => ({
          ...prev,
          urls: {
            ...prev.urls,
            [signature]: { expiresAt: expiryFrom(now, capMs), value },
          },
        }),
        value,
      };
    });
  };

  const cachedDownload = async (
    op: Extract<FilesOperation, { kind: "download" }>,
    next: PluginNext
  ): Promise<StoredFile> => {
    const signature = rangeSignature(op.options?.range);
    const now = clock();
    const record = await store.get(keyOf(op.key));
    const entry = record?.downloads?.[signature];
    if (entry && entry.expiresAt > now) {
      stats.hits += 1;
      // Hand out copies: `stream()` enqueues the buffer itself, so a consumer
      // mutating a chunk would otherwise rewrite every later hit.
      return createStoredFile(cloneMeta(entry.meta), {
        data: new Uint8Array(entry.bytes),
        kind: "buffer",
      });
    }
    stats.misses += 1;
    return watchedMiss(op.key, async () => {
      const file = await next(op);
      // Buffering an unknown-length or large body would break streaming, so
      // only small, known-length responses are cached — the rest passes
      // through as-is.
      if (!isNumber(file.size) || file.size > maxBytes) {
        return { value: file };
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const meta = metaOf(file);
      return {
        // The cache keeps its own copy, so the caller's bytes stay theirs to
        // mutate.
        update: (prev) => ({
          ...prev,
          downloads: {
            ...prev.downloads,
            [signature]: {
              bytes: new Uint8Array(bytes),
              expiresAt: expiryFrom(now),
              meta,
            },
          },
        }),
        value: createStoredFile(cloneMeta(meta), {
          data: bytes,
          kind: "buffer",
        }),
      };
    });
  };

  // SAFETY: the engine folds `wrap` over the erased `FilesOperation` union and
  // re-narrows the result per call; every branch below resolves with the value
  // the matching verb's `next` produces (or a cached copy of the same type),
  // so the non-generic function satisfies the generic `wrap` at each verb.
  const wrap = (async (
    op: FilesOperation,
    next: PluginNext
  ): Promise<OperationResult<FilesOperation>> => {
    switch (op.kind) {
      case "head": {
        return enabled.has("head") ? cachedHead(op, next) : next(op);
      }
      case "url": {
        return enabled.has("url") ? cachedUrl(op, next) : next(op);
      }
      case "download": {
        // An exact read is a provider precondition, not a cache validator. A
        // cached body may predate the supplied ETag (or have no trustworthy
        // relationship to it), so always drive the native conditional read
        // and never populate the ordinary download cache from its result. A
        // rejected predicate does prove the cached record stale, though, so
        // it invalidates like a failed conditional write would.
        if (isConditionalOperation(op)) {
          try {
            return await next(op);
          } catch (error) {
            await drop([op.key], true);
            throw error;
          }
        }
        return enabled.has("download") ? cachedDownload(op, next) : next(op);
      }
      // Writes always invalidate, regardless of which reads are cached — drop
      // the affected key(s) before and after the mutation, and after a failed
      // one too (see `invalidating`).
      case "upload":
      case "delete": {
        return invalidating([op.key], [op.key], () => next(op));
      }
      case "copy": {
        // A conditional copy can fail on its *source* predicate too, so a
        // stale cached source ETag would replay the same conflict; drop both
        // ends on a failure. Otherwise only `op.to` changes.
        const failureKeys = isConditionalOperation(op)
          ? [op.from, op.to]
          : [op.to];
        return invalidating([op.to], failureKeys, () => next(op));
      }
      case "move": {
        const keys = [op.from, op.to];
        return invalidating(keys, keys, () => next(op));
      }
      default: {
        return next(op);
      }
    }
  }) as NonNullable<FilesPlugin["wrap"]>;

  /**
   * Drop a key's record from a synchronous hook. A sync store has dropped it by
   * the time this returns; an async store's delete settles shortly after, and
   * its failure is swallowed — an event is only a hint, never the caller's op.
   */
  const dropQuietly = async (key: string): Promise<void> => {
    try {
      // Called synchronously up to its first `await`, so a sync store's
      // delete lands before the event moves on.
      await store.delete(keyOf(key));
    } catch {
      // A store hiccup must not break event delivery.
    }
  };

  return {
    // A provider event means the object changed behind the instance's back (a
    // presigned upload, another process, a lifecycle rule) — drop its record so
    // the next read re-fetches. The event itself passes through untouched.
    event: (event) => {
      // Fire-and-forget: the hook is synchronous, and `dropQuietly` never
      // rejects.
      void dropQuietly(event.key);
      return event;
    },
    extend: (files) => {
      const { adapter, prefix } = files;
      // A read-only view re-runs `extend` with the same adapter and prefix,
      // which is fine; anything else would share one wrap (and store) across
      // two scopes and serve one instance's entries to the other.
      if (bound && (bound.adapter !== adapter || bound.prefix !== prefix)) {
        throw new FilesError(
          "Invalid",
          "cache: this cache() is already installed on a Files instance with a different adapter or prefix, and sharing it would serve one instance's cached entries to the other; create a cache() per instance (pass the same `store` and `namespace` to share entries)"
        );
      }
      bound = { adapter, prefix };
      scope = scopeOf(namespace ?? "", prefix);
      return {
        cacheStats: () => ({ ...stats }),
        invalidateCache: async (key?: string) => {
          if (key === undefined) {
            await store.clear();
            return;
          }
          await store.delete(keyOf(key));
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
