import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { createFilesRouter } from "../src/api/index.js";
import { compression } from "../src/compression/index.js";
import { dedup } from "../src/dedup/index.js";
import { encryption } from "../src/encryption/index.js";
import type { EventDedupeStore } from "../src/events/index.js";
import { events } from "../src/events/index.js";
import type { Adapter, FileEvent, FilesPlugin } from "../src/index.js";
import { createFiles, Files } from "../src/index.js";
import { eventSinkOf, FOLD_PROVIDER_EVENT } from "../src/internal/events.js";
import { memory } from "../src/memory/index.js";
import { softDelete } from "../src/soft-delete/index.js";
import { tiering } from "../src/tiering/index.js";
import { versioning } from "../src/versioning/index.js";
import { providerAdapter } from "./events-helper.js";
import { fakeAdapter } from "./fake-adapter.js";

const keyed = (list: readonly FileEvent[]) =>
  list.map((e) => `${e.source}:${e.type}:${e.key}`);

const collect = () => {
  const seen: FileEvent[] = [];
  const handler = (event: FileEvent) => {
    seen.push(event);
  };
  return { handler, seen };
};

const s3Record = (key: string, eventName = "ObjectCreated:Put") => ({
  eventName,
  eventSource: "aws:s3",
  s3: { object: { key, sequencer: `${key}-seq`, size: 4 } },
});

const archiveRoute = ({ key }: { key: string }) =>
  key.startsWith("archive/") ? ("cold" as const) : ("hot" as const);

afterEach(() => {
  mock.restore();
});

