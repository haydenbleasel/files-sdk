import { describe, expect, test } from "bun:test";

import { Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";

import {
  Conflict,
  Files,
  FilesError,
  Invalid,
  make,
  NotFound,
  Provider,
  ReadOnly,
  Unauthorized,
  Unsupported,
} from "../src/effect/index.js";
import type { FileEvent } from "../src/effect/index.js";
import { events } from "../src/events/index.js";
import type { Adapter, FileInfo, ListResult } from "../src/index.js";
import {
  createFiles,
  createStoredFile,
  Files as FilesClient,
} from "../src/index.js";
import { FilesError as SdkFilesError } from "../src/internal/errors.js";
import { memory } from "../src/memory/index.js";
import { tiering } from "../src/tiering/index.js";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const failure = async <A>(effect: Effect.Effect<A, FilesError>) => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    throw new Error("expected the effect to fail");
  }
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error?._tag !== "Fail") {
    throw new Error(`expected a typed failure, got ${String(exit.cause)}`);
  }
  return error.error;
};

const reasonOf = async <A>(effect: Effect.Effect<A, FilesError>) => {
  const error = await failure(effect);
  return error.reason;
};

const service = () => make(new FilesClient({ adapter: memory() }));

// An adapter whose `head` and second `list` page wait for their signal, so a
// test can see interruption reach the provider call.
const hanging = () => {
  const base = memory();
  const seen: AbortSignal[] = [];
  const started = Promise.withResolvers<null>();
  const wait = (signal: AbortSignal | undefined) => {
    const hang = Promise.withResolvers<never>();
    if (signal) {
      seen.push(signal);
      signal.addEventListener("abort", () => hang.reject(signal.reason));
    }
    started.resolve(null);
    return hang.promise;
  };
  const adapter: Adapter = {
    ...base,
    head: (_key, opts) => wait(opts?.signal),
    list: (opts): Promise<ListResult> =>
      opts?.cursor
        ? wait(opts.signal)
        : Promise.resolve({
            cursor: "page-2",
            items: [{ contentType: "text/plain", key: "a.txt", size: 1 }],
          }),
  };
  return { adapter, seen, waiting: started.promise };
};

const event = (key: string): FileEvent => ({
  id: `id-${key}`,
  key,
  provider: "memory",
  raw: null,
  source: "provider",
  time: 0,
  type: "created",
});

// Resolves once `client.events.on` has registered a handler.
const onSubscribe = (client: {
  events: { on: (...args: never[]) => unknown };
}) => {
  const subscribed = Promise.withResolvers<null>();
  const original = client.events.on;
  client.events.on = ((...args: never[]) => {
    const off = original(...args);
    subscribed.resolve(null);
    return off;
  }) as typeof original;
  return subscribed.promise;
};

const keysOf = (list: readonly FileInfo[]) => list.map((file) => file.key);

