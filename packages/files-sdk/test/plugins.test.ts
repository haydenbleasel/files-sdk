import { describe, expect, mock, test } from "bun:test";

import { createFiles, Files, FilesError, handlers } from "../src/index.js";
import type { Adapter, FilesOperation, FilesPlugin } from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

// A raw `wrap` plugin that records onion entry/exit around each op, for
// asserting composition order.
const tracer = (name: string, log: string[]): FilesPlugin => ({
  name,
  wrap: async (op, next) => {
    log.push(`${name}:before`);
    const result = await next(op);
    log.push(`${name}:after`);
    return result;
  },
});

// True when an op is one element of a fanned-out bulk call. `bulk` only exists
// on the verbs with an array form, so guard the access for the whole union.
const isBulk = (op: FilesOperation): boolean =>
  "bulk" in op && op.bulk === true;

// An extend-only plugin that adds `files.usage()`.
const usagePlugin: FilesPlugin<{ usage: () => number }> = {
  extend: () => ({ usage: () => 42 }),
  name: "usage",
};

describe("plugin onion — wrap composition", () => {
  test("write ops run outermost-first, inner-last", async () => {
    const log: string[] = [];
    const files = new Files({
      adapter: fakeAdapter(),
      plugins: [tracer("a", log), tracer("b", log)],
    });
    await files.upload("k.txt", "v");
    expect(log).toEqual(["a:before", "b:before", "b:after", "a:after"]);
  });

  test("read ops self-order through the same onion", async () => {
    const log: string[] = [];
    const files = new Files({
      adapter: fakeAdapter(),
      plugins: [tracer("a", log), tracer("b", log)],
    });
    await files.upload("k.txt", "v");
    log.length = 0;
    await files.download("k.txt");
    expect(log).toEqual(["a:before", "b:before", "b:after", "a:after"]);
  });

  test("a wrap transforms the body before it is stored", async () => {
    const upper: FilesPlugin = {
      name: "upper",
      wrap: handlers({
        upload: (op, next) =>
          next({ ...op, body: (op.body as string).toUpperCase() }),
      }),
    };
    const files = new Files({ adapter: fakeAdapter(), plugins: [upper] });
    await files.upload("k.txt", "hello");
    const file = await files.download("k.txt");
    expect(await file.text()).toBe("HELLO");
  });

  test("a wrap transforms options and they round-trip", async () => {
    const setType: FilesPlugin = {
      name: "set-type",
      wrap: handlers({
        upload: (op, next) =>
          next({
            ...op,
            options: { ...op.options, contentType: "text/x-test" },
          }),
      }),
    };
    const files = new Files({ adapter: fakeAdapter(), plugins: [setType] });
    await files.upload("k.txt", "v");
    const meta = await files.head("k.txt");
    expect(meta.type).toBe("text/x-test");
  });

  test("a wrap can veto an op and the adapter is never called", async () => {
    const base = fakeAdapter();
    const upload = mock(base.upload);
    const adapter: Adapter = { ...base, upload };
    const guard: FilesPlugin = {
      name: "guard",
      wrap: handlers({
        upload: () => {
          throw new FilesError("Provider", "blocked");
        },
      }),
    };
    const files = new Files({ adapter, plugins: [guard] });
    await expect(files.upload("k.txt", "v")).rejects.toThrow("blocked");
    expect(upload).not.toHaveBeenCalled();
  });

  test("a raw wrap (not via handlers) sees every op kind", async () => {
    const kinds: string[] = [];
    const spy: FilesPlugin = {
      name: "spy",
      wrap: (op, next) => {
        kinds.push(op.kind);
        return next(op);
      },
    };
    const files = new Files({ adapter: fakeAdapter(), plugins: [spy] });
    await files.upload("k.txt", "v");
    await files.head("k.txt");
    await files.url("k.txt");
    expect(kinds).toEqual(["upload", "head", "url"]);
  });

  test("a no-plugin instance round-trips unchanged", async () => {
    const files = new Files({ adapter: fakeAdapter() });
    await files.upload("k.txt", "v");
    const file = await files.download("k.txt");
    expect(await file.text()).toBe("v");
  });
});

