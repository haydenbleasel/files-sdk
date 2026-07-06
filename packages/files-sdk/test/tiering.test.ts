import { describe, expect, test } from "bun:test";

import { createFiles } from "../src/index.js";
import type { Adapter, ListOptions, ListResult } from "../src/index.js";
import { tiering } from "../src/tiering/index.js";
import type { TieringOptions, TierRouter } from "../src/tiering/index.js";
import { fakeAdapter } from "./fake-adapter.js";
import type { FakeAdapter } from "./fake-adapter.js";

/** Route the `cold/` prefix to cold, everything else to hot. */
const prefixRoute: TierRouter = ({ key }) =>
  key.startsWith("cold/") ? "cold" : "hot";

/** Route bodies larger than 10 bytes to cold (size-based; needs fallback). */
const sizeRoute: TierRouter = ({ size }) =>
  size !== undefined && size > 10 ? "cold" : "hot";

interface Harness {
  files: ReturnType<typeof createFiles> & {
    tierOf: (key: string) => Promise<"hot" | "cold" | undefined>;
    tier: (key: string, target: "hot" | "cold") => Promise<void>;
  };
  hot: FakeAdapter;
  cold: FakeAdapter;
}

const harness = (
  route: TierRouter,
  opts: {
    fallback?: boolean;
    hot?: Parameters<typeof fakeAdapter>[0];
    cold?: Parameters<typeof fakeAdapter>[0];
    coldOverride?: (base: FakeAdapter) => Adapter;
  } = {}
): Harness => {
  const hot = fakeAdapter(opts.hot);
  const coldBase = fakeAdapter(opts.cold);
  const cold = (opts.coldOverride ? opts.coldOverride(coldBase) : coldBase) as
    | FakeAdapter
    | Adapter;
  const tierOpts: TieringOptions = {
    cold,
    route,
    ...(opts.fallback && { fallback: true }),
  };
  const files = createFiles({
    adapter: hot,
    plugins: [tiering(tierOpts)],
  }) as Harness["files"];
  return { cold: coldBase, files, hot };
};

// Caps every list page at one item, to drive the composite-cursor loop without
// seeding hundreds of objects.
const pagedAdapter = (config?: { supportsDelimiter?: boolean }): Adapter => {
  const inner = fakeAdapter(config);
  return {
    ...inner,
    list(o?: ListOptions): Promise<ListResult> {
      return inner.list({ ...o, limit: 1 });
    },
  };
};

describe("tiering — construction", () => {
  test("requires a cold adapter", () => {
    expect(() =>
      tiering({ route: prefixRoute } as unknown as TieringOptions)
    ).toThrow(/cold adapter is required/u);
  });

  test("requires a route function", () => {
    expect(() =>
      tiering({ cold: fakeAdapter() } as unknown as TieringOptions)
    ).toThrow(/route function is required/u);
  });
});

describe("tiering — prefix routing (deterministic)", () => {
  test("upload lands in the routed tier", async () => {
    const { files, hot, cold } = harness(prefixRoute);
    await files.upload("photo.jpg", "hot-body");
    await files.upload("cold/archive.zip", "cold-body");

    expect(hot.has("photo.jpg")).toBe(true);
    expect(cold.has("photo.jpg")).toBe(false);
    expect(cold.has("cold/archive.zip")).toBe(true);
    expect(hot.has("cold/archive.zip")).toBe(false);
  });

  test("download / head / url read from the routed tier", async () => {
    const { files } = harness(prefixRoute);
    await files.upload("a.txt", "hot");
    await files.upload("cold/b.txt", "cold");

    expect(await files.download("a.txt").then((f) => f.text())).toBe("hot");
    // A cold-only key that wrongly hit hot would throw NotFound from the fake.
    expect(await files.download("cold/b.txt").then((f) => f.text())).toBe(
      "cold"
    );
    expect(await files.head("cold/b.txt")).toMatchObject({ key: "cold/b.txt" });
    // A successful url() on a cold-only key proves it routed to cold (the fake
    // throws NotFound otherwise); the key is URL-encoded in the result.
    expect(await files.url("cold/b.txt")).toContain("cold%2Fb.txt");
  });

  test("exists checks only the routed tier", async () => {
    const { files } = harness(prefixRoute);
    await files.upload("cold/x", "1");
    expect(await files.exists("cold/x")).toBe(true);
    // Routed to hot, never written → false without probing cold.
    expect(await files.exists("missing")).toBe(false);
  });

  test("delete removes from the routed tier", async () => {
    const { files, cold } = harness(prefixRoute);
    await files.upload("cold/x", "1");
    await files.delete("cold/x");
    expect(cold.has("cold/x")).toBe(false);
    expect(await files.exists("cold/x")).toBe(false);
  });

  test("signedUploadUrl signs against the routed tier", async () => {
    const { files } = harness(prefixRoute, {
      coldOverride: (base) => ({
        ...base,
        signedUploadUrl: () =>
          Promise.resolve({
            headers: {},
            method: "PUT",
            url: "https://cold.example/signed",
          }),
      }),
    });
    const hotSign = await files.signedUploadUrl("a.txt", { expiresIn: 60 });
    const coldSign = await files.signedUploadUrl("cold/a.txt", {
      expiresIn: 60,
    });
    expect(hotSign.url).toContain("fake.local");
    expect(coldSign.url).toBe("https://cold.example/signed");
  });
});

