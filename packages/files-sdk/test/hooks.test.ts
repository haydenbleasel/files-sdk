import { describe, expect, test } from "bun:test";

import { Files, FilesError } from "../src/index.js";
import type {
  Adapter,
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
  test("a successful single action reports only the caller-facing fields", async () => {
    const recorder = createHookRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: recorder.hooks,
      prefix: "uploads",
    });

    await files.upload("avatar.txt", "hello", {
      contentType: "text/plain",
      metadata: { user: "1" },
    });

    expect(recorder.errors).toHaveLength(0);
    expect(recorder.retries).toHaveLength(0);
    expect(recorder.actions).toHaveLength(1);

    const [event] = recorder.actions;
    expect(event).toMatchObject({
      // The caller's key, never the internal "uploads/avatar.txt" path.
      key: "avatar.txt",
      status: "success",
      type: "upload",
    });
    expect(event?.result).toMatchObject({ key: "avatar.txt", size: 5 });
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
    // Lock the minimal shape: no internal path, options, body summary, etc.
    expect(Object.keys(event ?? {}).toSorted()).toEqual([
      "durationMs",
      "key",
      "result",
      "status",
      "type",
    ]);
  });

  test("operations run normally when no hooks (or only some) are configured", async () => {
    const noHooks = new Files({ adapter: fakeAdapter() });
    const uploaded = await noHooks.upload("a.txt", "ok");
    expect(uploaded.key).toBe("a.txt");

    // Only onAction set — the missing onError / onRetry must not throw.
    const seen: string[] = [];
    const partial = new Files({
      adapter: fakeAdapter(),
      hooks: { onAction: (event) => seen.push(event.type) },
    });
    await partial.upload("b.txt", "ok");
    expect(seen).toEqual(["upload"]);
  });

  test("bulk upload emits one aggregated action and no onError for partial failures", async () => {
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
      // The caller's keys, in input order — including the invalid one.
      keys: ["ok.txt", "bin.dat", ""],
      status: "success",
      type: "upload",
    });
    // The aggregated result (with its per-item errors) rides on the event.
    expect(recorder.actions[0]?.result).toEqual(result);
  });

  test("a validation failure emits onError before the final error action", async () => {
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

    expect(recorder.order).toEqual(["error:download", "action:download:error"]);
    expect(recorder.errors[0]).toMatchObject({
      error: expect.objectContaining({
        code: "Provider",
        message: "key must be a non-empty string",
      }),
      key: "",
      type: "download",
    });
    expect(recorder.actions[0]).toMatchObject({
      error: expect.objectContaining({ code: "Provider" }),
      key: "",
      status: "error",
      type: "download",
    });
  });

  test("a retryable failure emits onRetry, then the operation succeeds", async () => {
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

    expect(recorder.retries).toHaveLength(1);
    expect(recorder.retries[0]).toMatchObject({
      attempt: 1,
      delayMs: 0,
      error: expect.objectContaining({ message: "temporary" }),
      key: "exists.txt",
      maxRetries: 1,
      type: "exists",
    });
    expect(recorder.actions.at(-1)).toMatchObject({
      key: "exists.txt",
      result: true,
      status: "success",
      type: "exists",
    });
  });

  test("a non-retryable failure never emits onRetry", async () => {
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
      status: "error",
      type: "head",
    });
  });

  test("stream uploads are never retried even when retries are configured", async () => {
    const base = fakeAdapter();
    const recorder = createHookRecorder();
    const adapter: Adapter = {
      ...base,
      upload(_key, _body, _opts) {
        return Promise.reject(new Error("stream upload failed"));
      },
    };
    const files = new Files({
      adapter,
      hooks: recorder.hooks,
      retries: { backoff: () => 0, max: 5 },
    });

    await expect(
      files.upload("stream.txt", streamOf("payload"))
    ).rejects.toMatchObject({
      code: "Provider",
      message: "stream upload failed",
    });

    expect(recorder.retries).toHaveLength(0);
    expect(recorder.errors).toHaveLength(1);
    expect(recorder.actions[0]).toMatchObject({
      error: expect.objectContaining({ message: "stream upload failed" }),
      key: "stream.txt",
      status: "error",
      type: "upload",
    });
  });

  test("copy, list, url, and signedUploadUrl carry their identifying fields", async () => {
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

    const find = (type: FilesActionEvent["type"]) =>
      recorder.actions.find((event) => event.type === type);

    expect(find("copy")).toMatchObject({
      from: "docs/a.txt",
      status: "success",
      to: "docs/b.txt",
      type: "copy",
    });
    expect(find("list")).toMatchObject({ status: "success", type: "list" });
    expect(find("url")).toMatchObject({
      key: "docs/a.txt",
      result: url,
      status: "success",
      type: "url",
    });
    expect(find("signedUploadUrl")).toMatchObject({
      key: "docs/c.txt",
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

    await files.download(["a.txt", "missing.txt"]);
    await files.head(["a.txt", "missing.txt"]);
    await files.exists(["a.txt", "missing.txt"]);
    await files.delete(["a.txt", "missing.txt"]);

    // Bulk events carry `keys`; single events carry `key`.
    const bulkActions = recorder.actions.filter(
      (event) => event.keys !== undefined
    );
    expect(bulkActions.map((event) => event.type)).toEqual([
      "download",
      "head",
      "exists",
      "delete",
    ]);
    for (const event of bulkActions) {
      expect(event.status).toBe("success");
      expect(event.keys).toEqual(["a.txt", "missing.txt"]);
    }
    expect(recorder.errors).toHaveLength(0);
  });

  test("a throwing hook is swallowed and does not fail the operation", async () => {
    const errorEvents: FilesErrorEvent[] = [];
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: {
        onAction() {
          throw new Error("hook failed");
        },
        onError(event) {
          errorEvents.push(event);
        },
      },
    });

    const result = await files.upload("safe.txt", "ok");

    expect(result.key).toBe("safe.txt");
    // The hook threw on success — that must not surface as an operation error.
    expect(errorEvents).toHaveLength(0);
    expect(await files.download("safe.txt").then((file) => file.text())).toBe(
      "ok"
    );
  });

  test("file handles emit the same hook events as direct Files calls", async () => {
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
      recorder.actions.map((event) => [event.type, event.key, event.status])
    ).toEqual([
      ["upload", "handle.txt", "success"],
      ["url", "handle.txt", "success"],
      ["delete", "handle.txt", "success"],
    ]);
  });

  test("onRetry fires once per scheduled retry with an incrementing attempt", async () => {
    const base = fakeAdapter();
    let attempts = 0;
    const recorder = createHookRecorder();
    const files = new Files({
      adapter: {
        ...base,
        exists(key: string, opts?: OperationOptions) {
          attempts += 1;
          if (attempts <= 2) {
            throw new Error(`fail ${attempts}`);
          }
          return base.exists(key, opts);
        },
      },
      hooks: recorder.hooks,
      retries: { backoff: () => 0, max: 2 },
    });

    await files.upload("k.txt", "ok");
    expect(await files.exists("k.txt")).toBe(true);

    // Two failures then success: one onRetry per scheduled retry.
    expect(recorder.retries.map((event) => event.attempt)).toEqual([1, 2]);
    expect(
      recorder.retries.every(
        (event) => event.maxRetries === 2 && event.type === "exists"
      )
    ).toBe(true);
  });

  test("onRetry carries copy's from/to identity", async () => {
    const base = fakeAdapter();
    let attempts = 0;
    const recorder = createHookRecorder();
    const files = new Files({
      adapter: {
        ...base,
        copy(from: string, to: string) {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("transient");
          }
          return base.copy(from, to);
        },
      },
      hooks: recorder.hooks,
      retries: { backoff: () => 0, max: 1 },
    });

    await files.upload("a.txt", "a");
    await files.copy("a.txt", "b.txt");

    expect(recorder.retries[0]).toMatchObject({
      attempt: 1,
      from: "a.txt",
      to: "b.txt",
      type: "copy",
    });
  });

  test("a bulk operation that hard-throws emits onError and an error action", async () => {
    const base = fakeAdapter();
    const recorder = createHookRecorder();
    const files = new Files({
      adapter: {
        ...base,
        deleteMany() {
          // A total failure (e.g. the bucket is unreachable), not a partial
          // one — this rejects rather than returning per-key `errors`.
          return Promise.reject(new Error("bucket offline"));
        },
      },
      hooks: recorder.hooks,
    });

    await expect(files.delete(["a.txt", "b.txt"])).rejects.toMatchObject({
      code: "Provider",
      message: "bucket offline",
    });

    expect(recorder.order).toEqual(["error:delete", "action:delete:error"]);
    expect(recorder.errors[0]).toMatchObject({
      error: expect.objectContaining({ message: "bucket offline" }),
      keys: ["a.txt", "b.txt"],
      type: "delete",
    });
    expect(recorder.actions[0]).toMatchObject({
      keys: ["a.txt", "b.txt"],
      status: "error",
      type: "delete",
    });
  });

  test("throwing onError and onRetry hooks are swallowed without changing the outcome", async () => {
    const base = fakeAdapter();
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
        head(_key: string, _opts?: OperationOptions): Promise<never> {
          throw new FilesError("NotFound", "missing");
        },
      },
      // onError is set but onAction is not — the action wrapper must still
      // run, and a throwing onError must not mask the original rejection.
      hooks: {
        onError() {
          throw new Error("onError boom");
        },
        onRetry() {
          throw new Error("onRetry boom");
        },
      },
      retries: { backoff: () => 0, max: 1 },
    });

    await files.upload("k.txt", "ok");

    // A throwing onRetry must not prevent the retry from succeeding.
    expect(await files.exists("k.txt")).toBe(true);

    // A throwing onError must not mask the original NotFound rejection.
    await expect(files.head("missing.txt")).rejects.toMatchObject({
      code: "NotFound",
      message: "missing",
    });
  });
});
