import { describe, expect, test } from "bun:test";

import { cache } from "../src/cache/index.js";
import type {
  CacheOptions,
  CacheRecord,
  CacheStore,
} from "../src/cache/index.js";
import { createFiles, createStoredFile, FilesError } from "../src/index.js";
import type {
  Adapter,
  ConditionalFilesOperation,
  DownloadOptions,
  FileEvent,
  Files,
  OperationOptions,
  PluginNext,
  StoredFile,
  UploadOptions,
  UrlOptions,
} from "../src/index.js";
import { FOLD_PROVIDER_EVENT } from "../src/internal/events.js";
import { memory as memoryAdapter } from "../src/memory/index.js";
import { signedUrlPolicy } from "../src/signed-url-policy/index.js";
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

  test("a head cache hit is plain metadata and never downloads", async () => {
    const { adapter, calls } = counting();
    const files = withCache({}, adapter);
    await files.upload("a.txt", "hello", {
      contentType: "text/plain",
      metadata: { tag: "x" },
    });

    const miss = await files.head("a.txt");
    const hit = await files.head("a.txt");

    expect(hit).toEqual(miss);
    expect(Object.keys(hit).toSorted()).toEqual([
      "contentType",
      "etag",
      "key",
      "lastModified",
      "metadata",
      "size",
    ]);
    expect(hit).toMatchObject({
      contentType: "text/plain",
      key: "a.txt",
      metadata: { tag: "x" },
      size: 5,
    });
    expect(calls.download).toEqual([]);
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

  test("caps a url cached without expiresIn at the default signature lifetime", async () => {
    let now = 1000;
    const { adapter, calls } = counting();
    // ttl 0 disables time-based expiry — but the adapter still signed with a
    // finite default, so the entry must not outlive that signature.
    const files = withCache({ clock: () => now, ttl: 0 }, adapter);
    await files.upload("a.txt", "hello");

    await files.url("a.txt");
    now += 3600 * 1000 + 1;
    await files.url("a.txt");

    expect(calls.url).toHaveLength(2);
  });

  test("the assumed default signature lifetime is configurable", async () => {
    let now = 1000;
    const { adapter, calls } = counting();
    // The adapter is configured to sign 10s URLs by default — tell the cache.
    const files = withCache(
      { clock: () => now, defaultUrlExpiresIn: 10, ttl: 60_000 },
      adapter
    );
    await files.upload("a.txt", "hello");

    await files.url("a.txt");
    now += 10_001;
    await files.url("a.txt");

    expect(calls.url).toHaveLength(2);
  });
});

