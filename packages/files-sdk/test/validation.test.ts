import { describe, expect, test } from "bun:test";

import { contentType } from "../src/content-type/index.js";
import { dedup } from "../src/dedup/index.js";
import { failover } from "../src/failover/index.js";
import { Files, FilesError } from "../src/index.js";
import type { Adapter } from "../src/index.js";
import { softDelete } from "../src/soft-delete/index.js";
import { validation, ValidationError } from "../src/validation/index.js";
import type { ValidationOptions } from "../src/validation/index.js";
import { versioning } from "../src/versioning/index.js";
import { fakeAdapter, withCapabilities } from "./fake-adapter.js";

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

const typeOf = async (files: Files, key: string): Promise<string> => {
  const file = await files.head(key);
  return file.contentType;
};

const caught = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to throw");
};

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

  test("rejects an oversize Blob from its size, without reading it", async () => {
    let read = false;
    // A stand-in for a huge on-disk File: it reports a size but every read
    // path is booby-trapped, so the check must not buffer it.
    class Huge extends Blob {
      readonly claimed = 5 * 1024 ** 3;
      override get size(): number {
        return this.claimed;
      }
      override arrayBuffer(): Promise<ArrayBuffer> {
        read = true;
        return super.arrayBuffer();
      }
      override stream(): ReturnType<Blob["stream"]> {
        read = true;
        return super.stream();
      }
    }
    const files = withValidation({ maxSize: 10 * 1024 * 1024 });
    await expect(files.upload("big.bin", new Huge(["x"]))).rejects.toThrow(
      /over the 10485760-byte limit/u
    );
    expect(read).toBe(false);
  });

  test("forwards a known-length body as-is, keeping the adapter's type default", async () => {
    let seen: unknown;
    const adapter = fakeAdapter();
    const spy: Adapter = {
      ...adapter,
      upload: (key, body, opts) => {
        seen = { body, contentType: opts?.contentType };
        return adapter.upload(key, body, opts);
      },
    };
    const files = withValidation({ maxSize: 100 }, spy);
    const blob = new Blob(["hi"], { type: "image/png" });
    await files.upload("a", blob);
    expect(seen).toEqual({ body: blob, contentType: undefined });
    await files.upload("b", "hi");
    expect(seen).toEqual({ body: "hi", contentType: undefined });
  });

  test("measures strings in UTF-8 bytes", async () => {
    const files = withValidation({ maxSize: 9, minSize: 9 });
    // 1 + 2 + 3 + 3 (a lone surrogate encodes as U+FFFD) = 9 bytes; the emoji
    // pair alone is 4.
    await files.upload("a", "a\u00E9\u20AC\uD800");
    await files.upload("b", "a\u00E9\u{1F600}\u0000\u0000");
    await expect(files.upload("c", "\u{1F600}")).rejects.toThrow(
      /is 4 bytes, under the 9-byte minimum/u
    );
    const stored = await files.download("a");
    expect(await stored.text()).toBe("a\u00E9\u20AC\uFFFD");
  });

  test("buffers a Blob that can't report a finite size, keeping its type", async () => {
    class Unsized extends Blob {
      readonly claimed = Number.NaN;
      override get size(): number {
        return this.claimed;
      }
    }
    const files = withValidation({ maxSize: 4 });
    await expect(
      files.upload("big", new Unsized(["too long"]))
    ).rejects.toThrow(/is 8 bytes, over the 4-byte limit/u);
    await files.upload("ok", new Unsized(["tiny"], { type: "text/csv" }));
    const file = await files.download("ok");
    expect(await file.text()).toBe("tiny");
    expect(file.type).toBe("text/csv");
    await files.upload("untyped", new Unsized(["tiny"]));
    expect(await typeOf(files, "untyped")).toBe("application/octet-stream");
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

  test("stores the type it approved from the key", async () => {
    const files = withValidation({ allowedTypes: ["image/*"] });
    await files.upload("photo.png", new Uint8Array([1, 2, 3]));
    expect(await typeOf(files, "photo.png")).toBe("image/png");
  });

  test("stores the approved type on the size-rule path too", async () => {
    const files = withValidation({
      allowedTypes: ["image/*"],
      maxSize: 100,
    });
    await files.upload("photo.png", "not really a png");
    await files.upload(
      "clip.png",
      streamOf(new TextEncoder().encode("streamed"))
    );
    expect(await typeOf(files, "photo.png")).toBe("image/png");
    expect(await typeOf(files, "clip.png")).toBe("image/png");
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

  test("advertises no direct uploads only when a size or type rule is set", () => {
    const signing = withCapabilities(fakeAdapter(), {
      signedUpload: { supported: true },
    });
    const caps = (options: ValidationOptions) =>
      new Files({ adapter: signing, plugins: [validation(options)] })
        .capabilities.signedUpload.supported;
    expect(caps({ maxSize: 10 })).toBe(false);
    expect(caps({ allowedTypes: ["image/*"] })).toBe(false);
    expect(caps({ key: /^ok/u })).toBe(true);
  });
});

describe("validation plugin — error discrimination", () => {
  test("an over-maxSize failure has reason size", async () => {
    const files = withValidation({ maxSize: 10 });
    const error = await caught(files.upload("big.txt", "x".repeat(20)));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).reason).toBe("size");
  });

  test("an under-minSize failure has reason size", async () => {
    const files = withValidation({ minSize: 5 });
    const error = await caught(files.upload("tiny.txt", "hi"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).reason).toBe("size");
  });

  test("a disallowed type has reason type", async () => {
    const files = withValidation({ allowedTypes: ["image/*"] });
    const error = await caught(files.upload("notes.txt", "hello"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).reason).toBe("type");
  });

  test("a disallowed key has reason key", async () => {
    const files = withValidation({ key: /^[\w.-]+$/u });
    const error = await caught(files.upload("bad key.txt", "x"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).reason).toBe("key");
  });

  test("is a FilesError with code Invalid, so it is never retried", async () => {
    const files = withValidation({ maxSize: 10 });
    const error = await caught(files.upload("big.txt", "x".repeat(20)));
    expect(error).toBeInstanceOf(FilesError);
    expect((error as FilesError).code).toBe("Invalid");
    expect((error as Error).name).toBe("ValidationError");
  });

  test("the signedUploadUrl fail-closed throw is not a ValidationError", async () => {
    const files = withValidation({ maxSize: 10 });
    const error = await caught(
      files.signedUploadUrl("a.txt", { expiresIn: 60 })
    );
    expect(error).toBeInstanceOf(FilesError);
    expect(error).not.toBeInstanceOf(ValidationError);
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

describe("validation plugin — placement", () => {
  const html = new TextEncoder().encode("<html><script>x</script></html>");

  test("after contentType(), it checks the corrected type", async () => {
    const files = new Files({
      adapter: fakeAdapter(),
      plugins: [contentType(), validation({ allowedTypes: ["image/*"] })],
    });
    const error = await caught(files.upload("avatar.png", html));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).reason).toBe("type");
  });

  test("before versioning/softDelete/dedup, their internal keys pass", async () => {
    const files = new Files({
      adapter: fakeAdapter(),
      plugins: [
        validation({ key: /^[\w.-]+$/u, minSize: 1 }),
        versioning(),
        softDelete(),
        dedup(),
      ],
    });
    await files.upload("a.txt", "one");
    await files.upload("a.txt", "two");
    await files.delete("a.txt");
    expect(await files.exists("a.txt")).toBe(false);
  });
});

describe("validation plugin — rejections are permanent", () => {
  test("an outer failover() doesn't re-send a rejected write to a plugin-less secondary", async () => {
    const secondary = fakeAdapter();
    const files = new Files({
      adapter: fakeAdapter(),
      plugins: [
        failover({ secondaries: secondary }),
        validation({ allowedTypes: ["image/*"], key: /^ok/u, maxSize: 4 }),
      ],
    });
    const rejections = [
      () => files.upload("ok.png", "too many bytes"),
      () => files.upload("ok.txt", "tiny"),
      () => files.upload("bad.png", "tiny"),
      () => files.signedUploadUrl("ok.png", { expiresIn: 60 }),
    ];
    for (const rejected of rejections) {
      // eslint-disable-next-line no-await-in-loop -- each rejection is inspected on its own
      const failure = await rejected().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FilesError);
      expect((failure as FilesError).permanent).toBe(true);
      expect((failure as FilesError).message).toMatch(/^validation: /u);
    }
    expect(secondary.raw.size).toBe(0);
  });
});
