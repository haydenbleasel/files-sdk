import { describe, expect, test } from "bun:test";

import { failover } from "../src/failover/index.js";
import type { FailoverEvent, FailoverOptions } from "../src/failover/index.js";
import { Files, UploadControl } from "../src/index.js";
import type {
  Adapter,
  AdapterCapabilities,
  ConditionalFilesOperation,
  PluginNext,
} from "../src/index.js";
import { intersectCapabilities } from "../src/internal/capabilities.js";
import { FilesError } from "../src/internal/errors.js";
import { memory } from "../src/memory/index.js";
import { fakeAdapter, withCapabilities } from "./fake-adapter.js";
import type { FakeAdapter } from "./fake-adapter.js";

/**
 * An adapter whose every verb rejects with a `Provider` error — a backend that
 * is fully down, so the default predicate fails over off it.
 */

/** An adapter advertising every native conditional primitive. */
const conditionalAdapter = (): Adapter => ({
  ...fakeAdapter(),
  conditional: {
    copy: {
      atomicSourceDestination: true,
      destinationCreate: true,
      destinationReplace: true,
      run: () => Promise.resolve(),
      sourceEtag: true,
    },
    create: () => Promise.reject(new Error("unused")),
    delete: () => Promise.resolve(),
    exactRead: () => Promise.reject(new Error("unused")),
    replace: () => Promise.reject(new Error("unused")),
  },
});

const downAdapter = (message = "backend down"): Adapter => {
  const fail = (): Promise<never> =>
    Promise.reject(new FilesError("Provider", message));
  return {
    ...fakeAdapter(),
    copy: fail,
    delete: fail,
    download: fail,
    exists: fail,
    head: fail,
    list: fail,
    move: fail,
    signedUploadUrl: fail,
    upload: fail,
    url: fail,
  };
};

/** A healthy fake seeded with the given key → value pairs. */
const seeded = async (
  entries: Record<string, string>
): Promise<FakeAdapter> => {
  const adapter = fakeAdapter();
  await Promise.all(
    Object.entries(entries).map(([key, value]) => adapter.upload(key, value))
  );
  return adapter;
};

/** A failover instance whose primary is fully down. */
const downPrimary = (
  secondary: Adapter,
  opts: Partial<Omit<FailoverOptions, "secondaries">> = {}
): Files =>
  new Files({
    adapter: downAdapter(),
    plugins: [failover({ secondaries: secondary, ...opts })],
  });

describe("failover — construction", () => {
  test("throws when no secondaries are given", () => {
    expect(() => failover({} as unknown as FailoverOptions)).toThrow(
      /at least one secondary/u
    );
  });

  test("throws on an empty secondaries array", () => {
    expect(() => failover({ secondaries: [] })).toThrow(
      /at least one secondary/u
    );
  });
});

describe("failover — reads fall over when the primary is down", () => {
  test("download reads from the secondary", async () => {
    const secondary = await seeded({ "a.txt": "backup" });
    const files = downPrimary(secondary);
    expect(await files.download("a.txt").then((f) => f.text())).toBe("backup");
  });

  test("head reads from the secondary", async () => {
    const secondary = await seeded({ "a.txt": "backup" });
    const files = downPrimary(secondary);
    expect(await files.head("a.txt")).toMatchObject({ key: "a.txt" });
  });

  test("url signs against the secondary", async () => {
    const secondary = await seeded({ "a.txt": "backup" });
    const files = downPrimary(secondary);
    expect(await files.url("a.txt")).toContain("a.txt");
  });

  test("exists checks the secondary", async () => {
    const secondary = await seeded({ "a.txt": "backup" });
    const files = downPrimary(secondary);
    expect(await files.exists("a.txt")).toBe(true);
  });

  test("list returns the secondary's page (not merged)", async () => {
    const secondary = await seeded({ "a.txt": "1", "b.txt": "2" });
    const files = downPrimary(secondary);
    const { items } = await files.list();
    expect(items.map((f) => f.key)).toEqual(["a.txt", "b.txt"]);
  });

  test("signedUploadUrl signs against the secondary", async () => {
    const secondary = await seeded({});
    const files = downPrimary(secondary);
    const signed = await files.signedUploadUrl("a.txt", { expiresIn: 60 });
    expect(signed.url).toContain("fake.local");
  });
});

