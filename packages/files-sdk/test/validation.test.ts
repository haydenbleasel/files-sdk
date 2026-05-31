import { describe, expect, test } from "bun:test";

import { Files } from "../src/index.js";
import type { Adapter } from "../src/index.js";
import { validation } from "../src/validation/index.js";
import type { ValidationOptions } from "../src/validation/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const withValidation = (
  options: ValidationOptions = {},
  adapter: Adapter = fakeAdapter()
): Files => new Files({ adapter, plugins: [validation(options)] });

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

describe("validation plugin — size", () => {
  test("rejects an upload over maxSize", async () => {
    const files = withValidation({ maxSize: 10 });
    await expect(files.upload("big.txt", "x".repeat(20))).rejects.toThrow(
      /over the 10-byte limit/u
    );
  });

  test("allows an upload within maxSize and stores it", async () => {
    const files = withValidation({ maxSize: 10 });
    const result = await files.upload("a.txt", "hello");
    expect(result.size).toBe(5);
    const file = await files.download("a.txt");
    expect(await file.text()).toBe("hello");
  });

  test("rejects an upload under minSize", async () => {
    const files = withValidation({ minSize: 5 });
    await expect(files.upload("tiny.txt", "hi")).rejects.toThrow(
      /under the 5-byte minimum/u
    );
  });

  test("measures and rejects an oversize stream", async () => {
    const files = withValidation({ maxSize: 10 });
    await expect(
      files.upload("big", streamOf(new Uint8Array(20).fill(1)))
    ).rejects.toThrow(/over the 10-byte limit/u);
  });

  test("buffers an in-limit stream and stores it", async () => {
    const files = withValidation({ maxSize: 100 });
    const text = "stream body";
    await files.upload("s", streamOf(new TextEncoder().encode(text)));
    const file = await files.download("s");
    expect(await file.text()).toBe(text);
  });
});

describe("validation plugin — content type", () => {
  test("allows an exact match from an explicit content type", async () => {
    const files = withValidation({ allowedTypes: ["text/plain"] });
    await files.upload("a", "hi", { contentType: "text/plain" });
    expect(await files.exists("a")).toBe(true);
  });

  test("allows a group wildcard, inferring the type from the key", async () => {
    const files = withValidation({ allowedTypes: ["image/*"] });
    await files.upload("photo.png", new Uint8Array([1, 2, 3]));
    expect(await files.exists("photo.png")).toBe(true);
  });

  test("reads a Blob's own type when no content type is given", async () => {
    const files = withValidation({ allowedTypes: ["image/png"] });
    await files.upload(
      "blob",
      new Blob([new Uint8Array([1])], { type: "image/png" })
    );
    expect(await files.exists("blob")).toBe(true);
  });

  test("rejects a disallowed type, ignoring charset params", async () => {
    const files = withValidation({ allowedTypes: ["image/*"] });
    await expect(files.upload("notes.txt", "hello")).rejects.toThrow(
      /type "text\/plain", which is not one of the allowed types/u
    );
  });
});

describe("validation plugin — key naming", () => {
  test("rejects a key that fails the RegExp", async () => {
    const files = withValidation({ key: /^[\w.-]+$/u });
    await expect(files.upload("bad key.txt", "x")).rejects.toThrow(
      /key "bad key\.txt" is not allowed/u
    );
  });

  test("allows a key that matches the RegExp", async () => {
    const files = withValidation({ key: /^[\w.-]+$/u });
    await files.upload("ok-1.txt", "x");
    expect(await files.exists("ok-1.txt")).toBe(true);
  });

  test("rejects a key that fails the predicate", async () => {
    const files = withValidation({ key: (k) => k.startsWith("user/") });
    await expect(files.upload("x.txt", "x")).rejects.toThrow(/not allowed/u);
  });

  test("allows a key that passes the predicate", async () => {
    const files = withValidation({ key: (k) => k.startsWith("user/") });
    await files.upload("user/x.txt", "x");
    expect(await files.exists("user/x.txt")).toBe(true);
  });
});

describe("validation plugin — copy and move", () => {
  test("guards the copy destination key", async () => {
    const files = withValidation({ key: /^allowed\//u });
    await files.upload("allowed/a.txt", "hello");
    await files.copy("allowed/a.txt", "allowed/b.txt");
    const copied = await files.download("allowed/b.txt");
    expect(await copied.text()).toBe("hello");
    await expect(files.copy("allowed/a.txt", "blocked/b.txt")).rejects.toThrow(
      /key "blocked\/b\.txt" is not allowed/u
    );
  });

  test("guards the move destination key", async () => {
    const files = withValidation({ key: /^allowed\//u });
    await files.upload("allowed/c.txt", "world");
    await files.move("allowed/c.txt", "allowed/d.txt");
    const moved = await files.download("allowed/d.txt");
    expect(await moved.text()).toBe("world");
    expect(await files.exists("allowed/c.txt")).toBe(false);

    await files.upload("allowed/e.txt", "x");
    await expect(files.move("allowed/e.txt", "blocked/e.txt")).rejects.toThrow(
      /not allowed/u
    );
  });
});

describe("validation plugin — signed uploads", () => {
  test("throws when a size rule is set", async () => {
    const files = withValidation({ maxSize: 10 });
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toThrow(/bypasses size and type/u);
  });

  test("throws when a type rule is set", async () => {
    const files = withValidation({ allowedTypes: ["image/*"] });
    await expect(
      files.signedUploadUrl("a.png", { expiresIn: 60 })
    ).rejects.toThrow(/bypasses size and type/u);
  });

  test("enforces the key rule but otherwise mints the URL", async () => {
    const files = withValidation({ key: /^ok/u });
    await expect(
      files.signedUploadUrl("nope.txt", { expiresIn: 60 })
    ).rejects.toThrow(/not allowed/u);
    const signed = await files.signedUploadUrl("ok.txt", { expiresIn: 60 });
    expect(signed.url).toContain("ok.txt");
  });
});

describe("validation plugin — no rules", () => {
  test("passes every operation through untouched", async () => {
    const files = withValidation();
    await files.upload("a.txt", "hello");
    const file = await files.download("a.txt");
    expect(await file.text()).toBe("hello");
    await files.copy("a.txt", "b.txt");
    await files.move("b.txt", "c.txt");
    expect(await files.url("a.txt")).toContain("a.txt");
    const signed = await files.signedUploadUrl("a.txt", { expiresIn: 60 });
    expect(signed.url).toBeDefined();
  });
});
