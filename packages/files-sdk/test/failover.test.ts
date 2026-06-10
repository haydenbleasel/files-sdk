import { describe, expect, test } from "bun:test";

import { failover } from "../src/failover/index.js";
import type { FailoverEvent, FailoverOptions } from "../src/failover/index.js";
import { Files } from "../src/index.js";
import type { Adapter } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";
import { fakeAdapter } from "./fake-adapter.js";
import type { FakeAdapter } from "./fake-adapter.js";

/**
 * An adapter whose every verb rejects with a `Provider` error — a backend that
 * is fully down, so the default predicate fails over off it.
 */
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
