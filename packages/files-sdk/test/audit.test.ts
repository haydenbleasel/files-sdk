import { describe, expect, test } from "bun:test";

import { audit } from "../src/audit/index.js";
import type { AuditOptions, AuditRecord } from "../src/audit/index.js";
import { createFiles, Files, FilesError } from "../src/index.js";
import type {
  ConditionalFilesOperation,
  FilesPlugin,
  PluginNext,
} from "../src/index.js";
import { memory } from "../src/memory/index.js";

const bytes = (data: string): Uint8Array => new TextEncoder().encode(data);

// A collecting sink plus a Files instance wired to it. `extra` lets a test add
// options (actor, events, clock) on top of the recording sink.
const recorder = (extra: Partial<AuditOptions> = {}) => {
  const records: AuditRecord[] = [];
  const files = createFiles({
    adapter: memory(),
    plugins: [
      audit({
        sink: (record) => {
          records.push(record);
        },
        ...extra,
      }),
    ],
  });
  return { files, records };
};

describe("audit", () => {
  test("records one entry per write with the caller-facing key", async () => {
    const { files, records } = recorder();
    await files.upload("a.txt", bytes("hello"));

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.action).toBe("upload");
    expect(record?.key).toBe("a.txt");
    expect(record?.status).toBe("success");
    expect(typeof record?.at).toBe("number");
    expect(typeof record?.durationMs).toBe("number");
    expect(record?.actor).toBeUndefined();
  });

  test("records the stored size on a successful upload only", async () => {
    const { files, records } = recorder();
    await files.upload("a.txt", bytes("hello"));
    await files.copy("a.txt", "b.txt");

    const [upload, copy] = records;
    expect(upload?.size).toBe(5);
    expect(copy?.size).toBeUndefined();
  });

  test("records from/to and no key for copy and move", async () => {
    const { files, records } = recorder();
    await files.upload("a.txt", bytes("hi"));
    await files.copy("a.txt", "b.txt");
    await files.move("b.txt", "c.txt");

    const copy = records.find((r) => r.action === "copy");
    const move = records.find((r) => r.action === "move");
    expect(copy).toMatchObject({ from: "a.txt", to: "b.txt" });
    expect(copy?.key).toBeUndefined();
    expect(move).toMatchObject({ from: "b.txt", to: "c.txt" });
  });

  test("resolves the actor from the operation", async () => {
    const { files, records } = recorder({
      actor: (op) => ("key" in op ? (op.key.split("/")[0] ?? "") : "system"),
    });
    await files.upload("acme/a.txt", bytes("hi"));
    expect(records[0]?.actor).toBe("acme");
  });

  test("does not audit reads by default", async () => {
    const { files, records } = recorder();
    // Only the upload is a write; the reads below must not be recorded.
    await files.upload("a.txt", bytes("hi"));
    await files.download("a.txt");
    await files.head("a.txt");
    await files.exists("a.txt");
    await files.exists("missing.txt");
    await files.list();

    expect(records).toHaveLength(1);
    expect(records[0]?.action).toBe("upload");
  });

  test('events: "all" audits reads too, listing carries no key', async () => {
    const { files, records } = recorder({ events: "all" });
    await files.upload("a.txt", bytes("hi"));
    await files.download("a.txt");
    await files.list();

    const download = records.find((r) => r.action === "download");
    const list = records.find((r) => r.action === "list");
    expect(download?.key).toBe("a.txt");
    expect(list).toBeDefined();
    expect(list?.key).toBeUndefined();
    expect(list?.from).toBeUndefined();
  });

  test('events: "writes" is the explicit form of the default', async () => {
    const { files, records } = recorder({ events: "writes" });
    await files.upload("a.txt", bytes("hi"));
    await files.download("a.txt");
    expect(records.map((r) => r.action)).toEqual(["upload"]);
  });

  test("events as an explicit list records exactly those verbs", async () => {
    const { files, records } = recorder({ events: ["delete"] });
    // upload isn't in the audited list, so only the delete is recorded.
    await files.upload("a.txt", bytes("hi"));
    await files.delete("a.txt");
    expect(records.map((r) => r.action)).toEqual(["delete"]);
  });

  test("awaits the sink before the operation resolves", async () => {
    const order: string[] = [];
    const files = createFiles({
      adapter: memory(),
      plugins: [
        audit({
          sink: async () => {
            await Bun.sleep(5);
            order.push("sink");
          },
        }),
      ],
    });

    await files.upload("a.txt", bytes("hi"));
    order.push("after");
    // The sink (async) finished before upload resolved — proof it was awaited.
    expect(order).toEqual(["sink", "after"]);
  });

  test("a sink that rejects on success fails the call, mutation still happened", async () => {
    const adapter = memory();
    const files = createFiles({
      adapter,
      plugins: [
        audit({
          sink: () => {
            throw new Error("audit store down");
          },
        }),
      ],
    });

    await expect(files.upload("a.txt", bytes("hi"))).rejects.toThrow(
      "audit store down"
    );
    // The upload landed even though recording it failed.
    expect(await adapter.exists("a.txt")).toBe(true);
  });

  test("records a failed operation and re-throws its original error", async () => {
    const { files, records } = recorder();
    await expect(files.copy("missing.txt", "b.txt")).rejects.toThrow();

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.action).toBe("copy");
    expect(record?.status).toBe("error");
    expect(record?.error?.code).toBe("NotFound");
    expect(record?.error?.message).toBeTruthy();
    expect(record?.size).toBeUndefined();
  });

  test("on a failed operation the op error wins over a rejecting sink", async () => {
    const files = createFiles({
      adapter: memory(),
      plugins: [
        audit({
          sink: () => {
            throw new Error("sink fail");
          },
        }),
      ],
    });

    // copy of a missing source throws NotFound; the sink also throws while
    // recording it — the operation's error must be the one that surfaces.
    await expect(files.copy("missing.txt", "b.txt")).rejects.toThrow(
      /not found/iu
    );
  });

  test("normalizes a non-FilesError thrown inside the pipeline", async () => {
    const records: AuditRecord[] = [];
    const explode: FilesPlugin = {
      name: "explode",
      wrap: (op, next) => {
        if (op.kind === "delete") {
          throw new Error("kaboom");
        }
        return next(op);
      },
    };
    const files = createFiles({
      adapter: memory(),
      // audit outermost, explode inner: the plain Error bubbles up to audit.
      plugins: [
        audit({
          sink: (record) => {
            records.push(record);
          },
        }),
        explode,
      ],
    });

    await expect(files.delete("a.txt")).rejects.toThrow("kaboom");
    expect(records[0]?.error).toEqual({ code: "Provider", message: "kaboom" });
  });

  test("fans out a bulk write to one record per item, each flagged bulk", async () => {
    const { files, records } = recorder();
    await files.upload([
      { body: bytes("one"), key: "a.txt" },
      { body: bytes("three"), key: "b.txt" },
    ]);

    expect(records).toHaveLength(2);
    expect(records.every((r) => r.action === "upload" && r.bulk === true)).toBe(
      true
    );
    expect(records.map((r) => r.key).toSorted()).toEqual(["a.txt", "b.txt"]);
  });

  test("a single (non-bulk) write carries no bulk flag", async () => {
    const { files, records } = recorder();
    await files.upload("a.txt", bytes("hi"));
    expect(records[0]?.bulk).toBeUndefined();
  });

  test("uses the injected clock for at and durationMs", async () => {
    const ticks = [1000, 1025];
    let i = 0;
    const { files, records } = recorder({
      clock: () => {
        const tick = ticks[i] ?? 9999;
        i += 1;
        return tick;
      },
    });
    await files.upload("a.txt", bytes("hi"));

    expect(records[0]?.at).toBe(1000);
    expect(records[0]?.durationMs).toBe(25);
  });

  test("works on a plain Files instance (wrap-only, no extend)", async () => {
    const records: AuditRecord[] = [];
    const files = new Files({
      adapter: memory(),
      plugins: [
        audit({
          sink: (record) => {
            records.push(record);
          },
        }),
      ],
    });
    await files.upload("a.txt", bytes("hi"));
    expect(records).toHaveLength(1);
  });

  test("records terminal outcomes for conditional operations", async () => {
    const records: AuditRecord[] = [];
    const plugin = audit({
      events: "all",
      sink: (record) => {
        records.push(record);
      },
    });
    const { wrap } = plugin;
    if (!wrap) {
      throw new Error("audit wrap missing");
    }
    const create: Extract<
      ConditionalFilesOperation,
      { kind: "upload"; mode: "create" }
    > = {
      body: bytes("hello"),
      key: "a.txt",
      kind: "upload",
      mode: "create",
    };
    await wrap(create, (() =>
      Promise.resolve({
        contentType: "text/plain",
        etag: "etag-1",
        key: "a.txt",
        size: 5,
      })) as PluginNext);
    const exact: Extract<ConditionalFilesOperation, { kind: "download" }> = {
      etag: "stale-etag",
      key: "a.txt",
      kind: "download",
      mode: "exact",
    };
    await wrap(exact, (() =>
      Promise.reject(
        new FilesError("Conflict", "stale ETag")
      )) as PluginNext).catch(() => {});
    const matchedDelete: Extract<
      ConditionalFilesOperation,
      { kind: "delete" }
    > = {
      etag: "etag-1",
      key: "delete.txt",
      kind: "delete",
      mode: "match",
    };
    await wrap(matchedDelete, (() => Promise.resolve()) as PluginNext);
    const conditionalCopy: Extract<
      ConditionalFilesOperation,
      { kind: "copy" }
    > = {
      destination: { type: "create" },
      from: "a.txt",
      kind: "copy",
      mode: "conditional",
      source: { etag: "etag-1" },
      to: "copy.txt",
    };
    await wrap(conditionalCopy, (() => Promise.resolve()) as PluginNext);

    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({
      action: "upload",
      condition: "create",
      key: "a.txt",
      size: 5,
      status: "success",
    });
    expect(records[1]).toMatchObject({
      action: "download",
      condition: "exact-read",
      error: { code: "Conflict", message: "stale ETag" },
      key: "a.txt",
      status: "error",
    });
    expect(records[2]).toMatchObject({
      action: "delete",
      condition: "match-delete",
      key: "delete.txt",
      status: "success",
    });
    expect(records[3]).toMatchObject({
      action: "copy",
      condition: "conditional-copy",
      from: "a.txt",
      status: "success",
      to: "copy.txt",
    });
  });
});