describe("plugin onion — bulk ops", () => {
  test("every bulk item flows through the onion, marked bulk", async () => {
    const seen: { kind: string; bulk: boolean }[] = [];
    const spy: FilesPlugin = {
      name: "spy",
      wrap: (op, next) => {
        seen.push({ bulk: isBulk(op), kind: op.kind });
        return next(op);
      },
    };
    const files = new Files({ adapter: fakeAdapter(), plugins: [spy] });

    await files.upload([
      { body: "1", key: "a" },
      { body: "2", key: "b" },
    ]);
    await files.download(["a", "b"]);
    await files.head(["a", "b"]);
    await files.exists(["a", "b"]);
    await files.delete(["a", "b"]);
    // A single op for contrast.
    await files.upload("c", "3");

    const byKind = (kind: string) => seen.filter((s) => s.kind === kind);
    for (const kind of ["download", "head", "exists", "delete"]) {
      expect(byKind(kind)).toEqual([
        { bulk: true, kind },
        { bulk: true, kind },
      ]);
    }
    // Two bulk uploads, then one single upload.
    expect(byKind("upload")).toEqual([
      { bulk: true, kind: "upload" },
      { bulk: true, kind: "upload" },
      { bulk: false, kind: "upload" },
    ]);
  });

  test("a cross-kind sub-op re-routes correctly inside every bulk verb", async () => {
    // For each primary verb the plugin first issues a sub-op of a *different*
    // kind via `next`. The bulk bases used to be locked to their own verb, so
    // a foreign-kind sub-op misrouted (e.g. `body.getReader` on undefined);
    // they now delegate it to the single-op path.
    const probed: string[] = [];
    const probe: FilesPlugin = {
      name: "probe",
      wrap: async (op, next) => {
        if (
          op.kind === "upload" ||
          op.kind === "download" ||
          op.kind === "head" ||
          op.kind === "delete"
        ) {
          await next({ key: op.key, kind: "exists" });
          probed.push(`${op.kind}->exists`);
        } else if (op.kind === "exists") {
          await next({ key: op.key, kind: "head" });
          probed.push("exists->head");
        }
        return next(op);
      },
    };
    const files = new Files({ adapter: fakeAdapter(), plugins: [probe] });
    await files.upload("a", "1");
    await files.upload("b", "2");
    probed.length = 0;

    // None of these throw now that foreign-kind sub-ops take the single path.
    await files.upload([
      { body: "x", key: "a" },
      { body: "y", key: "b" },
    ]);
    const dl = await files.download(["a", "b"]);
    expect(dl.downloaded).toHaveLength(2);
    const hd = await files.head(["a", "b"]);
    expect(hd.files).toHaveLength(2);
    const ex = await files.exists(["a", "b"]);
    expect(ex.existing).toEqual(["a", "b"]);
    const del = await files.delete(["a", "b"]);
    expect(del.deleted).toEqual(["a", "b"]);

    // Each bulk verb drove its cross-kind probe once per item (two items).
    for (const tag of [
      "upload->exists",
      "download->exists",
      "head->exists",
      "exists->head",
      "delete->exists",
    ]) {
      expect(probed.filter((entry) => entry === tag)).toHaveLength(2);
    }
  });

  test("delete(array) uses the native batch when no plugin wraps", async () => {
    const base = fakeAdapter();
    const deleteMany = mock(base.deleteMany?.bind(base));
    const del = mock(base.delete);
    const adapter: Adapter = { ...base, delete: del, deleteMany };
    const files = new Files({ adapter });
    await files.upload("a", "1");
    await files.upload("b", "2");
    await files.delete(["a", "b"]);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
  });

  test("delete(array) fans out per key through the onion when a plugin wraps", async () => {
    const base = fakeAdapter();
    const deleteMany = mock(base.deleteMany?.bind(base));
    const del = mock(base.delete);
    const adapter: Adapter = { ...base, delete: del, deleteMany };
    const seen: string[] = [];
    const spy: FilesPlugin = {
      name: "spy",
      wrap: (op, next) => {
        seen.push(op.kind);
        return next(op);
      },
    };
    const files = new Files({ adapter, plugins: [spy] });
    await files.upload("a", "1");
    await files.upload("b", "2");
    seen.length = 0;
    const result = await files.delete(["a", "b"]);
    expect(result.deleted).toEqual(["a", "b"]);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["delete", "delete"]);
  });

  test("the bulk delete plugin path preserves input-order errors", async () => {
    // A plugin that vetoes the middle key; the others delete normally —
    // exercises error collection through the onion + deleteManyWithFallback.
    const veto: FilesPlugin = {
      name: "veto",
      wrap: (op, next) => {
        if (op.kind === "delete" && op.key === "bad") {
          throw new FilesError("Provider", "vetoed");
        }
        return next(op);
      },
    };
    const files = new Files({ adapter: fakeAdapter(), plugins: [veto] });
    await files.upload("ok1", "1");
    await files.upload("bad", "2");
    await files.upload("ok2", "3");
    const result = await files.delete(["ok1", "bad", "ok2"]);
    expect(result.deleted).toEqual(["ok1", "ok2"]);
    expect(result.errors?.map((e) => e.key)).toEqual(["bad"]);
  });
});

describe("handlers() helper", () => {
  test("listed verbs run; unlisted verbs pass straight through", async () => {
    const onlyUpload: FilesPlugin = {
      name: "only-upload",
      wrap: handlers({
        // Listed: transforms the body.
        upload: (op, next) => next({ ...op, body: "X" }),
        // `download` is omitted, so it hits the passthrough arm.
      }),
    };
    const files = new Files({ adapter: fakeAdapter(), plugins: [onlyUpload] });
    await files.upload("k.txt", "orig");
    const file = await files.download("k.txt");
    expect(await file.text()).toBe("X");
  });
});

