import { describe, expect, test } from "bun:test";

import { cache } from "../src/cache/index.js";
import type {
  CacheOptions,
  CacheRecord,
  CacheStore,
} from "../src/cache/index.js";
import { createFiles } from "../src/index.js";
import type {
  Adapter,
  DownloadOptions,
  Files,
  OperationOptions,
  UploadOptions,
  UrlOptions,
} from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

// Wrap an adapter and record the keys each read/write verb is called with.
const counting = (inner: Adapter = fakeAdapter()) => {
  const calls = {
    delete: [] as string[],
    download: [] as string[],
    head: [] as string[],
    upload: [] as string[],
    url: [] as string[],
  };
  const adapter: Adapter = {
    ...inner,
    delete: (key: string, opts?: OperationOptions) => {
      calls.delete.push(key);
      return inner.delete(key, opts);
    },
    download: (key: string, opts?: DownloadOptions) => {
      calls.download.push(key);
      return inner.download(key, opts);
    },
    head: (key: string, opts?: OperationOptions) => {
      calls.head.push(key);
      return inner.head(key, opts);
    },
    upload: (key: string, body, opts?: UploadOptions) => {
      calls.upload.push(key);
      return inner.upload(key, body, opts);
    },
    url: (key: string, opts?: UrlOptions) => {
      calls.url.push(key);
      return inner.url(key, opts);
    },
  };
  return { adapter, calls };
};

const withCache = (
  options: CacheOptions = {},
  adapter: Adapter = fakeAdapter()
) => createFiles({ adapter, plugins: [cache(options)] });

const bodyOf = async (
  files: Files,
  key: string,
  opts?: DownloadOptions
): Promise<string> => {
  const file = await files.download(key, opts);
  return file.text();
};

const sizeOf = async (files: Files, key: string): Promise<number> => {
  const head = await files.head(key);
  return head.size;
};

const countKey = (keys: string[], key: string): number =>
  keys.filter((k) => k === key).length;

describe("cache plugin — head", () => {
  test("serves head metadata from the cache on the second call", async () => {
    const { adapter, calls } = counting();
    const files = withCache({}, adapter);
    await files.upload("a.txt", "hello");

    const first = await files.head("a.txt");
    const second = await files.head("a.txt");

    // Provider was hit exactly once.
    expect(calls.head).toEqual(["a.txt"]);
    expect(second.size).toBe(first.size);
    expect(second.etag).toBe(first.etag);
  });

  test("a head cache hit lazy-fetches its body via download", async () => {
    const { adapter, calls } = counting();
    const files = withCache({}, adapter);
    await files.upload("a.txt", "hello", { metadata: { tag: "x" } });

    await files.head("a.txt");
    const hit = await files.head("a.txt");

    expect(hit.metadata).toEqual({ tag: "x" });
    // The body isn't fetched until a body accessor is called.
    expect(calls.download).toEqual([]);
    expect(await hit.text()).toBe("hello");
    expect(calls.download).toEqual(["a.txt"]);
  });

  test("does not cache head when it is not in operations", async () => {
    const { adapter, calls } = counting();
    const files = withCache({ operations: ["url"] }, adapter);
    await files.upload("a.txt", "hello");

    await files.head("a.txt");
    await files.head("a.txt");

    expect(calls.head).toEqual(["a.txt", "a.txt"]);
  });
});

describe("cache plugin — url", () => {
  test("serves a url from the cache on the second call", async () => {
    const { adapter, calls } = counting();
    const files = withCache({}, adapter);
    await files.upload("a.txt", "hello");

    const first = await files.url("a.txt");
    const second = await files.url("a.txt");

    expect(calls.url).toEqual(["a.txt"]);
    expect(second).toBe(first);
  });

  test("caches url variants separately by their options", async () => {
    const { adapter, calls } = counting();
    const files = withCache({}, adapter);
    await files.upload("a.txt", "hello");

    await files.url("a.txt");
    await files.url("a.txt", { expiresIn: 60 });
    // Repeats of each variant are served from cache.
    await files.url("a.txt");
    await files.url("a.txt", { expiresIn: 60 });

    expect(calls.url).toHaveLength(2);
  });

  test("caps a cached url at its own expiresIn", async () => {
    let now = 1000;
    const { adapter, calls } = counting();
    // A long ttl, but the URL only signs for 1s — the cap wins.
    const files = withCache({ clock: () => now, ttl: 60_000 }, adapter);
    await files.upload("a.txt", "hello");

    await files.url("a.txt", { expiresIn: 1 });
    now += 1500;
    await files.url("a.txt", { expiresIn: 1 });

    expect(calls.url).toHaveLength(2);
  });
});