describe("memory adapter events", () => {
  test("uploads, copies, moves and deletes reach handlers", async () => {
    const files = createFiles({ adapter: memory(), plugins: [events()] });
    const { handler, seen } = collect();
    files.events.on("*", handler);
    await files.upload("a.txt", "abcd", { contentType: "text/plain" });
    await files.copy("a.txt", "b.txt");
    await files.move("b.txt", "c.txt");
    await files.delete("c.txt");
    await files.delete("missing.txt");
    await files.events.settled();
    expect(keyed(seen)).toEqual([
      "provider:created:a.txt",
      "provider:created:b.txt",
      "provider:deleted:b.txt",
      "provider:created:c.txt",
      "provider:deleted:c.txt",
    ]);
    expect(seen[0]).toMatchObject({
      contentType: "text/plain",
      provider: "memory",
      size: 4,
    });
    expect(new Set(seen.map((e) => e.id)).size).toBe(seen.length);
  });

  test("writes from another instance on the same adapter arrive too", async () => {
    const adapter = memory();
    const files = createFiles({ adapter, plugins: [events()] });
    const { handler, seen } = collect();
    files.events.on("created", handler);
    // a console upload, as far as `files` is concerned
    await new Files({ adapter }).upload("outside.txt", "x");
    await files.events.settled();
    expect(keyed(seen)).toEqual(["provider:created:outside.txt"]);
  });

  test("resumable uploads notify when they complete", async () => {
    const files = createFiles({ adapter: memory(), plugins: [events()] });
    const { handler, seen } = collect();
    files.events.on("created", handler);
    await files.upload("big.bin", new Uint8Array(10), {
      multipart: { partSize: 4 },
    });
    await files.events.settled();
    expect(keyed(seen)).toEqual(["provider:created:big.bin"]);
  });

  test("the instance prefix is stripped and other keys dropped", async () => {
    const adapter = memory();
    const files = createFiles({
      adapter,
      plugins: [events()],
      prefix: "tenant",
    });
    const { handler, seen } = collect();
    files.events.on("*", handler);
    await files.upload("a.txt", "x");
    await new Files({ adapter }).upload("other/b.txt", "y");
    await files.events.settled();
    expect(keyed(seen)).toEqual(["provider:created:a.txt"]);
  });

  test("nothing is subscribed until a handler exists", async () => {
    const adapter = memory();
    const subscribe = spyOn(adapter, "subscribe");
    const files = createFiles({ adapter, plugins: [events()] });
    await files.upload("a.txt", "x");
    expect(subscribe).not.toHaveBeenCalled();
    files.events.on("*", () => {});
    files.events.on("*", () => {});
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  test("a throwing listener can't fail the write", async () => {
    const adapter = memory();
    adapter.subscribe(() => {
      throw new Error("listener");
    });
    const unsubscribe = adapter.subscribe(() => {});
    unsubscribe();
    await expect(
      new Files({ adapter }).upload("a", "b")
    ).resolves.toBeDefined();
  });
});

describe("on()", () => {
  test("filters by type and key glob; unsubscribe removes the handler", async () => {
    const files = createFiles({ adapter: memory(), plugins: [events()] });
    const avatars = collect();
    const deletes = collect();
    const off = files.events.on("created", "avatars/**", avatars.handler);
    files.events.on("deleted", deletes.handler);
    await files.upload("avatars/u1.png", "x");
    await files.upload("docs/a.txt", "x");
    await files.delete("docs/a.txt");
    await files.events.settled();
    off();
    off();
    await files.upload("avatars/u2.png", "x");
    await files.events.settled();
    expect(keyed(avatars.seen)).toEqual(["provider:created:avatars/u1.png"]);
    expect(keyed(deletes.seen)).toEqual(["provider:deleted:docs/a.txt"]);
  });

  test("a non-function handler throws", () => {
    const files = createFiles({ adapter: memory(), plugins: [events()] });
    expect(() =>
      // @ts-expect-error — the handler is required
      files.events.on("created", "**")
    ).toThrow("expected a handler function");
  });

  test("handlers run in registration order, one at a time", async () => {
    const files = createFiles({ adapter: memory(), plugins: [events()] });
    const order: string[] = [];
    files.events.on("*", async () => {
      await Bun.sleep(5);
      order.push("first");
    });
    files.events.on("*", () => {
      order.push("second");
    });
    await files.events.emit({
      id: "1",
      key: "k",
      provider: "memory",
      raw: null,
      source: "provider",
      time: 0,
      type: "created",
    });
    expect(order).toEqual(["first", "second"]);
  });
});

describe("dispatch / emit errors", () => {
  test("dispatch rejects after trying every event; onError sees each failure", async () => {
    const onError = mock();
    const files = createFiles({
      adapter: providerAdapter("s3"),
      plugins: [events({ onError })],
    });
    const ok = collect();
    files.events.on("created", "bad/**", () => {
      throw new Error("handler broke");
    });
    files.events.on("created", ok.handler);
    await expect(
      files.events.dispatch({
        Records: [s3Record("bad/1"), s3Record("good/2")],
      })
    ).rejects.toThrow("a handler failed: handler broke");
    expect(keyed(ok.seen)).toEqual([
      "provider:created:bad/1",
      "provider:created:good/2",
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ key: "bad/1" });

    files.events.on("created", () => {
      // oxlint-disable-next-line no-throw-literal -- deliberately a non-Error, to check how its message is reported
      throw "not an error";
    });
    await expect(
      files.events.dispatch({ Records: [s3Record("bad/3")] })
    ).rejects.toThrow("2 handlers failed; first: handler broke");
    await expect(
      files.events.dispatch({ Records: [s3Record("x")] })
    ).rejects.toThrow("a handler failed: not an error");
  });

  test("dispatch resolves with the events handled", async () => {
    const files = createFiles({
      adapter: providerAdapter("s3"),
      plugins: [events()],
    });
    const list = await files.events.dispatch({ Records: [s3Record("a")] });
    expect(list.map((e) => e.key)).toEqual(["a"]);
  });

  test("the default onError logs; a throwing onError is contained", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const files = createFiles({ adapter: memory(), plugins: [events()] });
    files.events.on("*", () => {
      throw new Error("boom");
    });
    await files.upload("a.txt", "x");
    await files.events.settled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "created handler failed for a.txt"
    );

    const throwing = createFiles({
      adapter: memory(),
      plugins: [
        events({
          onError: () => {
            throw new Error("reporter");
          },
        }),
      ],
    });
    throwing.events.on("*", () => {
      throw new Error("boom");
    });
    await throwing.upload("a.txt", "x");
    await throwing.events.settled();
  });
});