describe("tiering — copy / move", () => {
  test("same-tier copy stays native", async () => {
    const { files, hot } = harness(prefixRoute);
    await files.upload("a.txt", "body");
    await files.copy("a.txt", "b.txt");
    expect(hot.has("a.txt")).toBe(true);
    expect(hot.has("b.txt")).toBe(true);
  });

  test("cross-tier copy streams the bytes and keeps the source", async () => {
    const { files, hot, cold } = harness(prefixRoute);
    await files.upload("a.txt", "payload");
    await files.copy("a.txt", "cold/a.txt");

    // Source untouched.
    expect(hot.has("a.txt")).toBe(true);
    expect(cold.has("cold/a.txt")).toBe(true);
    expect(await files.download("cold/a.txt").then((f) => f.text())).toBe(
      "payload"
    );
  });

  test("cross-tier copy preserves content type and metadata", async () => {
    const { files } = harness(prefixRoute);
    await files.upload("a.json", '{"x":1}', {
      contentType: "application/json",
      metadata: { owner: "ada" },
    });
    await files.copy("a.json", "cold/a.json");
    const head = await files.head("cold/a.json");
    expect(head.type).toBe("application/json");
    expect(head.metadata).toEqual({ owner: "ada" });
  });

  test("cross-tier move deletes the source", async () => {
    const { files, hot, cold } = harness(prefixRoute);
    await files.upload("a.txt", "x");
    await files.move("a.txt", "cold/a.txt");
    expect(hot.has("a.txt")).toBe(false);
    expect(cold.has("cold/a.txt")).toBe(true);
  });

  test("same-tier move on the hot tier is native", async () => {
    const { files, hot } = harness(prefixRoute);
    await files.upload("a.txt", "x");
    await files.move("a.txt", "b.txt");
    expect(hot.has("a.txt")).toBe(false);
    expect(hot.has("b.txt")).toBe(true);
  });

  test("same-tier copy on the cold tier is native", async () => {
    const { files, cold } = harness(prefixRoute);
    await files.upload("cold/a.txt", "body");
    await files.copy("cold/a.txt", "cold/b.txt");
    expect(cold.has("cold/a.txt")).toBe(true);
    expect(cold.has("cold/b.txt")).toBe(true);
  });

  test("same-tier move on the cold tier is native", async () => {
    const { files, cold } = harness(prefixRoute);
    await files.upload("cold/a.txt", "x");
    await files.move("cold/a.txt", "cold/b.txt");
    expect(cold.has("cold/a.txt")).toBe(false);
    expect(cold.has("cold/b.txt")).toBe(true);
  });

  test("a fallback copy locates the source and dedups the destination", async () => {
    const { files, hot, cold } = harness(sizeRoute, { fallback: true });
    // Upload routes to hot (4 bytes).
    await files.upload("k", "tiny");
    // Seed a stale destination copy in the cold tier the copy won't land in.
    await cold.upload("k2", "stale");
    // Destination routes to hot (sizeless), so the cold copy is evicted.
    await files.copy("k", "k2");
    expect(hot.has("k2")).toBe(true);
    expect(cold.has("k2")).toBe(false);
    expect(await files.download("k2").then((f) => f.text())).toBe("tiny");
  });
});