describe("cache plugin — download", () => {
  test("caches small download bodies when enabled", async () => {
    const { adapter, calls } = counting();
    const files = withCache({ operations: ["download"] }, adapter);
    await files.upload("a.txt", "hello");

    expect(await bodyOf(files, "a.txt")).toBe("hello");
    expect(await bodyOf(files, "a.txt")).toBe("hello");

    expect(calls.download).toEqual(["a.txt"]);
  });

  test("is off by default", async () => {
    const { adapter, calls } = counting();
    const files = withCache({}, adapter);
    await files.upload("a.txt", "hello");

    await files.download("a.txt");
    await files.download("a.txt");

    expect(calls.download).toEqual(["a.txt", "a.txt"]);
  });

  test("streams large bodies through uncached", async () => {
    const { adapter, calls } = counting();
    const files = withCache({ maxBytes: 4, operations: ["download"] }, adapter);
    // 11 bytes, over the 4-byte ceiling.
    await files.upload("big.txt", "hello world");

    expect(await bodyOf(files, "big.txt")).toBe("hello world");
    expect(await bodyOf(files, "big.txt")).toBe("hello world");

    expect(calls.download).toEqual(["big.txt", "big.txt"]);
  });

  test("caches each byte range separately", async () => {
    const { adapter, calls } = counting(fakeAdapter({ supportsRange: true }));
    const files = withCache({ operations: ["download"] }, adapter);
    await files.upload("a.txt", "hello");

    const range: DownloadOptions = { range: { end: 1, start: 0 } };
    expect(await bodyOf(files, "a.txt", range)).toBe("he");
    expect(await bodyOf(files, "a.txt", range)).toBe("he");
    expect(await bodyOf(files, "a.txt")).toBe("hello");

    // The ranged read and the full read each hit the provider once.
    expect(calls.download).toEqual(["a.txt", "a.txt"]);
  });
});

describe("cache plugin — invalidation", () => {
  test("upload invalidates the cached read", async () => {
    const { adapter, calls } = counting();
    const files = withCache({}, adapter);
    await files.upload("a.txt", "hello");

    expect(await sizeOf(files, "a.txt")).toBe(5);
    await files.upload("a.txt", "hi");
    expect(await sizeOf(files, "a.txt")).toBe(2);

    expect(calls.head).toEqual(["a.txt", "a.txt"]);
  });

  test("delete invalidates the cached read", async () => {
    const files = withCache();
    await files.upload("a.txt", "hello");
    await files.head("a.txt");
    await files.delete("a.txt");

    await expect(files.head("a.txt")).rejects.toThrow(/not found/u);
  });

  test("copy invalidates the destination", async () => {
    const files = withCache();
    await files.upload("a.txt", "AAA");
    await files.upload("b.txt", "B");
    // Cache b at size 1.
    await files.head("b.txt");

    await files.copy("a.txt", "b.txt");
    expect(await sizeOf(files, "b.txt")).toBe(3);
  });

  test("move invalidates both source and destination", async () => {
    const files = withCache();
    await files.upload("a.txt", "AAA");
    await files.upload("b.txt", "BBB");
    await files.head("a.txt");
    await files.head("b.txt");

    await files.move("a.txt", "b.txt");

    expect(await sizeOf(files, "b.txt")).toBe(3);
    await expect(files.head("a.txt")).rejects.toThrow(/not found/u);
  });
});