const storeOf = () => {
  const seen = new Map<string, number>();
  const store: EventDedupeStore = {
    add: (id, ttl) => {
      seen.set(id, ttl);
    },
    has: (id) => seen.has(id),
  };
  return { seen, store };
};

describe("dedupe", () => {
  test("a redelivered id is skipped; a failed one stays eligible", async () => {
    const { seen, store } = storeOf();
    const files = createFiles({
      adapter: providerAdapter("s3"),
      plugins: [events({ dedupe: store, dedupeTtl: 1000, onError: () => {} })],
    });
    let calls = 0;
    let fail = true;
    files.events.on("created", () => {
      calls += 1;
      if (fail) {
        throw new Error("transient");
      }
    });
    const delivery = { Records: [s3Record("a")] };
    await expect(files.events.dispatch(delivery)).rejects.toThrow("transient");
    expect(seen.size).toBe(0);
    fail = false;
    await files.events.dispatch(delivery);
    await files.events.dispatch(delivery);
    expect(calls).toBe(2);
    expect([...seen.values()]).toEqual([1000]);
  });

  test("the TTL defaults to a day", async () => {
    const { seen, store } = storeOf();
    const files = createFiles({
      adapter: providerAdapter("s3"),
      plugins: [events({ dedupe: store })],
    });
    await files.events.dispatch({ Records: [s3Record("a")] });
    expect([...seen.values()]).toEqual([86_400_000]);
  });
});

describe("the sdk source", () => {
  test("writes through the instance raise events after they settle", async () => {
    const files = createFiles({
      adapter: fakeAdapter(),
      plugins: [events({ sdk: true })],
    });
    const { handler, seen } = collect();
    files.events.on("*", handler);
    await files.upload("a.txt", "abcd", { contentType: "text/plain" });
    await files.upload([
      { body: "1", key: "bulk/1" },
      { body: "2", key: "bulk/2" },
    ]);
    await files.copy("a.txt", "b.txt");
    await files.move("b.txt", "c.txt");
    await files.delete("c.txt");
    await files.download("a.txt");
    await files.events.settled();
    expect(keyed(seen)).toEqual([
      "sdk:created:a.txt",
      "sdk:created:bulk/1",
      "sdk:created:bulk/2",
      "sdk:created:b.txt",
      "sdk:deleted:b.txt",
      "sdk:created:c.txt",
      "sdk:deleted:c.txt",
    ]);
    expect(seen[0]).toMatchObject({
      contentType: "text/plain",
      provider: "fake",
      raw: { operation: "upload" },
      size: 4,
    });
    expect(seen[0]?.etag).toBeString();
    expect(seen[0]?.id).toStartWith("sdk:");
  });

  test("a failed write raises nothing; the source is off by default", async () => {
    const files = createFiles({
      adapter: fakeAdapter(),
      plugins: [events({ sdk: true })],
    });
    const { handler, seen } = collect();
    files.events.on("*", handler);
    await expect(files.copy("missing", "x")).rejects.toThrow();
    const quiet = createFiles({ adapter: fakeAdapter(), plugins: [events()] });
    quiet.events.on("*", handler);
    await quiet.upload("a", "b");
    await files.events.settled();
    await quiet.events.settled();
    expect(seen).toEqual([]);
  });

  test("an upload result without an etag or lastModified", async () => {
    const base = fakeAdapter();
    const adapter: Adapter = {
      ...base,
      upload: async (...args) => {
        const {
          etag: _e,
          lastModified: _l,
          ...rest
        } = await base.upload(...args);
        return rest;
      },
    };
    const files = createFiles({ adapter, plugins: [events({ sdk: true })] });
    const { handler, seen } = collect();
    files.events.on("*", handler);
    await files.upload("a", "b");
    await files.events.settled();
    expect(seen[0]?.etag).toBeUndefined();
    expect(seen[0]?.time).toBeNumber();
  });
});