describe("tiering — merged listing", () => {
  test("merges both tiers, sorted by key", async () => {
    const { files } = harness(prefixRoute);
    await files.upload("b.txt", "1");
    await files.upload("a.txt", "2");
    await files.upload("cold/z.txt", "3");

    const { items } = await files.list();
    expect(items.map((f) => f.key)).toEqual(["a.txt", "b.txt", "cold/z.txt"]);
  });

  test("paginates the two tiers independently to exhaustion", async () => {
    const hot = pagedAdapter();
    const cold = pagedAdapter();
    const files = createFiles({
      adapter: hot,
      plugins: [tiering({ cold, route: prefixRoute })],
    });
    // Two hot items, one cold item.
    await files.upload("a.txt", "1");
    await files.upload("b.txt", "2");
    await files.upload("cold/z.txt", "3");

    const keys: string[] = [];
    for await (const file of files.listAll()) {
      keys.push(file.key);
    }
    expect(keys.toSorted()).toEqual(["a.txt", "b.txt", "cold/z.txt"]);
  });

  test("merges delimiter prefixes from both tiers", async () => {
    const hot = fakeAdapter({ supportsDelimiter: true });
    const cold = fakeAdapter({ supportsDelimiter: true });
    const files = createFiles({
      adapter: hot,
      plugins: [tiering({ cold, route: prefixRoute })],
    });
    await files.upload("photos/x.jpg", "1");
    await files.upload("cold/docs/y.pdf", "2");

    const result = await files.list({ delimiter: "/" });
    expect(result.prefixes).toEqual(["cold/", "photos/"]);
  });

  test("an undecodable cursor throws instead of silently restarting", async () => {
    const { files } = harness(prefixRoute);
    await files.upload("a.txt", "1");
    await files.upload("cold/b.txt", "2");

    // A silent restart would re-emit the whole listing as duplicates.
    await expect(files.list({ cursor: "not-json" })).rejects.toThrow(
      /invalid list cursor/u
    );
    await expect(files.list({ cursor: "123" })).rejects.toThrow(
      /invalid list cursor/u
    );
  });

  test("a key present in both tiers is emitted exactly once across pages", async () => {
    // Hot holds k1..k9 plus k5; cold holds only k5 (a stale shadow — exactly
    // the state fallback mode anticipates after a crash mid-eviction). With
    // one-item pages, the per-page "hot wins" dedup can't see the collision:
    // cold's k5 arrives on page 1, hot's k5 only on page 5.
    const hot = pagedAdapter();
    const cold = pagedAdapter();
    const files = createFiles({
      adapter: hot,
      plugins: [tiering({ cold, fallback: true, route: prefixRoute })],
    });
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      // eslint-disable-next-line no-await-in-loop -- seeds a fixed per-page order the merge assertion depends on
      await hot.upload(`k${n}`, `hot-${n}`);
    }
    await cold.upload("k5", "cold-5");

    const keys: string[] = [];
    for await (const file of files.listAll()) {
      keys.push(file.key);
    }
    expect(keys).toEqual([
      "k1",
      "k2",
      "k3",
      "k4",
      "k5",
      "k6",
      "k7",
      "k8",
      "k9",
    ]);
  });

  test("paginated delimiter listing emits each prefix exactly once", async () => {
    const hot = pagedAdapter({ supportsDelimiter: true });
    const cold = pagedAdapter({ supportsDelimiter: true });
    const files = createFiles({
      adapter: hot,
      plugins: [tiering({ cold, fallback: true, route: prefixRoute })],
    });
    // "docs/" exists in both tiers, so it surfaces from both streams.
    await hot.upload("docs/a.txt", "1");
    await hot.upload("pics/b.jpg", "2");
    await cold.upload("docs/c.txt", "3");
    await cold.upload("zzz.txt", "4");

    const prefixes: string[] = [];
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- pagination follows the previous page's cursor
      const page = await files.list({
        delimiter: "/",
        ...(cursor !== undefined && { cursor }),
      });
      prefixes.push(...(page.prefixes ?? []));
      keys.push(...page.items.map((f) => f.key));
      ({ cursor } = page);
    } while (cursor !== undefined);
    expect(prefixes).toEqual(["docs/", "pics/"]);
    expect(keys).toEqual(["zzz.txt"]);
  });

  test("an empty page with a continuation holds the merge until it advances", async () => {
    // The hot tier stutters: its first page is empty but carries a cursor, so
    // its coverage is unknowable and nothing can safely be emitted that round.
    const inner = fakeAdapter();
    let stuttered = false;
    const hot: Adapter = {
      ...inner,
      list(o?: ListOptions): Promise<ListResult> {
        if (!stuttered && o?.cursor === undefined) {
          stuttered = true;
          return Promise.resolve({ cursor: "real-start", items: [] });
        }
        const cursor = o?.cursor === "real-start" ? undefined : o?.cursor;
        return inner.list({ ...o, cursor, limit: 1 });
      },
    };
    const cold = pagedAdapter();
    const files = createFiles({
      adapter: hot,
      plugins: [tiering({ cold, fallback: true, route: prefixRoute })],
    });
    await inner.upload("a.txt", "1");
    await inner.upload("b.txt", "2");
    await cold.upload("b.txt", "stale-shadow");
    await cold.upload("c.txt", "3");

    const keys: string[] = [];
    for await (const file of files.listAll()) {
      keys.push(file.key);
    }
    expect(keys).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("a tier that drains early still dedups against later pages", async () => {
    // Cold drains on its first page having emitted k9; hot reaches k9 pages
    // later. The held-back re-fetch (skip) must keep cold's k9 from being
    // emitted again — and hot's k9 must not duplicate it either.
    const hot = pagedAdapter();
    const cold = pagedAdapter();
    const files = createFiles({
      adapter: hot,
      plugins: [tiering({ cold, fallback: true, route: prefixRoute })],
    });
    for (const n of [1, 2, 3, 4, 5, 9]) {
      // eslint-disable-next-line no-await-in-loop -- seeds a fixed per-page order the merge assertion depends on
      await hot.upload(`k${n}`, `hot-${n}`);
    }
    await cold.upload("k9", "cold-9");

    const keys: string[] = [];
    for await (const file of files.listAll()) {
      keys.push(file.key);
    }
    expect(keys).toEqual(["k1", "k2", "k3", "k4", "k5", "k9"]);
  });
});