describe("extend / createFiles", () => {
  test("extend contributes callable surface", async () => {
    const files = createFiles({
      adapter: fakeAdapter(),
      plugins: [usagePlugin],
    });
    expect(files.usage()).toBe(42);
    // An extend-only plugin adds no wrap, so ops still run via the short path.
    await files.upload("k.txt", "v");
    const file = await files.download("k.txt");
    expect(await file.text()).toBe("v");
  });

  test("createFiles surfaces extension methods on the static type", () => {
    const files = createFiles({
      adapter: fakeAdapter(),
      plugins: [usagePlugin],
    });
    expect(files.usage()).toBe(42);
    // Type-only: referenced but never called, so the bad access never runs.
    const assertMissing = () => {
      // @ts-expect-error `missing` is not contributed by any plugin
      files.missing();
    };
    expect(typeof assertMissing).toBe("function");
  });

  test("a wrap-only plugin contributes no surface", async () => {
    const wrapOnly: FilesPlugin = {
      name: "wrap-only",
      wrap: (op, next) => next(op),
    };
    const files = new Files({ adapter: fakeAdapter(), plugins: [wrapOnly] });
    await files.upload("k.txt", "v");
    const file = await files.download("k.txt");
    expect(await file.text()).toBe("v");
  });

  test("extend that shadows a real method throws at construction", () => {
    const bad: FilesPlugin = {
      extend: () => ({ upload: () => "nope" }),
      name: "bad",
    };
    expect(() => new Files({ adapter: fakeAdapter(), plugins: [bad] })).toThrow(
      /collides with an existing Files member/u
    );
  });

  test("two plugins contributing the same key throw at construction", () => {
    const a: FilesPlugin = { extend: () => ({ same: () => 1 }), name: "a" };
    const b: FilesPlugin = { extend: () => ({ same: () => 2 }), name: "b" };
    expect(
      () => new Files({ adapter: fakeAdapter(), plugins: [a, b] })
    ).toThrow(/collides with another plugin/u);
  });
});

describe("readonly() carries plugins", () => {
  test("the clone keeps the onion and surface, and blocks writes", async () => {
    const log: string[] = [];
    const files = createFiles({
      adapter: fakeAdapter(),
      plugins: [usagePlugin, tracer("t", log)],
    });
    await files.upload("k.txt", "v");
    const ro = files.readonly() as typeof files;

    // extend re-ran on the clone.
    expect(ro.usage()).toBe(42);

    // wrap still fires for an allowed read.
    log.length = 0;
    await ro.download("k.txt");
    expect(log).toEqual(["t:before", "t:after"]);

    // writes are blocked.
    await expect(ro.upload("k.txt", "v2")).rejects.toMatchObject({
      code: "ReadOnly",
    });
  });
});

describe("file(key) handle", () => {
  test("handle methods route through plugins", async () => {
    const kinds: string[] = [];
    const spy: FilesPlugin = {
      name: "spy",
      wrap: (op, next) => {
        kinds.push(op.kind);
        return next(op);
      },
    };
    const files = new Files({ adapter: fakeAdapter(), plugins: [spy] });
    const handle = files.file("k.txt");
    await handle.upload("v");
    await handle.download();
    expect(kinds).toEqual(["upload", "download"]);
  });
});

describe("metadata-injecting plugins", () => {
  test("inject metadata on an adapter that supports it", async () => {
    const iv: FilesPlugin = {
      name: "iv",
      wrap: handlers({
        upload: (op, next) =>
          next({
            ...op,
            options: {
              ...op.options,
              metadata: { ...op.options?.metadata, iv: "abc" },
            },
          }),
      }),
    };
    const files = new Files({ adapter: fakeAdapter(), plugins: [iv] });
    await files.upload("k.txt", "v");
    const meta = await files.head("k.txt");
    expect(meta.metadata?.iv).toBe("abc");
  });

  test("injecting metadata throws on an adapter without metadata support", async () => {
    const iv: FilesPlugin = {
      name: "iv",
      wrap: handlers({
        upload: (op, next) =>
          next({
            ...op,
            options: { ...op.options, metadata: { iv: "abc" } },
          }),
      }),
    };
    const noMeta: Adapter = { ...fakeAdapter(), supportsMetadata: false };
    const files = new Files({ adapter: noMeta, plugins: [iv] });
    await expect(files.upload("k.txt", "v")).rejects.toThrow(
      /`metadata` is not supported/u
    );
  });

  test("a wrap throwing a plain Error surfaces as a FilesError even without hooks", async () => {
    const thrower: FilesPlugin = {
      name: "thrower",
      wrap: () => Promise.reject(new Error("plain boom")),
    };
    const files = new Files({ adapter: fakeAdapter(), plugins: [thrower] });
    let caught: unknown;
    try {
      await files.head("k.txt");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FilesError);
    expect((caught as FilesError).message).toContain("plain boom");
  });
});