describe("operations", () => {
  test("single-object operations return the SDK's results", async () => {
    const files = service();
    const uploaded = await run(
      files.upload("a.txt", "hello", { contentType: "text/plain" })
    );
    expect(uploaded).toMatchObject({ key: "a.txt", size: 5 });
    expect(await run(files.head("a.txt"))).toMatchObject({ size: 5 });
    expect(await run(files.exists("a.txt"))).toBe(true);
    await run(files.copy("a.txt", "b.txt"));
    await run(files.move("b.txt", "c.txt"));
    const page = await run(files.list());
    expect(page.items.map((item) => item.key)).toEqual(["a.txt", "c.txt"]);
    expect(await run(files.url("a.txt"))).toContain("a.txt");
    const signed = await run(files.signedUploadUrl("d.txt", { expiresIn: 60 }));
    expect(signed.url).toContain("d.txt");
    await run(files.delete("c.txt"));
    expect(await run(files.exists("c.txt"))).toBe(false);
    expect(files.capabilities.signedUrl).toBeDefined();
  });

  test("bulk forms return the SDK's bulk results", async () => {
    const files = service();
    const uploaded = await run(
      files.upload([
        { body: "1", key: "a.txt" },
        { body: "22", key: "b.txt" },
      ])
    );
    expect(uploaded.results.map((r) => r.key)).toEqual(["a.txt", "b.txt"]);
    const heads = await run(files.head(["a.txt", "b.txt"]));
    expect(heads.results.map((r) => r.size)).toEqual([1, 2]);
    const existing = await run(files.exists(["a.txt", "missing.txt"]));
    expect(existing).toMatchObject({
      existing: ["a.txt"],
      missing: ["missing.txt"],
    });
    const downloaded = await run(files.download(["a.txt", "b.txt"]));
    expect(
      await run(Effect.all(downloaded.results.map((file) => file.text)))
    ).toEqual(["1", "22"]);
    const deleted = await run(files.delete(["a.txt", "b.txt"]));
    expect(deleted.results).toEqual(["a.txt", "b.txt"]);
  });

  test("download exposes the body as Effects and a Stream", async () => {
    const files = service();
    await run(
      files.upload("a.txt", "hello", {
        contentType: "text/plain",
        metadata: { owner: "me" },
      })
    );
    const file = await run(files.download("a.txt"));
    expect(file).toMatchObject({
      contentType: "text/plain",
      key: "a.txt",
      metadata: { owner: "me" },
      name: "a.txt",
      size: 5,
      type: "text/plain",
    });
    expect(file.etag).toBeString();
    expect(file.lastModified).toBeNumber();
    expect(await run(file.text)).toBe("hello");
    expect(new TextDecoder().decode(await run(file.arrayBuffer))).toBe("hello");
    const blob = await run(file.blob);
    expect(await blob.text()).toBe("hello");
    expect(await file.file.text()).toBe("hello");

    const streamed = await run(files.download("a.txt"));
    const chunks = await run(Stream.runCollect(streamed.stream));
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("hello");
  });

  test("a stream-backed body reads once; a second run fails as Invalid", async () => {
    const base = memory();
    const adapter: Adapter = {
      ...base,
      download: async (key, opts) => {
        const file = await base.download(key, opts);
        return createStoredFile(file, {
          factory: () => new Blob(["hello"]).stream(),
          kind: "stream",
        });
      },
    };
    const files = make(new FilesClient({ adapter }));
    await run(files.upload("a.txt", "hello"));
    const file = await run(files.download("a.txt"));
    const chunks = await run(Stream.runCollect(file.stream));
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("hello");
    const again = await failure(Stream.runCollect(file.stream));
    expect(again.reason).toBeInstanceOf(Invalid);
    expect(again.message).toContain("already consumed");
  });

  test("download leaves out FileInfo fields the object doesn't have", async () => {
    const base = memory();
    const adapter: Adapter = {
      ...base,
      download: async (key, opts) => {
        const file = await base.download(key, opts);
        return {
          ...file,
          etag: undefined,
          lastModified: undefined,
          metadata: undefined,
        };
      },
    };
    const files = make(new FilesClient({ adapter }));
    await run(files.upload("a.txt", "x"));
    const file = await run(files.download("a.txt"));
    expect(Object.keys(file)).not.toContain("etag");
    expect(Object.keys(file)).not.toContain("lastModified");
    expect(Object.keys(file)).not.toContain("metadata");
  });

  test("listAll and search are Streams", async () => {
    const files = service();
    await run(
      files.upload([
        { body: "1", key: "a.txt" },
        { body: "2", key: "photos/b.jpg" },
        { body: "3", key: "photos/c.png" },
      ])
    );
    expect(
      keysOf(await run(Stream.runCollect(files.listAll({ limit: 1 }))))
    ).toEqual(["a.txt", "photos/b.jpg", "photos/c.png"]);
    expect(
      keysOf(await run(Stream.runCollect(files.search("photos/*.jpg"))))
    ).toEqual(["photos/b.jpg"]);
    expect(
      keysOf(
        await run(
          Stream.runCollect(Stream.take(files.listAll({ limit: 1 }), 1))
        )
      )
    ).toEqual(["a.txt"]);
  });

  test("abortUpload and tryPromise reach the wrapped instance", async () => {
    const files = service();
    await run(
      files.abortUpload("a.txt", {
        contentType: "text/plain",
        key: "a.txt",
        provider: "memory",
        uploadId: "missing",
      })
    );
    expect(files.client).toBeInstanceOf(FilesClient);
    await run(files.upload("a.txt", "x"));
    const signals: AbortSignal[] = [];
    const size = await run(
      files.tryPromise(async (client, signal) => {
        signals.push(signal);
        const info = await client.head("a.txt");
        return info.size;
      })
    );
    expect(size).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("errors", () => {
  test("a FilesError code becomes the reason's tag", async () => {
    const files = service();
    const error = await failure(files.head("missing.txt"));
    expect(error).toBeInstanceOf(FilesError);
    expect(error._tag).toBe("FilesError");
    expect(error.reason).toBeInstanceOf(NotFound);
    expect(error.reason.permanent).toBe(false);
    expect(error.reason.cause).toBeInstanceOf(SdkFilesError);
    expect(error.message).toBe(error.reason.message);

    const recovered = await run(
      files.head("missing.txt").pipe(
        Effect.as("found"),
        Effect.catchReason("FilesError", "NotFound", () =>
          Effect.succeed("missing")
        )
      )
    );
    expect(recovered).toBe("missing");
  });

  test("ReadOnly and Invalid are permanent", async () => {
    const files = make(new FilesClient({ adapter: memory() }).readonly());
    const readOnly = await failure(files.upload("a.txt", "x"));
    expect(readOnly.reason).toBeInstanceOf(ReadOnly);
    expect(readOnly.reason.permanent).toBe(true);
    const invalid = await failure(service().head(""));
    expect(invalid.reason).toBeInstanceOf(Invalid);
    expect(invalid.reason.permanent).toBe(true);
  });

  test("a reason keeps every flag; any other rejection becomes Provider", async () => {
    const files = service();
    const rejectWith = (cause: unknown) =>
      failure(files.tryPromise(() => Promise.reject(cause)));
    const applied = await rejectWith(
      SdkFilesError.applied(new SdkFilesError("Conflict", "lost"), '"e1"')
    );
    expect(applied.reason).toBeInstanceOf(Conflict);
    expect(applied.reason).toMatchObject({
      applied: true,
      appliedEtag: '"e1"',
      message: "lost",
    });
    const timedOut = await rejectWith(
      new SdkFilesError("Provider", "slow", undefined, {
        aborted: true,
        timedOut: true,
      })
    );
    expect(timedOut.reason).toMatchObject({ aborted: true, timedOut: true });
    const other = await rejectWith(new TypeError("boom"));
    expect(other.reason).toBeInstanceOf(Provider);
    expect(other.message).toBe("boom");
    const denied = await rejectWith(
      new SdkFilesError("Unauthorized", "denied")
    );
    expect(denied.reason).toBeInstanceOf(Unauthorized);
  });

  test("reasons construct with the SDK's defaults, for test doubles", () => {
    expect(new NotFound({ message: "x" })).toMatchObject({
      aborted: false,
      applied: false,
      permanent: false,
      timedOut: false,
    });
    expect(new Unsupported({ message: "x" }).permanent).toBe(true);
  });
});

describe("cancellation", () => {
  test("interrupting the fiber aborts the provider call", async () => {
    const { adapter, seen, waiting } = hanging();
    const files = make(new FilesClient({ adapter }));
    const fiber = Effect.runFork(files.head("a.txt"));
    await waiting;
    await run(Fiber.interrupt(fiber));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
  });

  test("a caller's own signal still aborts the call", async () => {
    const { adapter, seen, waiting } = hanging();
    const files = make(new FilesClient({ adapter }));
    const controller = new AbortController();
    const pending = Effect.runPromiseExit(
      files.head("a.txt", { signal: controller.signal })
    );
    await waiting;
    controller.abort();
    const exit = await pending;
    expect(Exit.isFailure(exit)).toBe(true);
    expect(seen[0]?.aborted).toBe(true);
  });

  test("interrupting a listAll stream aborts the page in flight", async () => {
    const { adapter, seen, waiting } = hanging();
    const files = make(new FilesClient({ adapter }));
    const fiber = Effect.runFork(Stream.runCollect(files.listAll()));
    await waiting;
    await run(Fiber.interrupt(fiber));
    expect(seen.at(-1)?.aborted).toBe(true);
  });
});

describe("layer", () => {
  test("provides Files from an instance or from options", async () => {
    const program = Effect.gen(function* program() {
      const files = yield* Files;
      yield* files.upload("a.txt", "hi");
      return yield* files.exists("a.txt");
    });
    expect(
      await run(
        Effect.provide(
          program,
          Files.layer(new FilesClient({ adapter: memory() }))
        )
      )
    ).toBe(true);
    expect(
      await run(Effect.provide(program, Files.layer({ adapter: memory() })))
    ).toBe(true);
  });

  test("invalid options fail the layer with Invalid", async () => {
    const error = await failure(
      Layer.build(Files.layer({ adapter: memory(), prefix: "../x" })).pipe(
        Effect.scoped
      )
    );
    expect(error.reason).toBeInstanceOf(Invalid);
  });
});

describe("events", () => {
  test("every member fails with Unsupported without the events() plugin", async () => {
    const files = service();
    expect(await reasonOf(files.events.parse([]))).toBeInstanceOf(Unsupported);
    expect(await reasonOf(files.events.dispatch([]))).toBeInstanceOf(
      Unsupported
    );
    expect(
      await reasonOf(Effect.scoped(files.events.on("*", () => Effect.void)))
    ).toBeInstanceOf(Unsupported);
    expect(
      await reasonOf(Stream.runCollect(files.events.stream()))
    ).toBeInstanceOf(Unsupported);
  });

  test("on() handles events for the life of its scope", async () => {
    const client = createFiles({ adapter: memory(), plugins: [events()] });
    const files = make(client);
    const seen: string[] = [];
    const scope = await run(Scope.make());
    await run(
      Scope.provide(
        files.events.on("created", "photos/**", (e) =>
          Effect.sync(() => seen.push(e.key))
        ),
        scope
      )
    );
    await run(
      Scope.provide(
        files.events.on("*", (e) => Effect.sync(() => seen.push(`*:${e.key}`))),
        scope
      )
    );
    await client.events.emit([event("photos/a.jpg"), event("b.txt")]);
    expect(seen).toEqual(["photos/a.jpg", "*:photos/a.jpg", "*:b.txt"]);
    await run(Scope.close(scope, Exit.void));
    await client.events.emit(event("photos/c.jpg"));
    expect(seen).toHaveLength(3);
  });

  test("a failing handler fails the delivery", async () => {
    const client = createFiles({
      adapter: memory(),
      plugins: [events({ onError: () => {} })],
    });
    const files = make(client);
    const scope = await run(Scope.make());
    await run(
      Scope.provide(
        files.events.on("*", () => Effect.fail(new Error("handler broke"))),
        scope
      )
    );
    await expect(client.events.emit(event("a.txt"))).rejects.toThrow(
      "handler broke"
    );
    await run(Scope.close(scope, Exit.void));
  });

  test("closing the scope interrupts a running handler and fails its delivery", async () => {
    const client = createFiles({
      adapter: memory(),
      plugins: [events({ onError: () => {} })],
    });
    const files = make(client);
    const scope = await run(Scope.make());
    const running = Promise.withResolvers<null>();
    await run(
      Scope.provide(
        files.events.on("*", () =>
          Effect.andThen(
            Effect.sync(() => running.resolve(null)),
            Effect.never
          )
        ),
        scope
      )
    );
    const delivery = client.events.emit(event("a.txt"));
    await running.promise;
    await run(Scope.close(scope, Exit.void));
    await expect(delivery).rejects.toThrow();
  });

  test("on() fails with the SDK's error when a plugin refuses provider events", async () => {
    const client = createFiles({
      adapter: memory(),
      plugins: [
        events({ format: "memory" }),
        tiering({ cold: memory(), fallback: true, route: () => "hot" }),
      ],
    });
    const error = await failure(
      Effect.scoped(make(client).events.on("*", () => Effect.void))
    );
    expect(error.reason).toBeInstanceOf(Unsupported);
    expect(error.message).toContain("fallback: true");
  });

  test("stream() emits matching events and unsubscribes when it ends", async () => {
    const client = createFiles({ adapter: memory(), plugins: [events()] });
    const files = make(client);
    const subscribed = onSubscribe(client);
    const fiber = Effect.runFork(
      Stream.runCollect(
        Stream.take(files.events.stream("created", "photos/**"), 2)
      )
    );
    await subscribed;
    await client.upload("b.txt", "x");
    await client.upload("photos/a.jpg", "x");
    await client.delete("photos/a.jpg");
    await client.upload("photos/c.jpg", "x");
    await client.events.settled();
    const collected = await run(Fiber.join(fiber));
    expect(collected.map((e) => `${e.type}:${e.key}`)).toEqual([
      "created:photos/a.jpg",
      "created:photos/c.jpg",
    ]);
    // Ended: later events have no handler to reach.
    await client.events.emit(event("photos/d.jpg"));
  });

  test("stream() makes deliveries wait on a full buffer, and fails them when it ends", async () => {
    const client = createFiles({
      adapter: memory(),
      plugins: [events({ onError: () => {} })],
    });
    const files = make(client);
    const subscribed = onSubscribe(client);
    const consumed: string[] = [];
    // A consumer stuck on its first event: one more fits in the buffer.
    const fiber = Effect.runFork(
      Stream.runForEach(
        files.events.stream("*", undefined, { bufferSize: 1 }),
        (e) =>
          Effect.andThen(
            Effect.sync(() => consumed.push(e.key)),
            Effect.never
          )
      )
    );
    await subscribed;
    await client.events.emit(event("a.txt"));
    await client.events.emit(event("b.txt"));
    let settled = false;
    const waiting = client.events.emit(event("c.txt")).finally(() => {
      settled = true;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    expect(consumed).toEqual(["a.txt"]);
    await run(Fiber.interrupt(fiber));
    await expect(waiting).rejects.toThrow("a handler failed");
  });

  test("stream() defaults to every event type", async () => {
    const client = createFiles({ adapter: memory(), plugins: [events()] });
    const files = make(client);
    const subscribed = onSubscribe(client);
    const fiber = Effect.runFork(
      Stream.runCollect(Stream.take(files.events.stream(), 2))
    );
    await subscribed;
    await client.events.emit([
      event("a.txt"),
      { ...event("a.txt"), type: "deleted" },
    ]);
    const collected = await run(Fiber.join(fiber));
    expect(collected.map((e) => e.type)).toEqual(["created", "deleted"]);
  });

  test("parse() and dispatch() read provider deliveries", async () => {
    const client = createFiles({
      adapter: memory(),
      plugins: [events({ format: "s3" })],
    });
    const files = make(client);
    const delivery = {
      Records: [
        {
          eventName: "ObjectCreated:Put",
          eventSource: "aws:s3",
          s3: { object: { key: "a.txt", sequencer: "1", size: 4 } },
        },
      ],
    };
    const parsed = await run(files.events.parse(delivery));
    expect(parsed.map((e) => e.key)).toEqual(["a.txt"]);
    const seen: string[] = [];
    const dispatched = await run(
      Effect.scoped(
        Effect.andThen(
          files.events.on("*", (e) => Effect.sync(() => seen.push(e.key))),
          files.events.dispatch(delivery)
        )
      )
    );
    expect(dispatched).toHaveLength(1);
    expect(seen).toEqual(["a.txt"]);
    const malformed = await failure(files.events.parse("{not json"));
    expect(malformed.reason).toBeInstanceOf(Invalid);
  });
});
