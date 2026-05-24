import { describe, expect, mock, test } from "bun:test";

import { fail } from "../src/cli/io.js";
import { Files, FilesError } from "../src/index.js";
import type {
  FilesActionEvent,
  FilesErrorEvent,
  FilesHooks,
} from "../src/index.js";
import {
  createResponsesFileTools,
  type FunctionCallItem,
} from "../src/openai/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const newFiles = () => new Files({ adapter: fakeAdapter() });

const call = (
  name: string,
  args: Record<string, unknown> | string,
  callId = "call_1"
): FunctionCallItem => ({
  arguments: typeof args === "string" ? args : JSON.stringify(args),
  call_id: callId,
  name,
  type: "function_call",
});

interface HookRecorder {
  actions: FilesActionEvent[];
  errors: FilesErrorEvent[];
  hooks: FilesHooks;
  order: string[];
}

const createHookRecorder = (): HookRecorder => {
  const actions: FilesActionEvent[] = [];
  const errors: FilesErrorEvent[] = [];
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
    },
    order,
  };
};

type ExitFn = typeof process.exit;
type WriteFn = typeof process.stderr.write;

interface Capture {
  exits: number[];
  restore: () => void;
}

const captureExit = (): Capture => {
  const exits: number[] = [];
  const origExit = process.exit.bind(process) as ExitFn;
  const origErr = process.stderr.write.bind(process.stderr) as WriteFn;

  (process.stderr as { write: WriteFn }).write = ((_: unknown) => true) as WriteFn;
  (process as { exit: ExitFn }).exit = ((code?: number): never => {
    exits.push(code ?? 0);
    throw new Error(`__exit:${code ?? 0}`);
  }) as ExitFn;

  return {
    exits,
    restore() {
      (process.stderr as { write: WriteFn }).write = origErr;
      (process as { exit: ExitFn }).exit = origExit;
    },
  };
};

describe("readonly feature", () => {
  test("FilesError supports the ReadOnly code", () => {
    const err = new FilesError("ReadOnly", "blocked");
    expect(err.code).toBe("ReadOnly");
    expect(err.message).toBe("blocked");
  });

  test("constructor readonly blocks every write surface before the adapter is called", async () => {
    const base = fakeAdapter();
    const upload = mock(base.upload);
    const del = mock(base.delete);
    const copy = mock(base.copy);
    const signedUploadUrl = mock(base.signedUploadUrl);
    const files = new Files({
      adapter: { ...base, copy, delete: del, signedUploadUrl, upload },
      readonly: true,
    });

    await expect(files.upload("a.txt", "x")).rejects.toMatchObject({
      code: "ReadOnly",
      message: "Cannot call upload() on a read-only Files instance.",
    });
    await expect(files.upload([])).rejects.toMatchObject({
      code: "ReadOnly",
    });
    await expect(files.delete("a.txt")).rejects.toMatchObject({
      code: "ReadOnly",
      message: "Cannot call delete() on a read-only Files instance.",
    });
    await expect(files.delete([])).rejects.toMatchObject({
      code: "ReadOnly",
    });
    await expect(files.copy("a.txt", "b.txt")).rejects.toMatchObject({
      code: "ReadOnly",
      message: "Cannot call copy() on a read-only Files instance.",
    });
    await expect(files.move("a.txt", "b.txt")).rejects.toMatchObject({
      code: "ReadOnly",
      message: "Cannot call move() on a read-only Files instance.",
    });
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toMatchObject({
      code: "ReadOnly",
      message:
        "Cannot call signedUploadUrl() on a read-only Files instance.",
    });

    expect(upload).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(signedUploadUrl).not.toHaveBeenCalled();
  });

  test("readonly() returns a derived read-only view that preserves reads and prefix behavior", async () => {
    const adapter = fakeAdapter();
    const writer = new Files({ adapter, prefix: "users", timeout: 1_000 });
    await writer.upload("123.txt", "hello");

    const files = writer.readonly();
    expect(files).not.toBe(writer);

    const downloaded = await files.download("123.txt");
    expect(await downloaded.text()).toBe("hello");

    const url = await files.url("123.txt", { expiresIn: 60 });
    expect(url).toContain(encodeURIComponent("users/123.txt"));

    await expect(files.upload("456.txt", "blocked")).rejects.toMatchObject({
      code: "ReadOnly",
    });
  });

  test("readonly file handles keep reads and block every write helper", async () => {
    const writer = new Files({ adapter: fakeAdapter() });
    await writer.upload("handle.txt", "payload");

    const file = writer.readonly().file("handle.txt");
    expect(await file.exists()).toBe(true);
    expect(await file.download().then((stored) => stored.text())).toBe(
      "payload"
    );

    await expect(file.upload("x")).rejects.toMatchObject({ code: "ReadOnly" });
    await expect(file.delete()).rejects.toMatchObject({ code: "ReadOnly" });
    await expect(file.copyTo("copy.txt")).rejects.toMatchObject({
      code: "ReadOnly",
    });
    await expect(file.copyFrom("copy.txt")).rejects.toMatchObject({
      code: "ReadOnly",
    });
    await expect(file.moveTo("moved.txt")).rejects.toMatchObject({
      code: "ReadOnly",
    });
    await expect(file.moveFrom("moved.txt")).rejects.toMatchObject({
      code: "ReadOnly",
    });
    await expect(file.signedUploadUrl({ expiresIn: 60 })).rejects.toMatchObject(
      {
        code: "ReadOnly",
      }
    );
  });

  test("a blocked write on a read-only instance still emits onError and an error action", async () => {
    const recorder = createHookRecorder();
    const writer = new Files({
      adapter: fakeAdapter(),
      hooks: recorder.hooks,
      prefix: "nested",
    });
    const files = writer.readonly();

    await expect(files.upload("blocked.txt", "payload")).rejects.toMatchObject({
      code: "ReadOnly",
      message: "Cannot call upload() on a read-only Files instance.",
    });

    expect(recorder.order).toEqual(["error:upload", "action:upload:error"]);
    expect(recorder.errors[0]).toMatchObject({
      error: expect.objectContaining({
        code: "ReadOnly",
        message: "Cannot call upload() on a read-only Files instance.",
      }),
      key: "blocked.txt",
      type: "upload",
    });
    expect(recorder.actions[0]).toMatchObject({
      error: expect.objectContaining({ code: "ReadOnly" }),
      key: "blocked.txt",
      status: "error",
      type: "upload",
    });
  });

  test("write tool execution rethrows ReadOnly when the wrapped Files instance is locked", async () => {
    const files = newFiles().readonly();
    const ft = createResponsesFileTools({ files });

    try {
      await ft.execute(call("uploadFile", { content: "x", key: "k" }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("ReadOnly");
      expect((error as FilesError).message).toBe(
        "Cannot call upload() on a read-only Files instance."
      );
    }
  });

  test("cli fail maps ReadOnly to exit code 2", () => {
    const cap = captureExit();

    try {
      expect(() =>
        fail(new FilesError("ReadOnly", "blocked"), {
          json: true,
          pretty: false,
          verbose: false,
        })
      ).toThrow("__exit:2");
      expect(cap.exits).toEqual([2]);
    } finally {
      cap.restore();
    }
  });
});