describe("cache plugin — url signed lifetime", () => {
  // An adapter whose URLs state their own lifetime the way S3/GCS presigned
  // URLs do.
  const selfDescribing = (param: string, base = "https://bucket.local/") => {
    const inner = fakeAdapter();
    return counting({
      ...inner,
      url: (key: string, opts?: UrlOptions) =>
        Promise.resolve(`${base}${key}?${param}=${opts?.expiresIn ?? 3600}`),
    });
  };

  test("caps an entry at the lifetime an inner signedUrlPolicy() applied", async () => {
    let now = 1000;
    const { adapter, calls } = selfDescribing("X-Amz-Expires");
    // cache() outside the policy never sees the clamped expiresIn, but the
    // URL itself says it was signed for 60s.
    const files = createFiles({
      adapter,
      plugins: [
        cache({ clock: () => now, ttl: 0 }),
        signedUrlPolicy({ maxExpiresIn: 60 }),
      ],
    });
    await files.upload("a.txt", "hello");

    const first = await files.url("a.txt", { expiresIn: 3600 });
    expect(first).toContain("X-Amz-Expires=60");
    now += 59_000;
    await files.url("a.txt", { expiresIn: 3600 });
    expect(calls.url).toHaveLength(1);
    now += 1001;
    await files.url("a.txt", { expiresIn: 3600 });
    expect(calls.url).toHaveLength(2);
  });

  test("reads a GCS V4 X-Goog-Expires lifetime too", async () => {
    let now = 1000;
    const { adapter, calls } = selfDescribing("X-Goog-Expires");
    const files = withCache({ clock: () => now, ttl: 0 }, adapter);
    await files.upload("a.txt", "hello");

    await files.url("a.txt", { expiresIn: 5 });
    now += 5001;
    await files.url("a.txt", { expiresIn: 5 });
    expect(calls.url).toHaveLength(2);
  });

  test("a longer stated lifetime never extends the requested cap", async () => {
    let now = 1000;
    const inner = fakeAdapter();
    const { adapter, calls } = counting({
      ...inner,
      url: (key: string) =>
        Promise.resolve(`https://bucket.local/${key}?X-Amz-Expires=99999`),
    });
    const files = withCache({ clock: () => now, ttl: 0 }, adapter);
    await files.upload("a.txt", "hello");

    await files.url("a.txt", { expiresIn: 10 });
    now += 10_001;
    await files.url("a.txt", { expiresIn: 10 });
    expect(calls.url).toHaveLength(2);
  });

  test("ignores a malformed lifetime and a URL it can't parse", async () => {
    let now = 1000;
    const bad = selfDescribing("X-Amz-Expires", "not a url/");
    const files = withCache({ clock: () => now, ttl: 0 }, bad.adapter);
    await files.upload("a.txt", "hello");
    await files.url("a.txt", { expiresIn: 10 });
    now += 9000;
    await files.url("a.txt", { expiresIn: 10 });
    expect(bad.calls.url).toHaveLength(1);

    const inner = fakeAdapter();
    const odd = counting({
      ...inner,
      url: (key: string) =>
        Promise.resolve(`https://bucket.local/${key}?X-Amz-Expires=soon`),
    });
    const other = withCache({ clock: () => now, ttl: 0 }, odd.adapter);
    await other.upload("a.txt", "hello");
    await other.url("a.txt", { expiresIn: 10 });
    now += 9000;
    await other.url("a.txt", { expiresIn: 10 });
    expect(odd.calls.url).toHaveLength(1);
  });
});

// Read the first chunk a download's stream() hands out — the very buffer a
// consumer could mutate in place.
const firstChunk = async (file: StoredFile): Promise<Uint8Array> => {
  const reader = file.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return value ?? new Uint8Array(0);
};

