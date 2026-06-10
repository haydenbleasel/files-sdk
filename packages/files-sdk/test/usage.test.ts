import { describe, expect, test } from "bun:test";

import { createFiles } from "../src/index.js";
import { memory } from "../src/memory/index.js";
import { usage } from "../src/usage/index.js";

const bytes = (data: string): Uint8Array => new TextEncoder().encode(data);

const metered = () =>
  createFiles({
    adapter: memory(),
    plugins: [usage()],
  });

describe("usage", () => {
  test("counts an operation and the bytes uploaded", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello"));

    const stats = files.usage();
    expect(stats.operations).toBe(1);
    expect(stats.operationsByKind.upload).toBe(1);
    expect(stats.bytesUp).toBe(5);
    expect(stats.bytesDown).toBe(0);
  });

  test("meters download bytes read via text()", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello"));
    const file = await files.download("a.txt");
    expect(await file.text()).toBe("hello");

    const stats = files.usage();
    expect(stats.operations).toBe(2);
    expect(stats.operationsByKind.download).toBe(1);
    expect(stats.bytesDown).toBe(5);
  });

  test("meters download bytes read via arrayBuffer()", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello world"));
    const file = await files.download("a.txt");
    const buffer = await file.arrayBuffer();
    expect(buffer.byteLength).toBe(11);
    expect(files.usage().bytesDown).toBe(11);
  });

  test("meters download bytes read via blob()", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello world"));
    const file = await files.download("a.txt");
    const blob = await file.blob();
    expect(blob.size).toBe(11);
    expect(files.usage().bytesDown).toBe(11);
  });

  test("meters download bytes read via stream() chunk by chunk", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("streamed"));
    const file = await files.download("a.txt");
    expect(await new Response(file.stream()).text()).toBe("streamed");
    expect(files.usage().bytesDown).toBe(8);
  });

  test("an unread body costs no bandwidth", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello"));
    // download, but never read the body
    await files.download("a.txt");

    const stats = files.usage();
    expect(stats.operations).toBe(2);
    expect(stats.operationsByKind.download).toBe(1);
    expect(stats.bytesDown).toBe(0);
  });

  test("counts a body only once across repeated reads", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello"));
    const file = await files.download("a.txt");
    await file.arrayBuffer();
    // a second read is served from cache, so it adds nothing
    await file.text();
    expect(files.usage().bytesDown).toBe(5);
  });

  test("a repeatable stream() read twice still counts once", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello"));
    // The memory adapter returns a buffer-backed file, whose stream() is
    // repeatable — only the first stream to move bytes may claim the count.
    const file = await files.download("a.txt");
    expect(await new Response(file.stream()).text()).toBe("hello");
    expect(await new Response(file.stream()).text()).toBe("hello");
    expect(files.usage().bytesDown).toBe(5);
  });

  test("an opened-but-unread stream doesn't suppress a buffered read's count", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello"));
    const file = await files.download("a.txt");
    // Open a stream but never pull from it…
    file.stream();
    // …the text() read is what actually moved the bytes.
    expect(await file.text()).toBe("hello");
    expect(files.usage().bytesDown).toBe(5);
  });

  test("a stream read after a buffered read adds nothing", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello"));
    const file = await files.download("a.txt");
    expect(await file.text()).toBe("hello");
    expect(await new Response(file.stream()).text()).toBe("hello");
    expect(files.usage().bytesDown).toBe(5);
  });

  test("meters bytes read out of a head() body", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello"));
    const file = await files.head("a.txt");
    expect(await file.text()).toBe("hello");

    const stats = files.usage();
    expect(stats.operationsByKind.head).toBe(1);
    expect(stats.bytesDown).toBe(5);
  });

  test("counts non-body verbs without moving bytes", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("data"));
    await files.exists("a.txt");
    await files.copy("a.txt", "b.txt");
    await files.url("a.txt");
    await files.list();
    await files.delete("b.txt");

    const stats = files.usage();
    expect(stats.operationsByKind).toMatchObject({
      copy: 1,
      delete: 1,
      exists: 1,
      list: 1,
      upload: 1,
      url: 1,
    });
    expect(stats.operations).toBe(6);
    expect(stats.bytesDown).toBe(0);
  });

  test("does not count an operation that throws", async () => {
    const files = metered();
    await expect(files.download("missing.txt")).rejects.toThrow();
    expect(files.usage().operations).toBe(0);
  });

  test("buckets usage by group and aggregates across them", async () => {
    const files = createFiles({
      adapter: memory(),
      plugins: [
        usage({
          group: (op) =>
            "key" in op ? (op.key.split("/")[0] ?? "shared") : "shared",
        }),
      ],
    });

    await files.upload("alice/a.txt", bytes("aa"));
    await files.upload("bob/b.txt", bytes("bbbb"));
    const aliceFile = await files.download("alice/a.txt");
    await aliceFile.text();

    const byGroup = files.usageByGroup();
    expect(byGroup.alice?.bytesUp).toBe(2);
    expect(byGroup.alice?.bytesDown).toBe(2);
    expect(byGroup.bob?.bytesUp).toBe(4);

    const total = files.usage();
    expect(total.bytesUp).toBe(6);
    expect(total.operations).toBe(3);
  });

  test("resetUsage clears every counter", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello"));
    files.resetUsage();

    expect(files.usage().operations).toBe(0);
    expect(files.usageByGroup()).toEqual({});
  });

  test("counts each item of a bulk upload", async () => {
    const files = metered();
    await files.upload([
      { body: bytes("one"), key: "a.txt" },
      { body: bytes("three"), key: "b.txt" },
    ]);

    const stats = files.usage();
    expect(stats.operationsByKind.upload).toBe(2);
    expect(stats.bytesUp).toBe(8);
  });

  test("a snapshot does not alias the running totals", async () => {
    const files = metered();
    await files.upload("a.txt", bytes("hello"));

    const snap = files.usage();
    snap.operations = 999;
    snap.operationsByKind.upload = 999;
    expect(files.usage().operations).toBe(1);
    expect(files.usage().operationsByKind.upload).toBe(1);
  });
});