describe("events({ sdk: true }) and plugin order", () => {
  test("listed after a plugin that maps storage events, the instance refuses to build", () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const mappers: FilesPlugin[] = [
      versioning(),
      softDelete(),
      dedup(),
      encryption(key),
      compression(),
      tiering({ cold: memory(), route: archiveRoute }),
      tiering({ cold: memory(), fallback: true, route: archiveRoute }),
    ];
    for (const outer of mappers) {
      expect(() =>
        createFiles({
          adapter: memory(),
          plugins: [outer, events({ sdk: true })],
        })
      ).toThrow("list events() first in `plugins`");
      // First is fine, and so is the same order without the sdk source.
      expect(() =>
        createFiles({
          adapter: memory(),
          plugins: [events({ sdk: true }), outer],
        })
      ).not.toThrow();
      expect(() =>
        createFiles({ adapter: memory(), plugins: [outer, events()] })
      ).not.toThrow();
    }
  });

  test("a plugin with no event hook, or one that passes events through untouched, is fine outside", () => {
    const passthrough: FilesPlugin = { event: (event) => event, name: "noop" };
    const plain: FilesPlugin = { name: "plain" };
    const dropper: FilesPlugin = { event: () => null, name: "dropper" };
    const inspector: FilesPlugin = {
      event: (event) => ("size" in event ? { ...event } : event),
      name: "inspector",
    };
    expect(() =>
      createFiles({
        adapter: memory(),
        plugins: [inspector, events({ sdk: true })],
      })
    ).toThrow("list events() first");
    const prefix = "tenant";
    for (const outer of [passthrough, plain]) {
      expect(() =>
        createFiles({
          adapter: memory(),
          plugins: [outer, events({ sdk: true })],
          prefix,
        })
      ).not.toThrow();
    }
    expect(() =>
      createFiles({
        adapter: memory(),
        plugins: [dropper, events({ sdk: true })],
      })
    ).toThrow("list events() first");
    // An inner plugin that drops the probe hides the outside: nothing found.
    expect(() =>
      createFiles({
        adapter: memory(),
        plugins: [versioning(), events({ sdk: true }), dropper],
      })
    ).not.toThrow();
  });

  test("first in plugins, writes are reported with the caller's keys", async () => {
    const files = createFiles({
      adapter: memory(),
      plugins: [events({ sdk: true }), versioning()],
    });
    const { handler, seen } = collect();
    files.events.on("*", handler);
    await files.upload("a.txt", "1");
    await files.upload("a.txt", "2");
    await files.events.settled();
    expect(keyed(seen).filter((k) => k.startsWith("sdk:"))).toEqual([
      "sdk:created:a.txt",
      "sdk:created:a.txt",
    ]);
  });
});

describe("on() and plugins that refuse provider events", () => {
  test("with a format, on() fails loudly; without one, gateway and sdk events still flow", async () => {
    const forced = createFiles({
      adapter: memory(),
      plugins: [
        events({ format: "memory" }),
        tiering({ cold: memory(), fallback: true, route: archiveRoute }),
      ],
    });
    expect(() => forced.events.on("*", () => {})).toThrow("fallback: true");
    // tiering({ fallback: true }) declares no format: on() works, and the
    // memory adapter's own (unmappable) changes aren't subscribed to.
    const files = createFiles({
      adapter: memory(),
      plugins: [
        events({ sdk: true }),
        tiering({ cold: memory(), fallback: true, route: archiveRoute }),
      ],
    });
    expect(files.events.format).toBeUndefined();
    const { handler, seen } = collect();
    files.events.on("*", handler);
    await files.upload("a.txt", "1");
    await files.events.settled();
    expect(keyed(seen)).toEqual(["sdk:created:a.txt"]);
  });
});