describe("tiering — size routing with fallback", () => {
  const big = "x".repeat(50);

  test("routes by declared body size", async () => {
    const { files, hot, cold } = harness(sizeRoute, { fallback: true });
    await files.upload("small.txt", "tiny");
    await files.upload("big.txt", big);
    expect(hot.has("small.txt")).toBe(true);
    expect(cold.has("big.txt")).toBe(true);
  });

  test("measures Blob, ArrayBuffer, and typed-array bodies", async () => {
    const { files, cold, hot } = harness(sizeRoute, { fallback: true });
    await files.upload("blob.bin", new Blob([big]));
    await files.upload("buffer.bin", new TextEncoder().encode(big).buffer);
    await files.upload("view.bin", new TextEncoder().encode(big));
    expect(cold.has("blob.bin")).toBe(true);
    expect(cold.has("buffer.bin")).toBe(true);
    expect(cold.has("view.bin")).toBe(true);
    // A stream has no declared length, so it routes to hot.
    await files.upload(
      "stream.bin",
      new Blob([big]).stream() as ReadableStream<Uint8Array>
    );
    expect(hot.has("stream.bin")).toBe(true);
  });

  test("reads fall through to the other tier on a miss", async () => {
    const { files } = harness(sizeRoute, { fallback: true });
    // Routes to cold (50 bytes); a sizeless read guesses hot, misses, then
    // falls through to cold.
    await files.upload("big.txt", big);
    expect(await files.download("big.txt").then((f) => f.text())).toBe(big);
    expect(await files.head("big.txt")).toMatchObject({ key: "big.txt" });
    expect(await files.url("big.txt")).toContain("big.txt");
    expect(await files.exists("big.txt")).toBe(true);
  });

  test("a re-upload that flips tiers evicts the stale copy", async () => {
    const { files, hot, cold } = harness(sizeRoute, { fallback: true });
    // Small body → hot.
    await files.upload("k", "tiny");
    expect(hot.has("k")).toBe(true);
    // Large body → cold, evicting the hot copy.
    await files.upload("k", big);
    expect(hot.has("k")).toBe(false);
    expect(cold.has("k")).toBe(true);
    expect(await files.download("k").then((f) => f.text())).toBe(big);
  });

  test("delete removes the key from both tiers", async () => {
    const { files, hot, cold } = harness(sizeRoute, { fallback: true });
    // Routes to cold (50 bytes).
    await files.upload("big.txt", big);
    await files.delete("big.txt");
    expect(cold.has("big.txt")).toBe(false);
    expect(hot.has("big.txt")).toBe(false);
  });

  test("a non-NotFound error is not swallowed by fallback", async () => {
    // The guessed tier for a sizeless read is hot; a non-NotFound error there
    // must propagate rather than fall through to cold.
    const hot = fakeAdapter();
    const files = createFiles({
      adapter: {
        ...hot,
        download() {
          return Promise.reject(new Error("boom"));
        },
      },
      plugins: [
        tiering({ cold: fakeAdapter(), fallback: true, route: sizeRoute }),
      ],
    });
    await files.upload("k", "tiny");
    await expect(files.download("k")).rejects.toThrow(/boom/u);
  });
});

