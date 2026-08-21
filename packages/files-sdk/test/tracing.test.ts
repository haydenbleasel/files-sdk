import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { createFiles, Files, FilesError } from "../src/index.js";
import type {
  ConditionalFilesOperation,
  FilesPlugin,
  OperationOptions,
  PluginNext,
} from "../src/index.js";
import { memory } from "../src/memory/index.js";
import { tracing } from "../src/tracing/index.js";

const bytes = (data: string): Uint8Array => new TextEncoder().encode(data);

// A real in-memory OpenTelemetry tracer: SimpleSpanProcessor exports each span
// synchronously the moment it ends, so getFinishedSpans() reflects every closed
// span (presence in the list therefore also proves the span was ended).
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const tracer = provider.getTracer("test");

const named = (name: string): ReadableSpan[] =>
  exporter.getFinishedSpans().filter((span) => span.name === name);

const traced = () =>
  createFiles({ adapter: memory(), plugins: [tracing({ tracer })] });

beforeEach(() => exporter.reset());

describe("tracing", () => {
  test("opens a named span per operation with the key attribute", async () => {
    const files = traced();
    await files.upload("a.txt", bytes("hello"));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("files.upload");
    expect(spans[0]?.attributes).toMatchObject({
      "files.key": "a.txt",
      "files.operation": "upload",
    });
  });

  test("records the stored size on a successful upload", async () => {
    const files = traced();
    await files.upload("a.txt", bytes("hello"));
    const [upload] = named("files.upload");
    expect(upload?.attributes["files.size"]).toBe(5);
  });

  test("records the exists verdict", async () => {
    const files = traced();
    await files.upload("a.txt", bytes("x"));
    await files.exists("a.txt");
    await files.exists("missing.txt");

    const existsSpans = named("files.exists");
    expect(existsSpans[0]?.attributes["files.exists"]).toBe(true);
    expect(existsSpans[1]?.attributes["files.exists"]).toBe(false);
  });

  test("records the listed count and no key on list", async () => {
    const files = traced();
    await files.upload("a.txt", bytes("a"));
    await files.upload("b.txt", bytes("b"));
    await files.list();

    const [list] = named("files.list");
    expect(list?.attributes["files.count"]).toBe(2);
    expect(list?.attributes["files.key"]).toBeUndefined();
  });

  test("records the declared size on download/head without reading the body", async () => {
    const files = traced();
    await files.upload("a.txt", bytes("hello world"));
    // Never touch the body — the size comes from metadata, not bytes.
    await files.download("a.txt");
    await files.head("a.txt");

    const [download] = named("files.download");
    const [head] = named("files.head");
    expect(download?.attributes["files.size"]).toBe(11);
    expect(head?.attributes["files.size"]).toBe(11);
  });

  test("records from/to for copy and move", async () => {
    const files = traced();
    await files.upload("a.txt", bytes("hi"));
    await files.copy("a.txt", "b.txt");
    await files.move("b.txt", "c.txt");

    const [copy] = named("files.copy");
    const [move] = named("files.move");
    expect(copy?.attributes).toMatchObject({
      "files.from": "a.txt",
      "files.to": "b.txt",
    });
    expect(move?.attributes).toMatchObject({
      "files.from": "b.txt",
      "files.to": "c.txt",
    });
    expect(copy?.attributes["files.key"]).toBeUndefined();
  });

  test("records an exception and ERROR status, then re-throws", async () => {
    const files = traced();
    await expect(files.download("missing.txt")).rejects.toThrow();

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("files.download");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBeTruthy();
    expect(span?.events.some((event) => event.name === "exception")).toBe(true);
  });

  test("marks each item of a bulk call with files.bulk and one span apiece", async () => {
    const files = traced();
    await files.upload([
      { body: bytes("one"), key: "a.txt" },
      { body: bytes("three"), key: "b.txt" },
    ]);

    const uploads = named("files.upload");
    expect(uploads).toHaveLength(2);
    expect(uploads.every((s) => s.attributes["files.bulk"] === true)).toBe(
      true
    );
  });

  test("a single (non-bulk) call carries no bulk flag", async () => {
    const files = traced();
    await files.upload("c.txt", bytes("x"));
    expect(named("files.upload")[0]?.attributes["files.bulk"]).toBeUndefined();
  });

  test("spanPrefix renames the spans", async () => {
    const files = createFiles({
      adapter: memory(),
      plugins: [tracing({ spanPrefix: "storage.", tracer })],
    });
    await files.upload("a.txt", bytes("hi"));
    expect(named("storage.upload")).toHaveLength(1);
  });

  test("the attributes hook merges over the built-ins and can redact the key", async () => {
    const files = createFiles({
      adapter: memory(),
      plugins: [
        tracing({
          // Redact the built-in key, attach a tenant derived from it instead.
          attributes: (op) => ({
            "files.key": undefined,
            "tenant.id": "key" in op ? (op.key.split("/")[0] ?? "") : "",
          }),
          tracer,
        }),
      ],
    });

    await files.upload("acme/a.txt", bytes("hi"));
    const [span] = named("files.upload");
    expect(span?.attributes["tenant.id"]).toBe("acme");
    expect(span?.attributes["files.key"]).toBeUndefined();
  });

  test("opens a single span across retries", async () => {
    const base = memory();
    let attempts = 0;
    const files = new Files({
      adapter: {
        ...base,
        exists(key: string, opts?: OperationOptions) {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("temporary");
          }
          return base.exists(key, opts);
        },
      },
      plugins: [tracing({ tracer })],
      retries: { backoff: () => 0, max: 1 },
    });

    expect(await files.exists("whatever.txt")).toBe(false);
    // It really retried (2 attempts)…
    expect(attempts).toBe(2);
    // …but the plugin sits outside retries, so it's one logical span.
    expect(named("files.exists")).toHaveLength(1);
  });

  test("defaults to the global tracer when none is passed", async () => {
    // No SDK registered for the global API → a no-op tracer, so this just has
    // to not throw and produce no exported spans.
    const files = createFiles({ adapter: memory(), plugins: [tracing()] });
    await files.upload("a.txt", bytes("hi"));
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  test("works on a plain Files instance (wrap-only, no extend)", async () => {
    const files = new Files({
      adapter: memory(),
      plugins: [tracing({ tracer })],
    });
    await files.upload("a.txt", bytes("hi"));
    expect(named("files.upload")).toHaveLength(1);
  });

  test("records redacted conditional success and error outcomes", async () => {
    const plugin = tracing({ tracer });
    const { wrap } = plugin;
    if (!wrap) {
      throw new Error("tracing wrap missing");
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
        etag: "secret-etag",
        key: "a.txt",
        size: 5,
      })) as PluginNext);
    const exact: Extract<ConditionalFilesOperation, { kind: "download" }> = {
      etag: "secret-etag",
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
      etag: "secret-etag",
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
      source: { etag: "secret-etag" },
      to: "copy.txt",
    };
    await wrap(conditionalCopy, (() => Promise.resolve()) as PluginNext);

    const [upload] = named("files.upload");
    const [download] = named("files.download");
    const [remove] = named("files.delete");
    const [copy] = named("files.copy");
    expect(upload?.attributes).toMatchObject({
      "files.condition": "create",
      "files.operation": "upload",
      "files.size": 5,
    });
    expect(upload?.attributes["files.etag"]).toBeUndefined();
    expect(download?.attributes).toMatchObject({
      "files.condition": "exact-read",
      "files.operation": "download",
    });
    expect(download?.attributes["files.etag"]).toBeUndefined();
    expect(download?.status.code).toBe(SpanStatusCode.ERROR);
    expect(download?.events.some((event) => event.name === "exception")).toBe(
      true
    );
    expect(remove?.attributes).toMatchObject({
      "files.condition": "match-delete",
      "files.operation": "delete",
    });
    expect(copy?.attributes).toMatchObject({
      "files.condition": "conditional-copy",
      "files.from": "a.txt",
      "files.operation": "copy",
      "files.to": "copy.txt",
    });
  });
});

