import { describe, expect, test } from "bun:test";

import { compression } from "../src/compression/index.js";
import type { CompressionFormat } from "../src/compression/index.js";
import { Files } from "../src/index.js";
import type { Adapter } from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const compressed = (
  adapter = fakeAdapter(),
  format?: CompressionFormat
): Files =>
  new Files({ adapter, plugins: [compression(format ? { format } : {})] });

// A highly compressible payload, big enough to beat gzip's framing overhead.
const TEXT = "the quick brown fox ".repeat(500);

describe("compression plugin — round-trips", () => {
  test("upload + download round-trips a string", async () => {
    const files = compressed();
    const result = await files.upload("a.txt", TEXT);
    expect(result.size).toBe(TEXT.length);
    const file = await files.download("a.txt");
    expect(await file.text()).toBe(TEXT);
    expect(file.size).toBe(TEXT.length);
  });

  test("stores compressed bytes + metadata at rest", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, plugins: [compression()] });
    await files.upload("a.txt", TEXT);

    // Read the raw stored object through a plugin-free instance.
    const raw = await new Files({ adapter }).download("a.txt");
    expect(raw.size).toBeLessThan(TEXT.length);
    expect(raw.metadata?.fscmp_alg).toBe("gzip");
    expect(raw.metadata?.fscmp_size).toBe(String(TEXT.length));
    expect(await raw.text()).not.toBe(TEXT);
  });

  test("round-trips binary, ArrayBuffer, and stream bodies", async () => {
    const files = compressed();
    const bytes = new Uint8Array(2000).fill(7);

    await files.upload("bin", bytes);
    const bin = await files.download("bin");
    expect(new Uint8Array(await bin.arrayBuffer())).toEqual(bytes);

    await files.upload("buf", bytes.buffer);
    const buf = await files.download("buf");
    expect(buf.size).toBe(2000);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(TEXT));
        controller.close();
      },
    });
    await files.upload("str", stream);
    const str = await files.download("str");
    expect(await str.text()).toBe(TEXT);
  });

  test("preserves the content type through compression", async () => {
    const files = compressed();
    await files.upload("typed", TEXT, { contentType: "text/markdown" });
    const typed = await files.head("typed");
    expect(typed.type).toBe("text/markdown");

    await files.upload("inferred", TEXT);
    const inferred = await files.head("inferred");
    expect(inferred.type).toBe("text/plain; charset=utf-8");
  });

  test("supports deflate and deflate-raw formats", async () => {
    await Promise.all(
      (["deflate", "deflate-raw"] as CompressionFormat[]).map(
        async (format) => {
          const adapter = fakeAdapter();
          const files = compressed(adapter, format);
          await files.upload("a.txt", TEXT);
          const raw = await new Files({ adapter }).download("a.txt");
          expect(raw.metadata?.fscmp_alg).toBe(format);
          const file = await files.download("a.txt");
          expect(await file.text()).toBe(TEXT);
        }
      )
    );
  });
});

describe("compression plugin — incompressible data", () => {
  test("stores verbatim and marks identity when it wouldn't shrink", async () => {
    const adapter = fakeAdapter();
    const files = compressed(adapter);
    // Random bytes don't compress; gzip would only add overhead.
    const random = crypto.getRandomValues(new Uint8Array(4096));
    await files.upload("rand.bin", random);

    const raw = await new Files({ adapter }).download("rand.bin");
    expect(raw.metadata?.fscmp_alg).toBe("identity");
    expect(raw.size).toBe(4096);
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(random);

    // It still round-trips, and head reports the logical size with no markers.
    const file = await files.download("rand.bin");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(random);
    const meta = await files.head("rand.bin");
    expect(meta.size).toBe(4096);
    expect(meta.metadata).toBeUndefined();
  });
});