describe("tiering — tier() / tierOf()", () => {
  test("tierOf reports the holding tier, or undefined", async () => {
    const { files } = harness(prefixRoute);
    await files.upload("a.txt", "1");
    await files.upload("cold/b.txt", "2");
    expect(await files.tierOf("a.txt")).toBe("hot");
    expect(await files.tierOf("cold/b.txt")).toBe("cold");
    expect(await files.tierOf("ghost")).toBeUndefined();
  });

  test("tier() moves an object across tiers and stays readable", async () => {
    const { files, hot, cold } = harness(sizeRoute, { fallback: true });
    // Small body → hot.
    await files.upload("k", "tiny");
    await files.tier("k", "cold");
    expect(hot.has("k")).toBe(false);
    expect(cold.has("k")).toBe(true);
    // Still found via the fallback read.
    expect(await files.download("k").then((f) => f.text())).toBe("tiny");
  });

  test("tier() to the current tier is a no-op", async () => {
    const { files, hot } = harness(prefixRoute);
    await files.upload("a.txt", "1");
    await files.tier("a.txt", "hot");
    expect(hot.has("a.txt")).toBe(true);
  });

  test("tier() throws when nothing is stored", async () => {
    const { files } = harness(prefixRoute);
    await expect(files.tier("ghost", "cold")).rejects.toThrow(
      /nothing stored for "ghost"/u
    );
  });

  test("tierOf()/tier() honor the instance prefix", async () => {
    const hot = fakeAdapter();
    const cold = fakeAdapter();
    const files = createFiles({
      adapter: hot,
      plugins: [tiering({ cold, route: prefixRoute })],
      prefix: "tenant1",
    }) as Harness["files"];

    // The wrap path stores under "tenant1/doc.txt" on the hot adapter.
    await files.upload("doc.txt", "hello");
    expect(await files.exists("doc.txt")).toBe(true);
    // The extend path must address the same prefixed hot-tier key.
    expect(await files.tierOf("doc.txt")).toBe("hot");

    await files.tier("doc.txt", "cold");
    expect(hot.has("tenant1/doc.txt")).toBe(false);
    // The cold tier receives caller-facing keys (no prefix) by design.
    expect(cold.has("doc.txt")).toBe(true);
  });
});

describe("tiering — copy with a missing source under fallback", () => {
  test("surfaces the provider NotFound", async () => {
    const { files } = harness(sizeRoute, { fallback: true });
    // locate() finds nothing, so the routed-tier copy throws the fake's NotFound.
    await expect(files.copy("ghost", "dest")).rejects.toThrow(/not found/u);
  });
});
