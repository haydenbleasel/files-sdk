import { describe, expect, test } from "bun:test";

import { Files, FilesError } from "../src/index.js";
import type {
  Adapter,
  BulkOptions,
  FilesActionEvent,
  FilesErrorEvent,
  FilesHooks,
  FilesRetryEvent,
  OperationOptions,
} from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

interface HookRecorder {
  actions: FilesActionEvent[];
  errors: FilesErrorEvent[];
  hooks: FilesHooks;
  order: string[];
  retries: FilesRetryEvent[];
}

const createHookRecorder = (): HookRecorder => {
  const actions: FilesActionEvent[] = [];
  const errors: FilesErrorEvent[] = [];
  const retries: FilesRetryEvent[] = [];
  const order: string[] = [];

  return {
    actions,
    errors,
    hooks: {
      onAction(event) {
        order.push(`action:${event.type}:${event.status}`);
        actions.push(event);
      },
      onError(event) {
        order.push(`error:${event.type}`);
        errors.push(event);
      },
      onRetry(event) {
        order.push(`retry:${event.type}:${event.attempt}`);
        retries.push(event);
      },
    },
    order,
    retries,
  };
};

const streamOf = (value: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
};

describe("Files hooks", () => {
  test("single actions expose merged options, sanitized inputs, and public/internal keys", async () => {
    const recorder = createHookRecorder();
    const defaultsSignal = new AbortController();
    const callSignal = new AbortController();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: recorder.hooks,
      prefix: "uploads",
      retries: {
        backoff: () => 0,
        max: 2,
      },
      signal: defaultsSignal.signal,
      timeout: 1_000,
    });

    await files.upload("avatar.txt", "hello", {
      contentType: "text/plain",
      metadata: { user: "1" },
      signal: callSignal.signal,
      timeout: 250,
    });

    expect(recorder.errors).toHaveLength(0);
    expect(recorder.retries).toHaveLength(0);
    expect(recorder.actions).toHaveLength(1);
    expect(recorder.actions[0]).toMatchObject({
      adapter: "fake",
      attemptCount: 1,
      bulk: false,
      key: "avatar.txt",
      options: {
        contentType: "text/plain",
        metadata: { user: "1" },
        retries: { max: 2 },
        timeout: 250,
      },
      path: "uploads/avatar.txt",
      status: "success",
      type: "upload",
    });
    expect(recorder.actions[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect("signal" in (recorder.actions[0]?.options ?? {})).toBe(false);
    expect(recorder.actions[0]?.input).toEqual({
      body: {
        contentType: "text/plain; charset=utf-8",
        kind: "string",
        size: 5,
      },
    });
    expect(recorder.actions[0]?.result).toMatchObject({
      contentType: "text/plain",
      key: "avatar.txt",
      size: 5,
    });
  });

  test("bulk calls skip hook instrumentation when no hooks are configured", async () => {
    let reads = 0;
    const opts = {} as BulkOptions;
    Object.defineProperty(opts, "custom", {
      enumerable: true,
      get() {
        reads += 1;
        return "noop";
      },
    });
    const files = new Files({ adapter: fakeAdapter() });

    const result = await files.upload([{ body: "ok", key: "a.txt" }], opts);

    expect(result.uploaded.map((item) => item.key)).toEqual(["a.txt"]);
    expect(reads).toBe(0);
  });

  test("bulk upload emits one action with aggregated result and never emits onError for partial failures", async () => {
    const recorder = createHookRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: recorder.hooks,
      prefix: "uploads",
    });

    const result = await files.upload(
      [
        { body: "ok", key: "ok.txt" },
        { body: new Uint8Array([1, 2]), key: "bin.dat" },
        { body: "bad", key: "" },
      ],
      { concurrency: 2, stopOnError: false }
    );

    expect(result.uploaded.map((item) => item.key)).toEqual([
      "ok.txt",
      "bin.dat",
    ]);
    expect(result.errors?.map((item) => item.key)).toEqual([""]);
    expect(recorder.errors).toHaveLength(0);
    expect(recorder.retries).toHaveLength(0);
    expect(recorder.actions).toHaveLength(1);
    expect(recorder.actions[0]).toMatchObject({
      bulk: true,
      keys: ["ok.txt", "bin.dat", ""],
      options: { concurrency: 2, stopOnError: false },
      paths: ["uploads/ok.txt", "uploads/bin.dat", undefined],
      status: "success",
      type: "upload",
    });
    expect(recorder.actions[0]?.input).toMatchObject({
      items: [
        {
          body: {
            contentType: "text/plain; charset=utf-8",
            kind: "string",
            size: 2,
          },
          key: "ok.txt",
          path: "uploads/ok.txt",
        },
        {
          body: {
            kind: "uint8Array",
            size: 2,
          },
          key: "bin.dat",
          path: "uploads/bin.dat",
        },
        {
          body: {
            contentType: "text/plain; charset=utf-8",
            kind: "string",
            size: 3,
          },
          key: "",
          path: undefined,
        },
      ],
    });
    expect(recorder.actions[0]?.result).toEqual(result);
  });

  test("validation failures emit onError before the final error action", async () => {
    const recorder = createHookRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: recorder.hooks,
      prefix: "uploads",
    });

    await expect(files.download("")).rejects.toMatchObject({
      code: "Provider",
      message: "key must be a non-empty string",
    });

    expect(recorder.order).toEqual([
      "error:download",
      "action:download:error",
    ]);
    expect(recorder.errors).toHaveLength(1);
    expect(recorder.actions).toHaveLength(1);
    expect(recorder.errors[0]).toMatchObject({
      attemptCount: 1,
      error: expect.objectContaining({
        code: "Provider",
        message: "key must be a non-empty string",
      }),
      key: "",
      path: undefined,
      type: "download",
    });
    expect(recorder.actions[0]).toMatchObject({
      error: expect.objectContaining({
        code: "Provider",
        message: "key must be a non-empty string",
      }),
      key: "",
      path: undefined,
      status: "error",
      type: "download",
    });
  });

  test("retryable failures emit onRetry and update the final attempt count", async () => {
    const base = fakeAdapter();
    let attempts = 0;
    const recorder = createHookRecorder();
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
      hooks: recorder.hooks,
      retries: { backoff: () => 0, max: 1 },
    });

    await files.upload("exists.txt", "ok");
    expect(await files.exists("exists.txt")).toBe(true);

    expect(recorder.retries).toEqual([
      expect.objectContaining({
        adapter: "fake",
        attempt: 1,
        delayMs: 0,
        error: expect.objectContaining({ message: "temporary" }),
        key: "exists.txt",
        maxRetries: 1,
        options: expect.objectContaining({
          retries: expect.objectContaining({ max: 1 }),
        }),
        path: "exists.txt",
        type: "exists",
      }),
    ]);
    expect(recorder.actions.at(-1)).toMatchObject({
      attemptCount: 2,
      key: "exists.txt",
      path: "exists.txt",
      result: true,
      status: "success",
      type: "exists",
    });
  });

  test("non-retryable failures never emit onRetry", async () => {
    const base = fakeAdapter();
    const recorder = createHookRecorder();
    const files = new Files({
      adapter: {
        ...base,
        head(_key: string, _opts?: OperationOptions) {
          throw new FilesError("NotFound", "missing");
        },
      },
      hooks: recorder.hooks,
      retries: { backoff: () => 0, max: 3 },
    });

    await expect(files.head("missing.txt")).rejects.toMatchObject({
      code: "NotFound",
    });

    expect(recorder.retries).toHaveLength(0);
    expect(recorder.errors).toHaveLength(1);
    expect(recorder.actions).toHaveLength(1);
    expect(recorder.actions[0]).toMatchObject({
      attemptCount: 1,
      status: "error",
      type: "head",
    });
  });

  test("stream uploads are never retried even when retries are configured", async () => {
    const base = fakeAdapter();
    const recorder = createHookRecorder();
    const adapter: Adapter = {
      ...base,
      async upload(_key, _body, _opts) {
        throw new Error("stream upload failed");
      },
    };
    const files = new Files({
      adapter,
      hooks: recorder.hooks,
      retries: { backoff: () => 0, max: 5 },
    });

    await expect(files.upload("stream.txt", streamOf("payload"))).rejects.toMatchObject(
      {
        code: "Provider",
        message: "stream upload failed",
      }
    );

    expect(recorder.retries).toHaveLength(0);
    expect(recorder.errors).toHaveLength(1);
    expect(recorder.actions[0]).toMatchObject({
      attemptCount: 1,
      error: expect.objectContaining({ message: "stream upload failed" }),
      key: "stream.txt",
      status: "error",
      type: "upload",
    });
  });

  test("copy, list, url, and signedUploadUrl include the expected hook payload fields", async () => {
    const recorder = createHookRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: recorder.hooks,
      prefix: "scope",
    });

    await files.upload("docs/a.txt", "a");
    await files.copy("docs/a.txt", "docs/b.txt");
    await files.list({ limit: 10, prefix: "docs/" });
    const url = await files.url("docs/a.txt", { expiresIn: 30 });
    const signed = await files.signedUploadUrl("docs/c.txt", {
      contentType: "text/plain",
      expiresIn: 60,
    });

    const copyEvent = recorder.actions.find((event) => event.type === "copy");
    const listEvent = recorder.actions.find((event) => event.type === "list");
    const urlEvent = recorder.actions.find((event) => event.type === "url");
    const signedEvent = recorder.actions.find(
      (event) => event.type === "signedUploadUrl"
    );

    expect(copyEvent).toMatchObject({
      from: "docs/a.txt",
      fromPath: "scope/docs/a.txt",
      status: "success",
      to: "docs/b.txt",
      toPath: "scope/docs/b.txt",
      type: "copy",
    });
    expect(listEvent).toMatchObject({
      effectivePrefix: "scope/docs/",
      options: { limit: 10, prefix: "docs/" },
      requestedPrefix: "docs/",
      status: "success",
      type: "list",
    });
    expect(urlEvent).toMatchObject({
      key: "docs/a.txt",
      options: { expiresIn: 30 },
      path: "scope/docs/a.txt",
      result: url,
      status: "success",
      type: "url",
    });
    expect(signedEvent).toMatchObject({
      key: "docs/c.txt",
      options: { contentType: "text/plain", expiresIn: 60 },
      path: "scope/docs/c.txt",
      result: signed,
      status: "success",
      type: "signedUploadUrl",
    });
    expect(url).toContain("scope%2Fdocs%2Fa.txt");
    expect(signed).toMatchObject({ method: "PUT" });
  });

  test("bulk download, head, exists, and delete each emit a single action", async () => {
    const recorder = createHookRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: recorder.hooks,
      prefix: "bulk",
    });

    await files.upload("a.txt", "a");
    await files.upload("b.txt", "b");

    const download = await files.download(["a.txt", "missing.txt"]);
    const head = await files.head(["a.txt", "missing.txt"]);
    const exists = await files.exists(["a.txt", "missing.txt"]);
    const deleted = await files.delete(["a.txt", "missing.txt"]);

    expect(download.errors?.map((item) => item.key)).toEqual(["missing.txt"]);
    expect(head.errors?.map((item) => item.key)).toEqual(["missing.txt"]);
    expect(exists).toEqual({ existing: ["a.txt"], missing: ["missing.txt"] });
    expect(deleted).toEqual({ deleted: ["a.txt", "missing.txt"] });

    const bulkActions = recorder.actions.filter((event) => event.bulk);
    expect(bulkActions.map((event) => event.type)).toEqual([
      "download",
      "head",
      "exists",
      "delete",
    ]);
    for (const event of bulkActions) {
      expect(event.status).toBe("success");
      expect(event.attemptCount).toBe(1);
      expect(event.keys).toEqual(["a.txt", "missing.txt"]);
      expect(event.paths).toEqual(["bulk/a.txt", "bulk/missing.txt"]);
    }
    expect(recorder.errors).toHaveLength(0);
  });

  test("hook failures are swallowed and do not cascade into onError", async () => {
    let settled = false;
    const errorEvents: FilesErrorEvent[] = [];
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: {
        async onAction() {
          await Promise.resolve();
          settled = true;
          throw new Error("hook failed");
        },
        onError(event) {
          errorEvents.push(event);
        },
      },
    });

    const result = await files.upload("awaited.txt", "ok");

    expect(result.key).toBe("awaited.txt");
    expect(settled).toBe(true);
    expect(errorEvents).toHaveLength(0);
    expect(await files.download("awaited.txt").then((file) => file.text())).toBe(
      "ok"
    );
  });

  test("file handles emit the same hook payloads as direct Files calls", async () => {
    const recorder = createHookRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: recorder.hooks,
      prefix: "nested",
    });

    const file = files.file("handle.txt");
    await file.upload("payload");
    await file.url({ expiresIn: 60 });
    await file.delete();

    expect(
      recorder.actions.map((event) => [event.type, event.key, event.path, event.status])
    ).toEqual([
      ["upload", "handle.txt", "nested/handle.txt", "success"],
      ["url", "handle.txt", "nested/handle.txt", "success"],
      ["delete", "handle.txt", "nested/handle.txt", "success"],
    ]);
  });
});