// Context propagation needs an async context manager registered globally. Scope
// it to this block and tear it down so it can't leak into other test files.
describe("tracing — span nesting", () => {
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
  });
  afterAll(() => {
    context.disable();
    contextManager.disable();
  });

  test("runs the operation with its span active so sub-work nests beneath it", async () => {
    exporter.reset();
    let activeSpanId: string | undefined;
    const probe: FilesPlugin = {
      name: "probe",
      wrap: (op, next) => {
        // Inner plugin runs while tracing's span is active.
        activeSpanId = trace.getActiveSpan()?.spanContext().spanId;
        return next(op);
      },
    };
    const files = createFiles({
      adapter: memory(),
      plugins: [tracing({ tracer }), probe],
    });

    await files.upload("a.txt", bytes("hi"));

    const [upload] = named("files.upload");
    expect(activeSpanId).toBeDefined();
    expect(activeSpanId).toBe(upload?.spanContext().spanId);
    // The stack unwinds: nothing is left active once the call settles.
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  test("nests the op span under the caller's active span", async () => {
    exporter.reset();
    const files = createFiles({
      adapter: memory(),
      plugins: [tracing({ tracer })],
    });

    const parent = tracer.startSpan("parent");
    await context.with(trace.setSpan(context.active(), parent), () =>
      files.upload("a.txt", bytes("hi"))
    );
    parent.end();

    const [upload] = named("files.upload");
    expect(upload?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });
});