describe("cache plugin — passthrough", () => {
  test("passes exists / list / signedUploadUrl straight through", async () => {
    const files = withCache();
    await files.upload("a.txt", "hello");

    expect(await files.exists("a.txt")).toBe(true);
    const list = await files.list();
    expect(list.items.map((f) => f.key)).toEqual(["a.txt"]);
    const signed = await files.signedUploadUrl("a.txt", { expiresIn: 60 });
    expect(signed.url).toBeDefined();
  });
});

describe("cache plugin — stats and manual invalidation", () => {
  test("tracks hits and misses, and resets them", async () => {
    const files = withCache();
    await files.upload("a.txt", "hello");

    await files.head("a.txt");
    await files.head("a.txt");
    await files.url("a.txt");

    expect(files.cacheStats()).toEqual({ hits: 1, misses: 2 });

    files.resetCacheStats();
    expect(files.cacheStats()).toEqual({ hits: 0, misses: 0 });
  });

  test("invalidateCache(key) drops one key", async () => {
    const { adapter, calls } = counting();
    const files = withCache({}, adapter);
    await files.upload("a.txt", "hello");

    await files.head("a.txt");
    await files.invalidateCache("a.txt");
    await files.head("a.txt");

    expect(calls.head).toEqual(["a.txt", "a.txt"]);
  });

  test("invalidateCache() clears the whole cache", async () => {
    const { adapter, calls } = counting();
    const files = withCache({}, adapter);
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");

    await files.head("a.txt");
    await files.head("b.txt");
    await files.invalidateCache();
    await files.head("a.txt");
    await files.head("b.txt");

    expect(calls.head).toEqual(["a.txt", "b.txt", "a.txt", "b.txt"]);
  });
});

describe("cache plugin — ttl", () => {
  test("expires entries after the ttl elapses", async () => {
    let now = 0;
    const { adapter, calls } = counting();
    const files = withCache({ clock: () => now, ttl: 1000 }, adapter);
    await files.upload("a.txt", "hello");

    await files.head("a.txt");
    now = 999;
    await files.head("a.txt");
    now = 1001;
    await files.head("a.txt");

    expect(calls.head).toEqual(["a.txt", "a.txt"]);
  });

  test("ttl <= 0 disables time-based expiry", async () => {
    let now = 0;
    const { adapter, calls } = counting();
    const files = withCache({ clock: () => now, ttl: 0 }, adapter);
    await files.upload("a.txt", "hello");

    await files.head("a.txt");
    now = 10_000_000;
    await files.head("a.txt");

    expect(calls.head).toEqual(["a.txt"]);
  });
});

describe("cache plugin — in-memory LRU", () => {
  test("evicts the least-recently-used key past maxEntries", async () => {
    const { adapter, calls } = counting();
    const files = withCache({ maxEntries: 2 }, adapter);
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    await files.upload("c.txt", "3");

    await files.head("a.txt");
    await files.head("b.txt");
    // Re-reading a bumps it ahead of b, so the next insert evicts b, not a.
    await files.head("a.txt");
    await files.head("c.txt");
    await files.head("a.txt");
    await files.head("b.txt");

    expect(countKey(calls.head, "a.txt")).toBe(1);
    expect(countKey(calls.head, "b.txt")).toBe(2);
  });
});

describe("cache plugin — custom store", () => {
  test("routes through a provided store", async () => {
    const map = new Map<string, CacheRecord>();
    const seen = { cleared: false, deleted: 0, gets: 0, sets: 0 };
    const store: CacheStore = {
      clear: () => {
        seen.cleared = true;
        map.clear();
      },
      delete: (key) => {
        seen.deleted += 1;
        map.delete(key);
      },
      get: (key) => {
        seen.gets += 1;
        return Promise.resolve(map.get(key));
      },
      set: (key, record) => {
        seen.sets += 1;
        map.set(key, record);
      },
    };
    const { adapter, calls } = counting();
    const files = withCache({ store }, adapter);
    await files.upload("a.txt", "hello");

    await files.head("a.txt");
    await files.head("a.txt");
    await files.invalidateCache();

    expect(calls.head).toEqual(["a.txt"]);
    expect(seen.sets).toBeGreaterThan(0);
    expect(seen.gets).toBeGreaterThan(0);
    expect(seen.deleted).toBeGreaterThan(0);
    expect(seen.cleared).toBe(true);
  });
});