describe("failover — writes fall over when the primary is down", () => {
  test("upload lands on the secondary", async () => {
    const secondary = await seeded({});
    const files = downPrimary(secondary);
    await files.upload("a.txt", "hello");
    expect(secondary.has("a.txt")).toBe(true);
    expect(await files.download("a.txt").then((f) => f.text())).toBe("hello");
  });

  test("delete removes from the secondary", async () => {
    const secondary = await seeded({ "a.txt": "x" });
    const files = downPrimary(secondary);
    await files.delete("a.txt");
    expect(secondary.has("a.txt")).toBe(false);
  });

  test("copy runs against the secondary", async () => {
    const secondary = await seeded({ "a.txt": "x" });
    const files = downPrimary(secondary);
    await files.copy("a.txt", "b.txt");
    expect(secondary.has("a.txt")).toBe(true);
    expect(secondary.has("b.txt")).toBe(true);
  });

  test("move runs against the secondary", async () => {
    const secondary = await seeded({ "a.txt": "x" });
    const files = downPrimary(secondary);
    await files.move("a.txt", "b.txt");
    expect(secondary.has("a.txt")).toBe(false);
    expect(secondary.has("b.txt")).toBe(true);
  });
});

describe("failover — the primary is the source of truth", () => {
  test("a healthy primary serves reads without touching the secondary", async () => {
    const primary = await seeded({ "a.txt": "primary" });
    const secondary = await seeded({ "a.txt": "secondary" });
    const events: FailoverEvent[] = [];
    const files = new Files({
      adapter: primary,
      plugins: [
        failover({ onFailover: (e) => events.push(e), secondaries: secondary }),
      ],
    });
    expect(await files.download("a.txt").then((f) => f.text())).toBe("primary");
    expect(events).toHaveLength(0);
  });

  test("writes are not fanned out to the secondary (failover, not replication)", async () => {
    const primary = fakeAdapter();
    const secondary = fakeAdapter();
    const files = new Files({
      adapter: primary,
      plugins: [failover({ secondaries: secondary })],
    });
    await files.upload("a.txt", "x");
    expect(primary.has("a.txt")).toBe(true);
    expect(secondary.has("a.txt")).toBe(false);
  });

  test("a definitive NotFound from a healthy primary is not masked by a replica", async () => {
    const primary = fakeAdapter();
    const secondary = await seeded({ "ghost.txt": "on the backup" });
    const files = new Files({
      adapter: primary,
      plugins: [failover({ secondaries: secondary })],
    });
    // The primary answers NotFound (it's up), so the read isn't failed over even
    // though the secondary holds the key.
    await expect(files.download("ghost.txt")).rejects.toThrow(/not found/u);
  });

  test("an aborted error is never failed over", async () => {
    const aborting: Adapter = {
      ...fakeAdapter(),
      download: () =>
        Promise.reject(
          new FilesError("Provider", "request aborted", undefined, {
            aborted: true,
          })
        ),
    };
    const secondary = await seeded({ "a.txt": "backup" });
    const files = new Files({
      adapter: aborting,
      plugins: [failover({ secondaries: secondary })],
    });
    await expect(files.download("a.txt")).rejects.toThrow(/aborted/u);
  });

  test("an SDK-side capability rejection is not failed over", async () => {
    // The primary can't store metadata, so the core gate rejects before any
    // provider I/O. That's a permanent answer, not an outage: the upload must
    // fail loudly rather than silently land (with its metadata) on a replica.
    const primary: Adapter = withCapabilities(fakeAdapter(), {
      metadata: false,
    });
    const secondary = fakeAdapter();
    const events: FailoverEvent[] = [];
    const files = new Files({
      adapter: primary,
      plugins: [
        failover({
          onFailover: (event) => events.push(event),
          secondaries: secondary,
        }),
      ],
    });
    await expect(
      files.upload("a.txt", "x", { metadata: { user: "1" } })
    ).rejects.toMatchObject({
      code: "Unsupported",
      message: "fake: `metadata` is not supported by this adapter",
      permanent: true,
    });
    expect(secondary.has("a.txt")).toBe(false);
    expect(events).toEqual([]);
  });

  test("an invalid-key or unsupported-range rejection is not failed over", async () => {
    const secondary = await seeded({ "a.txt": "backup" });
    const files = new Files({
      adapter: fakeAdapter(),
      plugins: [failover({ secondaries: secondary })],
    });
    await expect(
      files.download("a.txt", { range: { start: 0 } })
    ).rejects.toMatchObject({ permanent: true });
    await expect(files.download("a\0b")).rejects.toMatchObject({
      permanent: true,
    });
  });

  test("a permanent provider error is not failed over", async () => {
    const refusing: Adapter = {
      ...fakeAdapter(),
      download: () =>
        Promise.reject(
          new FilesError("Provider", "host ignored Range", undefined, {
            permanent: true,
          })
        ),
    };
    const secondary = await seeded({ "a.txt": "backup" });
    const files = new Files({
      adapter: refusing,
      plugins: [failover({ secondaries: secondary })],
    });
    await expect(files.download("a.txt")).rejects.toThrow(/ignored Range/u);
  });
});

