import { describe, expect, spyOn, test } from "bun:test";

import { Files, handlers } from "../src/index.js";
import type { FilesActionEvent, FilesPlugin, Receipt } from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

/**
 * A body-transforming plugin, like `encryption` / `compression`: it swaps the
 * upload body for different bytes before the adapter ever sees it. Used to pin
 * down what `sha256` attests — the body the caller passed, not the stored bytes.
 */
const bodyRewriter = (): FilesPlugin => ({
  name: "body-rewriter",
  wrap: handlers({
    upload: (op, next) =>
      next({ ...op, body: new TextEncoder().encode("TRANSFORMED") }),
  }),
});

// SHA-256 of the ASCII string "hello", lowercase hex.
const SHA256_HELLO =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

const streamOf = (value: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
};

/**
 * Collect the receipt off every `onAction` success event. Receipts ride on the
 * existing hook, so a recorder is all a consumer needs.
 */
const receiptRecorder = (): {
  receipts: Receipt[];
  events: FilesActionEvent[];
  hooks: { onAction: (event: FilesActionEvent) => void };
} => {
  const receipts: Receipt[] = [];
  const events: FilesActionEvent[] = [];
  return {
    events,
    hooks: {
      onAction(event) {
        events.push(event);
        if (event.receipt) {
          receipts.push(event.receipt);
        }
      },
    },
    receipts,
  };
};

describe("receipts — off by default", () => {
  test("no `receipts` option means no receipt and no behavior change", async () => {
    const rec = receiptRecorder();
    const files = new Files({ adapter: fakeAdapter(), hooks: rec.hooks });

    const result = await files.upload("a.txt", "hello");

    // The mutation works exactly as before.
    expect(result).toMatchObject({ key: "a.txt", size: 5 });
    // No receipt is attached, and the action event keeps its prior shape.
    expect(rec.receipts).toHaveLength(0);
    expect(rec.events[0]?.receipt).toBeUndefined();
    expect(Object.keys(rec.events[0] ?? {})).not.toContain("receipt");
  });

  test("`receipts: false` is identical to off", async () => {
    const rec = receiptRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: rec.hooks,
      receipts: false,
    });
    await files.upload("a.txt", "hello");
    expect(rec.receipts).toHaveLength(0);
  });

  test("off-by-default never hashes the body", async () => {
    const digest = spyOn(crypto.subtle, "digest");
    try {
      const files = new Files({ adapter: fakeAdapter() });
      await files.upload("a.txt", "hello");
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });
});