describe("installation", () => {
  test("a readonly() clone shares the handlers; another instance is refused", () => {
    const plugin = events();
    const files = createFiles({ adapter: memory(), plugins: [plugin] });
    const clone = files.readonly();
    expect((clone as unknown as typeof files).events).toBe(files.events);
    expect(() => createFiles({ adapter: memory(), plugins: [plugin] })).toThrow(
      "already installed on another Files instance"
    );
  });

  test("an unknown format option throws", () => {
    expect(() =>
      // @ts-expect-error — not a format
      events({ format: "dropbox" })
    ).toThrow('unknown format "dropbox"');
  });

  test("an adapter with no format can't parse, unless one is given", async () => {
    const files = createFiles({
      adapter: providerAdapter("hetzner"),
      plugins: [events()],
    });
    expect(files.events.format).toBeUndefined();
    await expect(files.events.parse({})).rejects.toThrow(
      "the hetzner adapter has no notification format"
    );
    await expect(files.events.parse({})).rejects.toMatchObject({
      code: "Unsupported",
      permanent: true,
    });
    const explicit = createFiles({
      adapter: providerAdapter("hetzner"),
      plugins: [events({ format: "s3" })],
    });
    expect(explicit.events.format).toBe("s3");
    expect(
      await explicit.events.parse({ Records: [s3Record("a")] })
    ).toHaveLength(1);
  });
});

const provider = (key: string, extra: Partial<FileEvent> = {}): FileEvent => ({
  etag: "e",
  id: key,
  key,
  provider: "memory",
  raw: null,
  size: 10,
  source: "provider",
  time: 0,
  type: "created",
  ...extra,
});

const fold = (plugins: FilesPlugin[], event: FileEvent, prefix?: string) =>
  new Files({ adapter: memory(), plugins, prefix })[FOLD_PROVIDER_EVENT](event);