describe("failover — the chain", () => {
  test("tries multiple secondaries in order", async () => {
    const healthy = await seeded({ "a.txt": "third" });
    const files = new Files({
      adapter: downAdapter("primary down"),
      plugins: [
        failover({ secondaries: [downAdapter("first down"), healthy] }),
      ],
    });
    expect(await files.download("a.txt").then((f) => f.text())).toBe("third");
  });

  test("throws the last error when every backend is down", async () => {
    const files = new Files({
      adapter: downAdapter("primary down"),
      plugins: [failover({ secondaries: downAdapter("secondary down") })],
    });
    await expect(files.download("a.txt")).rejects.toThrow(/secondary down/u);
  });
});

describe("failover — streaming uploads", () => {
  test("a stream upload goes to the primary alone (it can't be replayed)", async () => {
    const primary = fakeAdapter();
    const secondary = fakeAdapter();
    const files = new Files({
      adapter: primary,
      plugins: [failover({ secondaries: secondary })],
    });
    await files.upload(
      "s.bin",
      new Blob(["streamy"]).stream() as ReadableStream<Uint8Array>
    );
    expect(primary.has("s.bin")).toBe(true);
    expect(secondary.has("s.bin")).toBe(false);
  });

  test("a stream upload is not failed over when the primary is down", async () => {
    const secondary = fakeAdapter();
    const files = downPrimary(secondary);
    await expect(
      files.upload(
        "s.bin",
        new Blob(["streamy"]).stream() as ReadableStream<Uint8Array>
      )
    ).rejects.toThrow(/backend down/u);
    expect(secondary.has("s.bin")).toBe(false);
  });
});

/** A memory adapter whose resumable sessions fail to begin. */
const resumableDown = (): Adapter => {
  const base = memory();
  return {
    ...base,
    resumableUpload: (key, opts) => {
      const driver = (
        base.resumableUpload as NonNullable<Adapter["resumableUpload"]>
      )(key, opts);
      return {
        ...driver,
        begin: () => Promise.reject(new FilesError("Provider", "primary down")),
      };
    },
  };
};

describe("failover — resumable uploads", () => {
  test("an upload with a control isn't replayed on a secondary", async () => {
    const secondary = memory();
    let failedOver = false;
    const files = new Files({
      adapter: resumableDown(),
      plugins: [
        failover({
          onFailover: () => {
            failedOver = true;
          },
          secondaries: secondary,
        }),
      ],
    });
    // The primary's own outage surfaces, not "already driven an upload".
    await expect(
      files.upload("k", new Uint8Array(10), { control: new UploadControl() })
    ).rejects.toThrow(/primary down/u);
    expect(failedOver).toBe(false);
    expect(await secondary.exists("k")).toBe(false);
  });

  test("the same body without a control still fails over", async () => {
    const secondary = memory();
    const files = new Files({
      adapter: downAdapter(),
      plugins: [failover({ secondaries: secondary })],
    });
    await files.upload("k", new Uint8Array(10));
    expect(await secondary.exists("k")).toBe(true);
  });
});