describe("cache plugin — isolation between reads", () => {
  test("mutating a streamed chunk from a hit can't corrupt later hits", async () => {
    const files = withCache({ operations: ["download"] });
    await files.upload("a.txt", "hello");
    await files.download("a.txt");

    const hit = await files.download("a.txt");
    const chunk = await firstChunk(hit);
    chunk[0] = "X".codePointAt(0) ?? 0;
    expect(await bodyOf(files, "a.txt")).toBe("hello");
  });

  test("mutating the bytes of the populating read can't corrupt the cache", async () => {
    const files = withCache({ operations: ["download"] });
    await files.upload("a.txt", "hello");

    const populating = await files.download("a.txt");
    const chunk = await firstChunk(populating);
    chunk[0] = "X".codePointAt(0) ?? 0;
    expect(await bodyOf(files, "a.txt")).toBe("hello");
  });

  test("mutating metadata from a read can't corrupt later hits", async () => {
    // The memory adapter hands out its own copies, so any leak is the cache's.
    const files = withCache(
      { operations: ["head", "download"] },
      memoryAdapter()
    );
    await files.upload("a.txt", "hello", { metadata: { tag: "x" } });

    const populating = await files.head("a.txt");
    (populating.metadata ?? {}).tag = "miss";
    const hit = await files.head("a.txt");
    (hit.metadata ?? {}).tag = "hit";
    const again = await files.head("a.txt");
    expect(again.metadata).toEqual({ tag: "x" });

    const downloaded = await files.download("a.txt");
    (downloaded.metadata ?? {}).tag = "miss";
    const cached = await files.download("a.txt");
    (cached.metadata ?? {}).tag = "hit";
    const reread = await files.download("a.txt");
    expect(reread.metadata).toEqual({ tag: "x" });
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

  test("never serves or populates an exact read from the ordinary cache", async () => {
    const plugin = cache({ operations: ["download"] });
    const { wrap } = plugin;
    if (!wrap) {
      throw new Error("cache wrap missing");
    }
    let nextCalls = 0;
    const next = (() => {
      nextCalls += 1;
      const body = `version-${nextCalls}`;
      return Promise.resolve(
        createStoredFile(
          {
            contentType: "text/plain",
            etag: "etag-1",
            key: "a.txt",
            size: body.length,
          },
          { data: new TextEncoder().encode(body), kind: "buffer" }
        )
      );
    }) as PluginNext;
    const operation: Extract<ConditionalFilesOperation, { kind: "download" }> =
      {
        etag: "etag-1",
        key: "a.txt",
        kind: "download",
        mode: "exact",
      };

    const first = await wrap(operation, next);
    const second = await wrap(operation, next);

    expect(await first.text()).toBe("version-1");
    expect(await second.text()).toBe("version-2");
    expect(nextCalls).toBe(2);
  });
});

describe("cache plugin — invalidation", () => {
  test("a failed write still invalidates, so a stale ETag cannot poison a CAS retry loop", async () => {
    const inner = fakeAdapter();
    let generation = 0;
    const conditional: Adapter = {
      ...inner,
      conditional: {
        // Always reject: the caller's ETag is stale as far as the provider is
        // concerned, which is exactly the case where a cached head() must not
        // keep serving that ETag.
        replace: () =>
          Promise.reject(new FilesError("Conflict", "precondition failed")),
      },
      head: async (key, opts) => {
        generation += 1;
        const meta = await inner.head(key, opts);
        return { ...meta, etag: `gen-${generation}` };
      },
    };
    const files = createFiles({
      adapter: conditional,
      plugins: [cache({ ttl: 60_000 })],
    });
    await files.upload("doc.txt", "v1");
    const first = await files.head("doc.txt");
    // Served from the cache.
    const again = await files.head("doc.txt");
    expect(again.etag).toBe(first.etag);

    await expect(
      files.upload("doc.txt", "v2", {
        condition: { etag: first.etag as string, type: "replace" },
      })
    ).rejects.toMatchObject({ code: "Conflict" });

    // The conflict proved the cached record stale; the next head() must go to
    // the provider rather than replaying the ETag that just conflicted.
    const refreshed = await files.head("doc.txt");
    expect(refreshed.etag).not.toBe(first.etag);
  });

  test("a rejected exact read invalidates the cached record too", async () => {
    const inner = fakeAdapter();
    let generation = 0;
    const conditional: Adapter = {
      ...inner,
      conditional: {
        exactRead: () =>
          Promise.reject(new FilesError("Conflict", "precondition failed")),
      },
      head: async (key, opts) => {
        generation += 1;
        const meta = await inner.head(key, opts);
        return { ...meta, etag: `gen-${generation}` };
      },
    };
    const files = createFiles({
      adapter: conditional,
      plugins: [cache({ ttl: 60_000 })],
    });
    await files.upload("doc.txt", "v1");
    const first = await files.head("doc.txt");
    await expect(
      files.download("doc.txt", { condition: { etag: first.etag as string } })
    ).rejects.toMatchObject({ code: "Conflict" });
    const refreshed = await files.head("doc.txt");
    expect(refreshed.etag).not.toBe(first.etag);
  });

  test("a conditional copy that conflicts on its source invalidates the cached source", async () => {
    const inner = fakeAdapter();
    let generation = 0;
    const conditional: Adapter = {
      ...inner,
      conditional: {
        copy: {
          atomicSourceDestination: true,
          destinationCreate: true,
          destinationReplace: true,
          run: () =>
            Promise.reject(new FilesError("Conflict", "source ETag mismatch")),
          sourceEtag: true,
        },
      },
      head: async (key, opts) => {
        generation += 1;
        const meta = await inner.head(key, opts);
        return { ...meta, etag: `gen-${generation}` };
      },
    };
    const files = createFiles({
      adapter: conditional,
      plugins: [cache({ ttl: 60_000 })],
    });
    await files.upload("src.txt", "v1");
    const source = await files.head("src.txt");
    await expect(
      files.copy("src.txt", "dst.txt", {
        condition: {
          destination: { type: "create" },
          source: { etag: source.etag as string },
        },
      })
    ).rejects.toMatchObject({ code: "Conflict" });
    // The source's cached ETag is what just conflicted; it must not replay.
    const refreshed = await files.head("src.txt");
    expect(refreshed.etag).not.toBe(source.etag);
  });

  test("a store failure while invalidating after a conflict never masks the conflict", async () => {
    const inner = fakeAdapter();
    const conditional: Adapter = {
      ...inner,
      conditional: {
        replace: () =>
          Promise.reject(new FilesError("Conflict", "precondition failed")),
      },
    };
    const deletes: string[] = [];
    const memory = new Map<string, CacheRecord>();
    const store: CacheStore = {
      clear: () => memory.clear(),
      delete: (key) => {
        deletes.push(key);
        return Promise.reject(new Error("redis: connection reset"));
      },
      get: (key) => Promise.resolve(memory.get(key)),
      set: (key, entry) => {
        memory.set(key, entry);
        return Promise.resolve();
      },
    };
    const files = createFiles({
      adapter: conditional,
      plugins: [cache({ namespace: "test", store })],
    });
    await expect(files.upload("doc.txt", "v1")).rejects.toThrow(
      /connection reset/u
    );
    const { etag } = await files.head("doc.txt");
    await expect(
      files.upload("doc.txt", "v2", {
        condition: {
          etag: (etag as string).replaceAll('"', ""),
          type: "replace",
        },
      })
    ).rejects.toMatchObject({ code: "Conflict" });
    // The invalidation was attempted, but its failure stayed out of the way.
    expect(
      deletes.filter((key) => key === "test//doc.txt").length
    ).toBeGreaterThan(1);
  });

  test("a plain failed write still invalidates, since it may have landed", async () => {
    const inner = fakeAdapter();
    const flaky: Adapter = {
      ...inner,
      delete: () => Promise.reject(new Error("delete boom")),
    };
    const deletes: string[] = [];
    const memory = new Map<string, CacheRecord>();
    const store: CacheStore = {
      clear: () => memory.clear(),
      delete: (key) => {
        deletes.push(key);
        memory.delete(key);
        return Promise.resolve();
      },
      get: (key) => Promise.resolve(memory.get(key)),
      set: (key, entry) => {
        memory.set(key, entry);
        return Promise.resolve();
      },
    };
    const { adapter, calls } = counting(flaky);
    const files = createFiles({
      adapter,
      plugins: [cache({ namespace: "test", store })],
    });
    await files.upload("a.txt", "hello");
    await files.head("a.txt");
    deletes.length = 0;

    await expect(files.delete("a.txt")).rejects.toThrow(/delete boom/u);
    // Dropped before the attempt and again after it failed.
    expect(deletes).toEqual(["test//a.txt", "test//a.txt"]);
    await files.head("a.txt");
    expect(calls.head).toEqual(["a.txt", "a.txt"]);
  });

  test("a store failure before the write never blocks it", async () => {
    const memory = new Map<string, CacheRecord>();
    let failDeletes = false;
    const store: CacheStore = {
      clear: () => memory.clear(),
      delete: (key) => {
        if (failDeletes) {
          failDeletes = false;
          return Promise.reject(new Error("redis: connection reset"));
        }
        memory.delete(key);
        return Promise.resolve();
      },
      get: (key) => memory.get(key),
      set: (key, entry) => {
        memory.set(key, entry);
      },
    };
    const { adapter, calls } = counting();
    const files = createFiles({
      adapter,
      plugins: [cache({ namespace: "test", store })],
    });
    await files.upload("a.txt", "hello");
    await files.head("a.txt");
    // Only the first (pre-write) drop fails; the write and the second drop
    // still run.
    failDeletes = true;
    await files.upload("a.txt", "hi");
    expect(await sizeOf(files, "a.txt")).toBe(2);
    expect(calls.head).toEqual(["a.txt", "a.txt"]);
  });

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

type GatedVerb = "download" | "head" | "url";

/** Hold the next read of a verb until `release()`, to overlap it with a write. */
const gated = (inner: Adapter = fakeAdapter()) => {
  let holding: GatedVerb | undefined;
  let held = Promise.withResolvers<undefined>();
  let reached = Promise.withResolvers<undefined>();
  const wait = async <T>(verb: GatedVerb, value: T): Promise<T> => {
    if (holding !== verb) {
      return value;
    }
    holding = undefined;
    reached.resolve();
    await held.promise;
    return value;
  };
  const adapter: Adapter = {
    ...inner,
    download: async (key, opts) =>
      wait("download", await inner.download(key, opts)),
    head: async (key, opts) => wait("head", await inner.head(key, opts)),
    url: async (key, opts) => wait("url", await inner.url(key, opts)),
  };
  return {
    adapter,
    /** Hold the next `verb` read; resolves once it's in flight, holding. */
    hold: (verb: GatedVerb): Promise<void> => {
      holding = verb;
      held = Promise.withResolvers<undefined>();
      reached = Promise.withResolvers<undefined>();
      return reached.promise;
    },
    release: () => held.resolve(),
  };
};

describe("cache plugin — reads racing writes", () => {
  test("a read that fetched before a write landed never caches the old bytes", async () => {
    const gate = gated();
    const files = createFiles({
      adapter: gate.adapter,
      plugins: [cache({ operations: ["download"] })],
    });
    await files.upload("k", "v1");
    const holding = gate.hold("download");
    const slowRead = files.download("k");
    await holding;
    await files.upload("k", "v2");
    gate.release();
    // The overlapping read returns what it fetched...
    const overlapped = await slowRead;
    expect(await overlapped.text()).toBe("v1");
    // ...but the next read sees the write.
    expect(await bodyOf(files, "k")).toBe("v2");
  });

  test("a head miss overlapping a write isn't cached either", async () => {
    const gate = gated();
    const files = createFiles({
      adapter: gate.adapter,
      plugins: [cache()],
    });
    await files.upload("k", "one");
    const holding = gate.hold("head");
    const slowHead = files.head("k");
    await holding;
    await files.upload("k", "three");
    gate.release();
    const overlapped = await slowHead;
    expect(overlapped.size).toBe(3);
    expect(await sizeOf(files, "k")).toBe(5);
  });

  test("a url miss overlapping a write isn't cached, and later misses are", async () => {
    const { adapter, calls } = counting();
    const gate = gated(adapter);
    const files = createFiles({ adapter: gate.adapter, plugins: [cache()] });
    await files.upload("k", "one");
    const holding = gate.hold("url");
    const slowUrl = files.url("k");
    await holding;
    await files.upload("k", "two");
    gate.release();
    await slowUrl;
    await files.url("k");
    await files.url("k");
    // The raced miss, then one miss that populated, then a hit.
    expect(calls.url).toEqual(["k", "k"]);
  });

  test("a write racing the store round-trip has the record dropped again", async () => {
    const memory = new Map<string, CacheRecord>();
    let onSet: (() => Promise<void>) | undefined;
    const store: CacheStore = {
      clear: () => memory.clear(),
      delete: (key) => {
        memory.delete(key);
      },
      get: (key) => memory.get(key),
      set: async (key, entry) => {
        const hook = onSet;
        onSet = undefined;
        // The write lands (and drops the key) before this set does.
        await hook?.();
        memory.set(key, entry);
      },
    };
    const { adapter, calls } = counting();
    const files = createFiles({
      adapter,
      plugins: [cache({ namespace: "test", store })],
    });
    await files.upload("k", "one");
    onSet = async () => {
      await files.upload("k", "three");
    };
    const raced = await files.head("k");
    expect(raced.size).toBe(3);
    expect(memory.has("test//k")).toBe(false);
    expect(await sizeOf(files, "k")).toBe(5);
    expect(calls.head).toEqual(["k", "k"]);
  });

  test("concurrent misses of one key share their watch", async () => {
    const { adapter, calls } = counting();
    const files = createFiles({ adapter, plugins: [cache()] });
    await files.upload("k", "one");
    const sizes = await Promise.all([files.head("k"), files.head("k")]);
    expect(sizes.map((file) => file.size)).toEqual([3, 3]);
    await files.head("k");
    expect(calls.head).toEqual(["k", "k"]);
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
    const files = withCache({ namespace: "test", store }, adapter);
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

/** A Map-backed custom store, exposing the map to inspect its keys. */
const mapStore = (): CacheStore & { map: Map<string, CacheRecord> } => {
  const map = new Map<string, CacheRecord>();
  return {
    clear: () => map.clear(),
    delete: (key) => {
      map.delete(key);
    },
    get: (key) => map.get(key),
    map,
    set: (key, record) => {
      map.set(key, record);
    },
  };
};

const ALL_READS = ["head", "url", "download"] as const;

describe("cache plugin — scoping", () => {
  test("a custom store needs a namespace", () => {
    const store = mapStore();
    expect(() => cache({ store })).toThrow(
      expect.objectContaining({ code: "Invalid" })
    );
    expect(() => cache({ namespace: "", store })).toThrow(
      /needs a `namespace`/u
    );
    expect(() => cache({ namespace: 1 as unknown as string, store })).toThrow(
      /must be a string/u
    );
    // Without a custom store, a namespace is optional.
    expect(cache().name).toBe("cache");
  });

  test("tenants that differ by prefix never read each other's entries through a shared store", async () => {
    const adapter = memoryAdapter();
    const store = mapStore();
    const tenant = (prefix: string) =>
      createFiles({
        adapter,
        plugins: [
          cache({ namespace: "uploads", operations: ALL_READS, store }),
        ],
        prefix,
      });
    const a = tenant("tenants/a");
    const b = tenant("tenants/b");
    await a.upload("secret.txt", "A's secret");
    expect(await bodyOf(a, "secret.txt")).toBe("A's secret");
    await a.head("secret.txt");
    await a.url("secret.txt");

    await expect(b.download("secret.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
    await expect(b.head("secret.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
    // Every entry is scoped by the namespace and the (encoded) prefix.
    expect([...store.map.keys()]).toEqual(["uploads/tenants%2Fa/secret.txt"]);
  });

  test("instances sharing a store, namespace, and prefix share entries", async () => {
    const { adapter, calls } = counting();
    const store = mapStore();
    const make = () =>
      createFiles({
        adapter,
        plugins: [cache({ namespace: "uploads", store })],
        prefix: "p",
      });
    const first = make();
    const second = make();
    await first.upload("a.txt", "hello");
    await first.head("a.txt");
    await second.head("a.txt");
    expect(calls.head).toEqual(["p/a.txt"]);
    // A write through either instance invalidates for both.
    await second.upload("a.txt", "changed");
    expect(await sizeOf(first, "a.txt")).toBe(7);
    // And so does a manual invalidation, by the same scoped key.
    await first.invalidateCache("a.txt");
    await second.head("a.txt");
    expect(calls.head).toEqual(["p/a.txt", "p/a.txt", "p/a.txt"]);
  });

  test("different namespaces keep two buckets with the same keys apart", async () => {
    const store = mapStore();
    const bucket = (namespace: string) =>
      createFiles({
        adapter: fakeAdapter(),
        plugins: [cache({ namespace, operations: ALL_READS, store })],
      });
    const one = bucket("one");
    const two = bucket("two");
    await one.upload("a.txt", "from one");
    await two.upload("a.txt", "from bucket two");
    expect(await bodyOf(one, "a.txt")).toBe("from one");
    expect(await bodyOf(two, "a.txt")).toBe("from bucket two");
    expect(await sizeOf(one, "a.txt")).toBe(8);
  });

  test("one cache() refuses to serve a second instance with another prefix or adapter", () => {
    const adapter = fakeAdapter();
    const plugin = cache();
    createFiles({ adapter, plugins: [plugin], prefix: "a" });
    expect(() =>
      createFiles({ adapter, plugins: [plugin], prefix: "b" })
    ).toThrow(expect.objectContaining({ code: "Invalid" }));
    expect(() =>
      createFiles({ adapter: fakeAdapter(), plugins: [plugin], prefix: "a" })
    ).toThrow(/different adapter or prefix/u);
    // The same scope again is fine (a rebuilt instance over the same adapter).
    expect(() =>
      createFiles({ adapter, plugins: [plugin], prefix: "a" })
    ).not.toThrow();
  });

  test("a read-only view shares the instance's cache", async () => {
    const { adapter, calls } = counting();
    const files = withCache({}, adapter);
    await files.upload("a.txt", "hello");
    await files.head("a.txt");
    await files.readonly().head("a.txt");
    expect(calls.head).toEqual(["a.txt"]);
  });
});

/** A provider event for `key`, as `files-sdk/events` hands it to the core. */
const providerEvent = (key: string): FileEvent => ({
  etag: "e",
  id: key,
  key,
  provider: "fake",
  raw: null,
  size: 5,
  source: "provider",
  time: 0,
  type: "created",
});

describe("cache plugin — provider events", () => {
  test("a provider event drops the key's cached reads and passes through unchanged", async () => {
    const { adapter, calls } = counting();
    const files = createFiles({
      adapter,
      plugins: [cache({ operations: ["head", "download"], ttl: 0 })],
      prefix: "p",
    });
    await files.upload("a.txt", "v1");
    await files.head("a.txt");
    await files.download("a.txt");
    await files.head("a.txt");
    expect(calls.head).toEqual(["p/a.txt"]);

    // Out-of-band write the plugin never saw, reported by the provider.
    await adapter.upload("p/a.txt", "version two");
    const folded = files[FOLD_PROVIDER_EVENT](providerEvent("p/a.txt"));
    expect(folded).toEqual({ ...providerEvent("p/a.txt"), key: "a.txt" });

    expect(await sizeOf(files, "a.txt")).toBe(11);
    expect(await bodyOf(files, "a.txt")).toBe("version two");
    expect(calls.head).toEqual(["p/a.txt", "p/a.txt"]);
    expect(countKey(calls.download, "p/a.txt")).toBe(2);
  });

  test("a store failure while dropping never breaks event delivery", async () => {
    const failures: string[] = [];
    const rejecting: CacheStore = {
      ...mapStore(),
      delete: (key) => {
        failures.push(key);
        return Promise.reject(new Error("redis: connection reset"));
      },
    };
    const throwing: CacheStore = {
      ...mapStore(),
      delete: (key) => {
        failures.push(key);
        throw new Error("store exploded");
      },
    };
    for (const store of [rejecting, throwing]) {
      const files = createFiles({
        adapter: fakeAdapter(),
        plugins: [cache({ namespace: "ns", store })],
      });
      expect(files[FOLD_PROVIDER_EVENT](providerEvent("a.txt"))).toEqual(
        providerEvent("a.txt")
      );
    }
    // Let the rejected delete settle: it must not surface as unhandled.
    await Promise.resolve();
    expect(failures).toEqual(["ns//a.txt", "ns//a.txt"]);
  });
});