describe("compression plugin — metadata", () => {
  test("preserves user metadata and strips internal fields on read", async () => {
    const files = compressed();

    await files.upload("withmeta", TEXT, { metadata: { owner: "alice" } });
    const withMeta = await files.download("withmeta");
    expect(withMeta.metadata).toEqual({ owner: "alice" });

    await files.upload("nometa", TEXT);
    const noMeta = await files.download("nometa");
    expect(noMeta.metadata).toBeUndefined();
  });

  test("head reports the original size and hides internal metadata", async () => {
    const files = compressed();
    await files.upload("a.txt", TEXT, { metadata: { owner: "bob" } });
    const meta = await files.head("a.txt");
    expect(meta.size).toBe(TEXT.length);
    expect(meta.metadata).toEqual({ owner: "bob" });
  });

  test("list corrects compressed items and passes plaintext through", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, plugins: [compression()] });
    await files.upload("zip.txt", TEXT);
    // A sibling object written without the plugin.
    await new Files({ adapter }).upload("plain.txt", "open");

    const { items } = await files.list();
    const zip = items.find((item) => item.key === "zip.txt");
    const plain = items.find((item) => item.key === "plain.txt");
    expect(zip?.size).toBe(TEXT.length);
    expect(zip?.metadata).toBeUndefined();
    expect(plain?.size).toBe(4);

    const head = await files.head("plain.txt");
    expect(head.size).toBe(4);
  });
});

describe("compression plugin — passthrough + failure", () => {
  test("download passes through objects written without the plugin", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, plugins: [compression()] });
    await new Files({ adapter }).upload("plain.txt", "hello");
    const file = await files.download("plain.txt");
    expect(await file.text()).toBe("hello");
  });

  test("download rejects an object with an unknown algorithm marker", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, plugins: [compression()] });
    // Forge an object carrying our marker but a bogus algorithm.
    await new Files({ adapter }).upload("bad", TEXT, {
      metadata: { fscmp_alg: "lzma", fscmp_size: String(TEXT.length) },
    });
    await expect(files.download("bad")).rejects.toThrow(/unknown algorithm/u);
  });

  test("download rejects corrupted compressed data", async () => {
    const adapter = fakeAdapter();
    const files = new Files({ adapter, plugins: [compression()] });
    // Marked gzip, but the body is not a valid gzip stream.
    await new Files({ adapter }).upload("corrupt", "not actually gzip", {
      metadata: { fscmp_alg: "gzip", fscmp_size: "100" },
    });
    await expect(files.download("corrupt")).rejects.toThrow(
      /failed to decompress/u
    );
  });
});

describe("compression plugin — refused operations", () => {
  test("range downloads, url(), and signedUploadUrl() throw", async () => {
    const files = new Files({
      adapter: fakeAdapter({ supportsRange: true }),
      plugins: [compression()],
    });
    await files.upload("a.txt", TEXT);
    await expect(
      files.download("a.txt", { range: { end: 3, start: 0 } })
    ).rejects.toThrow(/range downloads/u);
    await expect(files.url("a.txt")).rejects.toThrow(/url\(\)/u);
    await expect(
      files.signedUploadUrl("a.txt", { expiresIn: 60 })
    ).rejects.toThrow(/signedUploadUrl/u);
  });

  test("upload throws on an adapter without metadata support", async () => {
    const adapter: Adapter = { ...fakeAdapter(), supportsMetadata: false };
    const files = new Files({ adapter, plugins: [compression()] });
    await expect(files.upload("a.txt", TEXT)).rejects.toThrow(
      /`metadata` is not supported/u
    );
  });
});

describe("compression plugin — bulk + copy", () => {
  test("compresses every item of a bulk upload and inflates in bulk", async () => {
    const files = compressed();
    await files.upload([
      { body: `one ${TEXT}`, key: "a" },
      { body: `two ${TEXT}`, key: "b" },
    ]);
    const { downloaded } = await files.download(["a", "b"]);
    const texts = await Promise.all(downloaded.map((file) => file.text()));
    expect(texts).toEqual([`one ${TEXT}`, `two ${TEXT}`]);
  });

  test("copy preserves the marker so the copy still decompresses", async () => {
    const files = compressed();
    await files.upload("a.txt", TEXT);
    await files.copy("a.txt", "b.txt");
    const file = await files.download("b.txt");
    expect(await file.text()).toBe(TEXT);
  });
});