describe("failover — shouldFailover", () => {
  test("a custom predicate can read through to a replica on NotFound", async () => {
    const primary = fakeAdapter();
    const secondary = await seeded({ "a.txt": "read-through" });
    const files = new Files({
      adapter: primary,
      plugins: [
        failover({
          secondaries: secondary,
          shouldFailover: (error) =>
            error.code === "NotFound" || error.code === "Provider",
        }),
      ],
    });
    expect(await files.download("a.txt").then((f) => f.text())).toBe(
      "read-through"
    );
  });
});

/** A primary whose download hangs until the signal aborts. */
const hangingAdapter = (): Adapter => ({
  ...fakeAdapter(),
  download: (_key, opts) =>
    // oxlint-disable-next-line promise/avoid-new -- hang-until-abort needs callback interop.
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () =>
        reject(opts.signal?.reason)
      );
    }),
});

describe("failover — timeouts vs caller aborts", () => {
  test("a primary timeout fails over to the secondary", async () => {
    const secondary = await seeded({ "a.txt": "from-replica" });
    const files = new Files({
      adapter: hangingAdapter(),
      plugins: [failover({ secondaries: secondary })],
    });
    // The canonical "backend hung" case: the per-op timeout cuts the primary
    // off and the chain serves the replica instead of surfacing the timeout.
    const body = await files
      .download("a.txt", { timeout: 20 })
      .then((f) => f.text());
    expect(body).toBe("from-replica");
  });

  test("the instance timeout governs the secondaries too", async () => {
    const events: FailoverEvent[] = [];
    const files = new Files({
      adapter: hangingAdapter(),
      plugins: [
        failover({
          onFailover: (e) => events.push(e),
          secondaries: hangingAdapter(),
        }),
      ],
      timeout: 20,
    });
    // The constructor timeout cuts the primary off and the chain fails over —
    // then the secondary's internal Files must inherit that same timeout, or a
    // hung replica stalls the operation forever after the failover.
    const err = await files.download("a.txt").catch((error: unknown) => error);
    expect(events).toHaveLength(1);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).timedOut).toBe(true);
  });

  test("a per-call timeout still forwards to the secondaries", async () => {
    const files = new Files({
      adapter: hangingAdapter(),
      plugins: [failover({ secondaries: hangingAdapter() })],
    });
    const err = await files
      .download("a.txt", { timeout: 20 })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).timedOut).toBe(true);
  });

  test("the instance retries default applies to the secondaries", async () => {
    let attempts = 0;
    const flakySecondary: Adapter = {
      ...fakeAdapter(),
      download: () => {
        attempts += 1;
        return Promise.reject(new FilesError("Provider", "flaky"));
      },
    };
    const files = new Files({
      adapter: downAdapter(),
      plugins: [failover({ secondaries: flakySecondary })],
      retries: { backoff: () => 0, max: 2 },
    });
    await expect(files.download("a.txt")).rejects.toThrow(/flaky/u);
    // One initial attempt plus the two retries the instance default asks for.
    expect(attempts).toBe(3);
  });

  test("a caller abort is surfaced, not failed over", async () => {
    const secondary = await seeded({ "a.txt": "from-replica" });
    const files = new Files({
      adapter: hangingAdapter(),
      plugins: [failover({ secondaries: secondary })],
    });
    const controller = new AbortController();
    const promise = files.download("a.txt", { signal: controller.signal });
    controller.abort();
    const err = await promise.catch((error: unknown) => error);
    expect(err).toBeInstanceOf(FilesError);
    expect((err as FilesError).aborted).toBe(true);
    expect((err as FilesError).timedOut).toBe(false);
  });
});

describe("failover — onFailover", () => {
  test("reports the operation and the backend indices", async () => {
    const events: FailoverEvent[] = [];
    const secondary = await seeded({ "a.txt": "backup" });
    const files = downPrimary(secondary, { onFailover: (e) => events.push(e) });
    await files.download("a.txt");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      failed: 0,
      next: 1,
      operation: "download",
    });
    expect(events[0]?.error).toBeInstanceOf(FilesError);
  });

  test("a throw from the handler is swallowed", async () => {
    const secondary = await seeded({ "a.txt": "backup" });
    const files = downPrimary(secondary, {
      onFailover: () => {
        throw new Error("boom");
      },
    });
    expect(await files.download("a.txt").then((f) => f.text())).toBe("backup");
  });
});

