import { describe, expect, test } from "bun:test";

import { createFilesRouter } from "../src/api/index.js";
import { compression } from "../src/compression/index.js";
import type { CompressionFormat } from "../src/compression/index.js";
import { failover } from "../src/failover/index.js";
import {
  createStoredFile,
  Files,
  FilesError,
  UploadControl,
} from "../src/index.js";
import type { Adapter } from "../src/index.js";
import { memory } from "../src/memory/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const compressed = (
  adapter: Adapter = fakeAdapter(),
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
    // The stored bytes already are the original, so head's body is too.
    expect(new Uint8Array(await meta.arrayBuffer())).toEqual(random);
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

describe("compression plugin — head and list bodies", () => {
  test("head() body accessors decompress instead of returning gzip bytes", async () => {
    const files = compressed();
    await files.upload("a.txt", TEXT);
    const forText = await files.head("a.txt");
    expect(await forText.text()).toBe(TEXT);
    const forStream = await files.head("a.txt", { timeout: 5000 });
    expect(await new Response(forStream.stream()).text()).toBe(TEXT);
  });

  test("list() item bodies decompress; plaintext siblings keep their own", async () => {
    const adapter = fakeAdapter();
    const files = compressed(adapter);
    await files.upload("zip.txt", TEXT);
    await new Files({ adapter }).upload("plain.txt", "open");
    const { items } = await files.list();
    const texts = await Promise.all(items.map((file) => file.text()));
    expect(texts).toEqual(["open", TEXT]);
  });

  test("list() item bodies decompress on an adapter whose listing has no metadata", async () => {
    // S3 and the S3-compatibles return no metadata from list(), so there's no
    // algorithm marker to spot; the body must still read back through the
    // plugin rather than hand out the stored gzip bytes.
    const inner = fakeAdapter();
    const adapter: Adapter = {
      ...inner,
      async list(opts) {
        const page = await inner.list(opts);
        return {
          ...page,
          items: page.items.map((file) =>
            createStoredFile(
              {
                etag: file.etag,
                key: file.key,
                lastModified: file.lastModified,
                size: file.size,
                type: file.type,
              },
              {
                factory: async () => new Uint8Array(await file.arrayBuffer()),
                kind: "lazy",
              }
            )
          ),
        };
      },
    };
    const files = compressed(adapter);
    await files.upload("zip.txt", TEXT);
    await new Files({ adapter }).upload("plain.txt", "open");
    const { items } = await files.list();
    const texts = await Promise.all(items.map((file) => file.text()));
    expect(texts).toEqual(["open", TEXT]);
  });
});

// A signing-capable adapter: without the plugin's capabilities hook, the
// gateway would redirect downloads to a url() the plugin refuses.
const signing = (): Adapter => ({
  ...memory(),
  signedUrl: { maxExpiresIn: 3600, supported: true },
});

describe("compression plugin — resumable uploads", () => {
  test("a control upload is refused before any I/O", async () => {
    const adapter = memory();
    const files = compressed(adapter);
    const control = new UploadControl();
    const failure = await files
      .upload("a.txt", TEXT, { control })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "Provider", permanent: true });
    expect((failure as Error).message).toMatch(
      /compression: resumable uploads \(`control`\) are unsupported/u
    );
    expect(control.status).toBe("idle");
    expect(await new Files({ adapter }).exists("a.txt")).toBe(false);
  });

  test("advertises no resumable uploads; multipart without control still works", async () => {
    const adapter = memory();
    expect(new Files({ adapter }).capabilities.multipart).toBe(true);
    const files = compressed(adapter);
    expect(files.capabilities.multipart).toBe(false);
    await files.upload("a.txt", TEXT, { multipart: true });
    const file = await files.download("a.txt");
    expect(await file.text()).toBe(TEXT);
  });
});

describe("compression plugin — capabilities + gateway", () => {
  test("advertises no presigned URLs and no range reads", () => {
    const { capabilities } = compressed(signing());
    expect(capabilities.signedUrl).toEqual({ supported: false });
    expect(capabilities.rangeRead).toBe(false);
    expect(capabilities.metadata).toBe(true);
  });

  test("the gateway proxies downloads through the plugin instead of failing", async () => {
    const files = compressed(signing());
    await files.upload("a.txt", TEXT);
    const endpoint = "https://app.test/api/files?op=download&key=a.txt";
    const gateway = createFilesRouter({
      files,
      onUnsupportedRange: "ignore",
      operations: ["download"],
      secret: "test-secret",
    });

    const full = await gateway.handle(new Request(endpoint));
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe(String(TEXT.length));
    expect(await full.text()).toBe(TEXT);

    const ranged = await gateway.handle(
      new Request(endpoint, { headers: { range: "bytes=0-4" } })
    );
    expect(ranged.status).toBe(200);
    expect(await ranged.text()).toBe(TEXT);
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

describe("compression plugin — refusals are permanent", () => {
  test("an outer failover() doesn't re-send a refused call to a plugin-less secondary", async () => {
    const secondary = fakeAdapter();
    await new Files({ adapter: secondary }).upload("a.txt", "replica");
    const files = new Files({
      adapter: fakeAdapter(),
      plugins: [failover({ secondaries: secondary }), compression()],
    });
    await files.upload("a.txt", TEXT);
    const refusals = [
      () => files.url("a.txt"),
      () => files.signedUploadUrl("a.txt", { expiresIn: 60 }),
      () => files.download("a.txt", { range: { end: 1, start: 0 } }),
    ];
    for (const refused of refusals) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is inspected on its own
      const failure = await refused().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FilesError);
      expect((failure as FilesError).permanent).toBe(true);
      expect((failure as FilesError).message).toMatch(/^compression: /u);
    }
  });

  test("unreadable stored objects fail permanently", async () => {
    const adapter = fakeAdapter();
    const raw = new Files({ adapter });
    await raw.upload("unknown.txt", "x", { metadata: { fscmp_alg: "brotli" } });
    await raw.upload("corrupt.txt", "not gzip", {
      metadata: { fscmp_alg: "gzip" },
    });
    const files = compressed(adapter);
    for (const key of ["unknown.txt", "corrupt.txt"]) {
      // eslint-disable-next-line no-await-in-loop -- each failure is inspected on its own
      const failure = await files
        .download(key)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FilesError);
      expect((failure as FilesError).permanent).toBe(true);
    }
  });
});