describe("receipts — on, without sha256", () => {
  test("`receipts: true` attaches a typed receipt with hook-derived fields", async () => {
    const rec = receiptRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: rec.hooks,
      prefix: "uploads",
      receipts: true,
    });

    const result = await files.upload("avatar.txt", "hello", {
      contentType: "text/plain",
    });

    expect(rec.receipts).toHaveLength(1);
    const [receipt] = rec.receipts;
    expect(receipt).toMatchObject({
      // bytes / etag are derived from the UploadResult, not recomputed.
      bytes: result.size,
      etag: result.etag,
      // Caller-facing key, never the internal "uploads/avatar.txt" path.
      key: "avatar.txt",
      op: "upload",
      provider: "fake",
    });
    expect(receipt?.durationMs).toBeGreaterThanOrEqual(0);
    expect(receipt?.ts).toBeGreaterThan(0);
    // sha256 was not requested, so it is omitted.
    expect(receipt?.sha256).toBeUndefined();
    expect(Object.keys(receipt ?? {})).not.toContain("sha256");
  });

  test("`receipts: true` does not hash the body", async () => {
    const digest = spyOn(crypto.subtle, "digest");
    try {
      const rec = receiptRecorder();
      const files = new Files({
        adapter: fakeAdapter(),
        hooks: rec.hooks,
        receipts: true,
      });
      await files.upload("a.txt", "hello");
      // A receipt was produced...
      expect(rec.receipts).toHaveLength(1);
      // ...but the costly field was never computed.
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  test("`receipts: { sha256: false }` still does not hash", async () => {
    const digest = spyOn(crypto.subtle, "digest");
    try {
      const files = new Files({
        adapter: fakeAdapter(),
        hooks: { onAction: () => {} },
        receipts: { sha256: false },
      });
      await files.upload("a.txt", "hello");
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });
});

describe("receipts — sha256 only when asked", () => {
  test("`receipts: { sha256: true }` fingerprints a buffered upload", async () => {
    const rec = receiptRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: rec.hooks,
      receipts: { sha256: true },
    });

    await files.upload("a.txt", "hello");

    expect(rec.receipts[0]?.sha256).toBe(SHA256_HELLO);
  });

  test("the hash is the only added work, computed exactly once per upload", async () => {
    const digest = spyOn(crypto.subtle, "digest");
    try {
      const files = new Files({
        adapter: fakeAdapter(),
        hooks: { onAction: () => {} },
        receipts: { sha256: true },
      });
      await files.upload("a.txt", "hello");
      expect(digest).toHaveBeenCalledTimes(1);
    } finally {
      digest.mockRestore();
    }
  });

  test("a streaming upload is never buffered, so its receipt omits sha256", async () => {
    const digest = spyOn(crypto.subtle, "digest");
    try {
      const rec = receiptRecorder();
      const files = new Files({
        adapter: fakeAdapter(),
        hooks: rec.hooks,
        receipts: { sha256: true },
      });
      await files.upload("a.txt", streamOf("hello"));
      // The receipt still lands (with bytes/etag), but no hash was taken.
      expect(rec.receipts).toHaveLength(1);
      expect(rec.receipts[0]?.sha256).toBeUndefined();
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  test("sha256 fingerprints the caller's body, not a plugin-transformed one", async () => {
    const rec = receiptRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: rec.hooks,
      plugins: [bodyRewriter()],
      receipts: { sha256: true },
    });

    await files.upload("a.txt", "hello");

    // The plugin rewrote the body, so the adapter stored different bytes...
    const stored = await files.download("a.txt");
    expect(await stored.text()).toBe("TRANSFORMED");
    // ...but the receipt fingerprints the "hello" the caller passed — the value
    // a transparent round-trip (which reverses the transform) can verify.
    expect(rec.receipts[0]?.sha256).toBe(SHA256_HELLO);
  });

  test("the body is not hashed when there's no `onAction` consumer", async () => {
    const digest = spyOn(crypto.subtle, "digest");
    try {
      // sha256 is requested, but only `onError` is wired up — there's nowhere
      // for a receipt to land, so the fingerprint is never computed.
      const files = new Files({
        adapter: fakeAdapter(),
        hooks: { onError: () => {} },
        receipts: { sha256: true },
      });
      await files.upload("a.txt", "hello");
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  test("a hashing failure omits sha256 but does not fail the upload", async () => {
    const digest = spyOn(crypto.subtle, "digest").mockImplementation(() =>
      Promise.reject(new Error("digest unavailable"))
    );
    try {
      const rec = receiptRecorder();
      const files = new Files({
        adapter: fakeAdapter(),
        hooks: rec.hooks,
        receipts: { sha256: true },
      });
      // The upload still succeeds — a receipt must never break the op it
      // observes — and its receipt simply carries no fingerprint.
      const result = await files.upload("a.txt", "hello");
      expect(result).toMatchObject({ key: "a.txt", size: 5 });
      expect(rec.receipts).toHaveLength(1);
      expect(rec.receipts[0]?.sha256).toBeUndefined();
    } finally {
      digest.mockRestore();
    }
  });

  test("every buffered body kind is fingerprinted to the same hash", async () => {
    const helloBytes = new TextEncoder().encode("hello");
    const arrayBuffer = helloBytes.buffer.slice(
      helloBytes.byteOffset,
      helloBytes.byteOffset + helloBytes.byteLength
    );
    const bodies = {
      arrayBuffer,
      blob: new Blob(["hello"]),
      // A non-Uint8Array view over the same bytes exercises the
      // `ArrayBuffer.isView` branch.
      typedArrayView: new Int8Array(arrayBuffer.slice(0)),
      uint8: new Uint8Array(helloBytes),
    };
    for (const [name, body] of Object.entries(bodies)) {
      const rec = receiptRecorder();
      const files = new Files({
        adapter: fakeAdapter(),
        hooks: rec.hooks,
        receipts: { sha256: true },
      });
      await files.upload(`${name}.txt`, body);
      expect(rec.receipts[0]?.sha256).toBe(SHA256_HELLO);
    }
  });
});

describe("receipts — per-op coverage", () => {
  test("delete, copy, and move each produce a receipt; reads do not", async () => {
    const rec = receiptRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: rec.hooks,
      receipts: true,
    });

    await files.upload("src.txt", "hello");
    rec.receipts.length = 0;

    await files.copy("src.txt", "dst.txt");
    await files.move("dst.txt", "moved.txt");
    await files.delete("moved.txt");
    // Reads must not produce receipts.
    await files.download("src.txt");
    await files.head("src.txt");
    await files.exists("src.txt");
    await files.list();
    await files.url("src.txt");

    const byOp = rec.receipts.map((r) => `${r.op}:${r.key}`);
    // copy / move report their destination key; delete reports its own.
    expect(byOp).toEqual([
      "copy:dst.txt",
      "move:moved.txt",
      "delete:moved.txt",
    ]);
    // Non-upload receipts carry no bytes/etag/sha256 (nothing was transferred).
    for (const r of rec.receipts) {
      expect(r.bytes).toBeUndefined();
      expect(r.sha256).toBeUndefined();
    }
  });

  test("signedUploadUrl mints no receipt", async () => {
    const rec = receiptRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: rec.hooks,
      receipts: true,
    });
    await files.signedUploadUrl("a.txt", { expiresIn: 60 });
    expect(rec.receipts).toHaveLength(0);
  });

  test("a failed mutation produces no receipt", async () => {
    const rec = receiptRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: rec.hooks,
      receipts: true,
    });
    // Copying a missing key throws — the error event carries no receipt.
    await expect(files.copy("missing.txt", "x.txt")).rejects.toThrow();
    expect(rec.receipts).toHaveLength(0);
    const errorEvent = rec.events.find((e) => e.status === "error");
    expect(errorEvent?.receipt).toBeUndefined();
  });

  test("a bulk upload aggregates into one event and emits no per-object receipt", async () => {
    const rec = receiptRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: rec.hooks,
      receipts: true,
    });
    await files.upload([
      { body: "hello", key: "a.txt" },
      { body: "world", key: "b.txt" },
    ]);
    // The array form carries `keys`, not a single object — no single receipt.
    expect(rec.receipts).toHaveLength(0);
  });
});

describe("receipts — config propagation", () => {
  test("a readonly() clone carries the receipts config to its allowed ops", async () => {
    const rec = receiptRecorder();
    const files = new Files({
      adapter: fakeAdapter(),
      hooks: rec.hooks,
      receipts: { sha256: true },
    });
    // Seed a key through the writable instance, then clone read-only.
    await files.upload("a.txt", "hello");
    expect(rec.receipts[0]?.sha256).toBe(SHA256_HELLO);

    const ro = files.readonly();
    rec.receipts.length = 0;
    // Writes are blocked on the clone (proving it's a distinct read-only
    // instance), and the block raises no receipt.
    await expect(ro.delete("a.txt")).rejects.toThrow(/read.?only/iu);
    expect(rec.receipts).toHaveLength(0);
  });
});