describe("failover — a single secondary passed directly", () => {
  test("normalizes a lone adapter into a one-element chain", async () => {
    const secondary = await seeded({ "a.txt": "solo" });
    const files = new Files({
      adapter: downAdapter(),
      plugins: [failover({ secondaries: secondary })],
    });
    expect(await files.download("a.txt").then((f) => f.text())).toBe("solo");
  });
});

describe("failover — capabilities", () => {
  test("stops advertising the conditional primitives it vetoes", () => {
    const adapter = conditionalAdapter();
    expect(new Files({ adapter }).capabilities.conditional.create).toBe(true);
    const files = new Files({
      adapter,
      plugins: [failover({ secondaries: fakeAdapter() })],
    });
    expect(files.capabilities.conditional).toEqual({
      copy: {
        atomicSourceDestination: false,
        destinationCreate: false,
        destinationReplace: false,
        sourceEtag: false,
      },
      create: false,
      delete: false,
      exactRead: false,
      multipart: { create: false, replace: false },
      replace: false,
    });
  });
});

/** A fake that reads ranges and lists by delimiter. */
const capable = (): FakeAdapter =>
  fakeAdapter({ supportsDelimiter: true, supportsRange: true });

describe("failover — capabilities across backends", () => {
  test("advertises only what every backend can do", () => {
    const files = new Files({
      adapter: capable(),
      plugins: [
        failover({
          secondaries: [
            capable(),
            withCapabilities(fakeAdapter(), { metadata: false }),
          ],
        }),
      ],
    });
    expect(new Files({ adapter: capable() }).capabilities.rangeRead).toBe(true);
    const caps = files.capabilities;
    expect(caps.rangeRead).toBe(false);
    expect(caps.delimiter).toBe(false);
    expect(caps.metadata).toBe(false);
    expect(caps.cacheControl).toBe(true);
    expect(caps.signedUrl).toEqual({
      disposition: true,
      expiry: "exact",
      supported: true,
    });
  });

  test("refuses an option a secondary can't honor while the primary is healthy", async () => {
    const primary = fakeAdapter({ supportsRange: true });
    await primary.upload("a.txt", "hello");
    const events: FailoverEvent[] = [];
    const files = new Files({
      adapter: primary,
      plugins: [
        failover({
          onFailover: (event) => events.push(event),
          secondaries: withCapabilities(fakeAdapter(), { metadata: false }),
        }),
      ],
    });
    await expect(
      files.download("a.txt", { range: { end: 1, start: 0 } })
    ).rejects.toMatchObject({
      code: "Unsupported",
      message: 'range downloads are not supported by the "failover" plugin',
    });
    await expect(
      files.upload("b.txt", "x", { metadata: { user: "1" } })
    ).rejects.toMatchObject({ code: "Unsupported", permanent: true });
    expect(primary.has("b.txt")).toBe(false);
    expect(events).toEqual([]);
    // What every backend supports still works.
    expect(await files.download("a.txt").then((f) => f.text())).toBe("hello");
  });

  test("keeps the primary's provider-event format", () => {
    const files = new Files({
      adapter: memory(),
      plugins: [failover({ secondaries: fakeAdapter() })],
    });
    expect(files.capabilities.events).toEqual({ format: "memory" });
  });
});

/** A full snapshot with every capability off — the base the cases override. */
const noCaps = (
  overrides: Partial<AdapterCapabilities> = {}
): AdapterCapabilities => ({
  ...new Files({ adapter: { ...fakeAdapter(), capabilities: {} } })
    .capabilities,
  ...overrides,
});