describe("plugin event hooks", () => {
  test("encryption and compression clear the stored size", () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    expect(fold([encryption(key)], provider("a"))).toEqual({
      ...provider("a"),
      size: undefined,
    } as FileEvent);
    const folded = fold([compression()], provider("a"));
    expect(folded?.size).toBeUndefined();
    expect(folded?.etag).toBe("e");
  });

  test("dedup drops blobs and clears pointer size/etag", () => {
    expect(fold([dedup()], provider(".dedup/abc"))).toBeNull();
    const pointer = fold(
      [dedup({ prefix: "blobs" })],
      provider("a.png", { size: 0 })
    );
    expect(pointer?.size).toBeUndefined();
    expect(pointer?.etag).toBeUndefined();
    expect(fold([dedup({ prefix: "blobs" })], provider("blobs/x"))).toBeNull();
    // A non-empty object is one dedup didn't write: it keeps its own size.
    expect(fold([dedup()], provider("legacy.bin"))?.size).toBe(10);
  });

  test("versioning and softDelete drop their own prefixes", () => {
    const plugins = [versioning({ ignore: [".trash"] }), softDelete()];
    expect(fold(plugins, provider(".versions/a.txt/1"))).toBeNull();
    expect(fold(plugins, provider(".trash/a.txt"))).toBeNull();
    expect(fold(plugins, provider("a.txt"))?.key).toBe("a.txt");
  });

  test("tiering keeps hot-routed keys; with fallback it refuses", () => {
    const plugins = [tiering({ cold: memory(), route: archiveRoute })];
    expect(fold(plugins, provider("a.txt"))?.key).toBe("a.txt");
    expect(fold(plugins, provider("archive/a.txt"))).toBeNull();
    expect(() =>
      fold(
        [tiering({ cold: memory(), fallback: true, route: archiveRoute })],
        provider("a")
      )
    ).toThrow("fallback: true");
  });

  test("hooks fold innermost first, after the prefix is stripped", () => {
    const calls: string[] = [];
    const tag =
      (name: string): FilesPlugin["event"] =>
      (event) => {
        calls.push(`${name}:${event.key}`);
        return event;
      };
    const plugins: FilesPlugin[] = [
      { event: tag("outer"), name: "outer" },
      { name: "no-hook" },
      { event: tag("inner"), name: "inner" },
    ];
    fold(plugins, provider("p/a.txt"), "p");
    expect(calls).toEqual(["inner:a.txt", "outer:a.txt"]);
    calls.length = 0;
    const dropping: FilesPlugin[] = [
      { event: tag("outer"), name: "outer" },
      { event: () => null, name: "inner" },
    ];
    expect(fold(dropping, provider("a"))).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("gateway completions", () => {
  test("the gateway only feeds an events namespace with an emit", () => {
    expect(eventSinkOf({} as Files)).toBeUndefined();
    expect(eventSinkOf({ events: {} } as unknown as Files)).toBeUndefined();
    expect(
      eventSinkOf({ events: { emit: 1 } } as unknown as Files)
    ).toBeUndefined();
    expect(
      eventSinkOf({ events: { emit: () => {} } } as unknown as Files)?.emit
    ).toBeFunction();
  });

  test("keyless and keyed gateway uploads reach on() handlers", async () => {
    const files = createFiles({
      adapter: fakeAdapter(),
      plugins: [events()],
    });
    const { handler, seen } = collect();
    files.events.on("created", handler);
    const router = createFilesRouter({
      allowedOrigins: () => true,
      authorize: () => ({ keyPrefix: "u1/" }),
      files,
      onUploadComplete: () => "row",
      secret: "s",
    });
    const put = await router.handle(
      new Request("https://app.test/api/files?op=upload&key=a.txt", {
        body: "hello",
        method: "PUT",
      })
    );
    expect(put.status).toBe(200);
    expect(keyed(seen)).toEqual(["gateway:created:u1/a.txt"]);
    expect(seen[0]).toMatchObject({ provider: "fake", size: 5 });
    expect(seen[0]?.id).toStartWith("gateway:");

    const plain = createFilesRouter({
      allowedOrigins: () => true,
      files,
      operations: ["upload"],
      secret: "s",
    });
    const presign = await plain.handle(
      new Request("https://app.test/api/files", {
        body: JSON.stringify({
          files: [{ name: "b.txt", size: 2, type: "text/plain" }],
          op: "presign",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    const { uploads } = (await presign.json()) as {
      uploads: { id: string; key: string; target: { url: string } }[];
    };
    const [upload] = uploads;
    const token = new URL(upload?.target.url ?? "").searchParams.get("token");
    await plain.handle(
      new Request(
        `https://app.test/api/files?op=proxy&token=${encodeURIComponent(token ?? "")}`,
        { body: "hi", method: "PUT" }
      )
    );
    await plain.handle(
      new Request("https://app.test/api/files", {
        body: JSON.stringify({
          completions: [{ id: upload?.id, key: upload?.key }],
          op: "complete",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(keyed(seen).at(-1)).toBe(`gateway:created:${upload?.key}`);
  });

  test("a failing handler doesn't fail the upload", async () => {
    const onError = mock();
    const files = createFiles({
      adapter: fakeAdapter(),
      plugins: [events({ onError })],
    });
    files.events.on("created", () => {
      throw new Error("indexer down");
    });
    const router = createFilesRouter({
      allowedOrigins: () => true,
      files,
      operations: ["upload"],
      secret: "s",
    });
    const res = await router.handle(
      new Request("https://app.test/api/files?op=upload&key=a.txt", {
        body: "x",
        method: "PUT",
      })
    );
    expect(res.status).toBe(200);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