describe("intersectCapabilities", () => {
  test("ANDs the boolean flags", () => {
    const on = noCaps({
      cacheControl: true,
      metadata: true,
      publicUrl: true,
      rangeRead: true,
      resumable: true,
      serverSideCopy: true,
      uploadProgress: true,
    });
    expect(intersectCapabilities(on, on)).toEqual(on);
    expect(intersectCapabilities(on, noCaps())).toEqual(noCaps());
  });

  test("keeps the weaker delimiter support", () => {
    const delimiter = (a: AdapterCapabilities["delimiter"], b: typeof a) =>
      intersectCapabilities(noCaps({ delimiter: a }), noCaps({ delimiter: b }))
        .delimiter;
    expect(delimiter("any", "any")).toBe("any");
    expect(delimiter("any", "slash")).toBe("slash");
    expect(delimiter("slash", "any")).toBe("slash");
    expect(delimiter("any", false)).toBe(false);
    expect(delimiter(false, "slash")).toBe(false);
  });

  test("signs only when both sign, with the weaker expiry and tighter cap", () => {
    const signed = (signedUrl: AdapterCapabilities["signedUrl"]) =>
      noCaps({ signedUrl });
    const exact = signed({
      disposition: true,
      expiry: "exact",
      maxExpiresIn: 604_800,
      supported: true,
    });
    const provider = signed({
      disposition: false,
      expiry: "provider",
      maxExpiresIn: 3600,
      supported: true,
    });
    const uncapped = signed({
      disposition: true,
      expiry: "exact",
      supported: true,
    });
    expect(intersectCapabilities(exact, provider).signedUrl).toEqual({
      disposition: false,
      expiry: "provider",
      maxExpiresIn: 3600,
      supported: true,
    });
    expect(intersectCapabilities(provider, exact).signedUrl.expiry).toBe(
      "provider"
    );
    expect(intersectCapabilities(uncapped, exact).signedUrl).toEqual(
      exact.signedUrl
    );
    expect(intersectCapabilities(uncapped, uncapped).signedUrl).toEqual(
      uncapped.signedUrl
    );
    expect(intersectCapabilities(exact, noCaps()).signedUrl).toEqual({
      disposition: false,
      expiry: "none",
      supported: false,
    });
  });

  test("hands out direct uploads only when both can", () => {
    const upload = (signedUpload: AdapterCapabilities["signedUpload"]) =>
      noCaps({ signedUpload });
    const full = upload({
      contentType: true,
      maxExpiresIn: 100,
      maxSize: true,
      supported: true,
    });
    const partial = upload({
      contentType: true,
      maxSize: false,
      supported: true,
    });
    expect(intersectCapabilities(full, partial).signedUpload).toEqual({
      contentType: true,
      maxExpiresIn: 100,
      maxSize: false,
      supported: true,
    });
    expect(intersectCapabilities(partial, full).signedUpload).toEqual({
      contentType: true,
      maxExpiresIn: 100,
      maxSize: false,
      supported: true,
    });
    expect(intersectCapabilities(full, noCaps()).signedUpload).toEqual({
      contentType: false,
      maxSize: false,
      supported: false,
    });
  });

  test("takes conditional and events from the first snapshot", () => {
    const first = noCaps({ events: { format: "s3" } });
    const second = noCaps({ events: { format: "gcs" } });
    expect(intersectCapabilities(first, second).events).toEqual({
      format: "s3",
    });
    expect(intersectCapabilities(first, second).conditional).toBe(
      first.conditional
    );
  });
});

describe("failover — conditional policy", () => {
  test("rejects every conditional primitive before touching any backend", async () => {
    const plugin = failover({ secondaries: fakeAdapter() });
    const { wrap } = plugin;
    if (!wrap) {
      throw new Error("failover wrap missing");
    }
    let nextCalls = 0;
    const next = (() => {
      nextCalls += 1;
      return Promise.resolve();
    }) as PluginNext;
    const operations: ConditionalFilesOperation[] = [
      { body: "x", key: "a.txt", kind: "upload", mode: "create" },
      {
        body: "x",
        etag: "etag-1",
        key: "a.txt",
        kind: "upload",
        mode: "replace",
      },
      {
        etag: "etag-1",
        key: "a.txt",
        kind: "download",
        mode: "exact",
      },
      { etag: "etag-1", key: "a.txt", kind: "delete", mode: "match" },
      {
        destination: { type: "create" },
        from: "a.txt",
        kind: "copy",
        mode: "conditional",
        source: { etag: "etag-1" },
        to: "b.txt",
      },
    ];

    for (const operation of operations) {
      // eslint-disable-next-line no-await-in-loop -- each rejected operation must be inspected independently
      const failure = await Promise.resolve()
        .then(() => wrap(operation, next))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FilesError);
      expect((failure as FilesError).permanent).toBe(true);
      expect((failure as Error).message).toMatch(/native compare-and-set/u);
    }
    expect(nextCalls).toBe(0);
  });
});
