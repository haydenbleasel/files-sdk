/* oxlint-disable no-bitwise -- the fixtures hand-craft ZIP records and an independent CRC-32, both of which are bit-defined. */
import { describe, expect, test } from "bun:test";

import { compression } from "../src/compression/index.js";
import { createFiles, createStoredFile } from "../src/index.js";
import type { Adapter, DownloadOptions, StoredFile } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";
import { zip } from "../src/zip/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const withZip = (adapter: Adapter = fakeAdapter()) =>
  createFiles({ adapter, plugins: [zip()] });

const collect = async (
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- sequentially draining a stream reader
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};

/**
 * An adapter whose downloads stream in fixed-size chunks (and omit
 * `lastModified`), so the writer's chunk-by-chunk CRC/size accounting and
 * mid-body cancellation actually see a multi-chunk body.
 */
const chunkedAdapter = (chunkSize: number): Adapter => {
  const inner = fakeAdapter();
  return {
    ...inner,
    async download(key: string, opts?: DownloadOptions): Promise<StoredFile> {
      const file = await inner.download(key, opts);
      const bytes = new Uint8Array(await file.arrayBuffer());
      return createStoredFile(
        { key: file.key, size: bytes.byteLength, type: file.type },
        {
          factory: () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (let at = 0; at < bytes.byteLength; at += chunkSize) {
                  controller.enqueue(bytes.subarray(at, at + chunkSize));
                }
                controller.close();
              },
            }),
          kind: "stream",
        }
      );
    },
  };
};

/** An adapter that declares an impossible (>4 GiB) size on every download. */
const oversizedAdapter = (): Adapter => {
  const inner = fakeAdapter();
  return {
    ...inner,
    async download(key: string, opts?: DownloadOptions): Promise<StoredFile> {
      const file = await inner.download(key, opts);
      const bytes = new Uint8Array(await file.arrayBuffer());
      return createStoredFile(
        { key: file.key, size: 2 ** 32, type: file.type },
        { data: bytes, kind: "buffer" }
      );
    },
  };
};

// --- An independent fixture writer, so reading is never tested against our
// own writer alone: classic records with sizes in the local header (no data
// descriptors, the layout most foreign tools emit) and knobs for corruption.

/** Bitwise (table-free) CRC-32 — independent of the plugin's implementation. */
const crcOf = (data: Uint8Array): number => {
  let crc = 0xff_ff_ff_ff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xed_b8_83_20 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  // oxlint-disable-next-line unicorn/prefer-math-trunc -- `>>> 0` reinterprets the signed CRC as unsigned; Math.trunc would not.
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  );
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

interface CraftedEntry {
  name: string;
  data?: Uint8Array;
  method?: number;
  flags?: number;
  /** Override the recorded CRC (to fake corruption). */
  crc?: number;
  /** Override the recorded uncompressed size. */
  size?: number;
  /** Override the recorded compressed size. */
  csize?: number;
}

const craftZip = (
  entries: CraftedEntry[],
  overrides: { count?: number; directoryOffset?: number } = {}
): Uint8Array => {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array(0);
    const name = encoder.encode(entry.name);
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0;
    const crc = entry.crc ?? crcOf(data);
    const size = entry.size ?? data.byteLength;
    const csize = entry.csize ?? data.byteLength;
    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04_03_4b_50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, csize, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    parts.push(local, data);
    const record = new Uint8Array(46 + name.byteLength);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x02_01_4b_50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, flags, true);
    view.setUint16(10, method, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, csize, true);
    view.setUint32(24, size, true);
    view.setUint16(28, name.byteLength, true);
    view.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    offset += local.byteLength + data.byteLength;
  }
  const directory = concat(central);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06_05_4b_50, true);
  eocdView.setUint16(8, overrides.count ?? entries.length, true);
  eocdView.setUint16(10, overrides.count ?? entries.length, true);
  eocdView.setUint32(12, directory.byteLength, true);
  eocdView.setUint32(16, overrides.directoryOffset ?? offset, true);
  return concat([...parts, directory, eocd]);
};

const TEXT = new TextEncoder();

describe("zip plugin — writing archives", () => {
  test("zipTo + unzip round-trips multiple files (deflate)", async () => {
    const files = withZip();
    await files.upload("a.txt", "alpha ".repeat(500));
    await files.upload("docs/b.txt", "bravo");

    const stored = await files.zipTo("out.zip", ["a.txt", "docs/b.txt"]);
    expect(stored.contentType).toBe("application/zip");

    const results = await files.unzip("out.zip", { into: "restored/" });
    expect(results.map((r) => r.key)).toEqual([
      "restored/a.txt",
      "restored/docs/b.txt",
    ]);
    const a = await files.download("restored/a.txt");
    expect(await a.text()).toBe("alpha ".repeat(500));
    const b = await files.download("restored/docs/b.txt");
    expect(await b.text()).toBe("bravo");
  });

  test("store method keeps bytes verbatim and round-trips binary", async () => {
    const files = withZip();
    const data = new Uint8Array(256).map((_, i) => i);
    await files.upload("blob.bin", data);

    await files.zipTo("out.zip", ["blob.bin"], { method: "store" });
    const [result] = await files.unzip("out.zip", { into: "x/" });
    expect(result?.key).toBe("x/blob.bin");
    const file = await files.download("x/blob.bin");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(data);
  });

  test("a stored archive has the classic record layout", async () => {
    const files = withZip();
    await files.upload("a.txt", "hello");
    const bytes = await collect(files.zip(["a.txt"], { method: "store" }));
    const view = new DataView(bytes.buffer, bytes.byteOffset);

    // Local header: signature, version 2.0, descriptor + UTF-8 flags.
    expect(view.getUint32(0, true)).toBe(0x04_03_4b_50);
    expect(view.getUint16(4, true)).toBe(20);
    expect(view.getUint16(6, true)).toBe(0x08_08);
    // Data descriptor after the 5 stored bytes: CRC matches the independent
    // implementation, sizes match the body.
    const descriptor = 30 + "a.txt".length + 5;
    expect(view.getUint32(descriptor, true)).toBe(0x08_07_4b_50);
    expect(view.getUint32(descriptor + 4, true)).toBe(
      crcOf(TEXT.encode("hello"))
    );
    expect(view.getUint32(descriptor + 8, true)).toBe(5);
    expect(view.getUint32(descriptor + 12, true)).toBe(5);
    // End record: one entry, comment-free.
    expect(view.getUint32(bytes.byteLength - 22, true)).toBe(0x06_05_4b_50);
    expect(view.getUint16(bytes.byteLength - 12, true)).toBe(1);
  });

  test("an empty selection produces a valid empty archive", async () => {
    const files = withZip();
    const bytes = await collect(files.zip([]));
    expect(bytes.byteLength).toBe(22);

    await files.upload("empty.zip", bytes);
    expect(await files.unzip("empty.zip")).toEqual([]);
  });

  test("a prefix selection zips every key under it", async () => {
    const files = withZip();
    await files.upload("docs/a.txt", "a");
    await files.upload("docs/sub/b.txt", "b");
    await files.upload("other.txt", "outside");

    await files.zipTo("docs.zip", { prefix: "docs/" });
    const results = await files.unzip("docs.zip", { into: "out/" });
    expect(results.map((r) => r.key).toSorted()).toEqual([
      "out/docs/a.txt",
      "out/docs/sub/b.txt",
    ]);
  });

  test("the name option remaps entry paths (and survives unicode)", async () => {
    const files = withZip();
    await files.upload("exports/café.txt", "déjà vu");

    await files.zipTo(
      "out.zip",
      { prefix: "exports/" },
      {
        name: (key) => key.slice("exports/".length),
      }
    );
    const results = await files.unzip("out.zip", { into: "in/" });
    expect(results.map((r) => r.key)).toEqual(["in/café.txt"]);
    const file = await files.download("in/café.txt");
    expect(await file.text()).toBe("déjà vu");
  });

  test("two keys mapping to one entry name fail closed", async () => {
    const files = withZip();
    await files.upload("a/report.pdf", "1");
    await files.upload("b/report.pdf", "2");

    await expect(
      collect(
        files.zip(["a/report.pdf", "b/report.pdf"], {
          name: (key) => key.split("/").at(-1) ?? key,
        })
      )
    ).rejects.toThrow('two keys map to the same entry name "report.pdf"');
  });

  test.each([
    ["../escape.txt", '"." or ".." path segment'],
    ["a/./b.txt", '"." or ".." path segment'],
    ["/absolute.txt", "empty path segment"],
    ["trailing/", "empty path segment"],
    ["", "empty path segment"],
    ["back\\slash.txt", "contains a backslash"],
    ["x".repeat(65_536), "65535-byte limit"],
  ])("unsafe entry name %j is rejected", async (bad, message) => {
    const files = withZip();
    await files.upload("ok.txt", "fine");
    await expect(
      collect(files.zip(["ok.txt"], { name: () => bad }))
    ).rejects.toThrow(message);
  });

  test("more than 65535 entries fail before any download", async () => {
    const files = withZip();
    const keys = Array.from({ length: 65_536 }, (_, i) => `k${i}`);
    await expect(collect(files.zip(keys))).rejects.toThrow(
      "65536 entries reach the ZIP format's limit of 65535"
    );
  });

  test("exactly 65535 entries are rejected too (the ZIP64 sentinel)", async () => {
    // An EOCD count of 0xFFFF is the ZIP64 sentinel — this plugin's own
    // unzip() (and ZIP64-aware readers) would treat such an archive as
    // ZIP64 and refuse it, so the writer must not produce it.
    const files = withZip();
    const keys = Array.from({ length: 65_535 }, (_, i) => `k${i}`);
    await expect(collect(files.zip(keys))).rejects.toThrow(
      "65535 entries reach the ZIP format's limit of 65535"
    );
  });

  test("a declared size over 4 GiB fails before streaming", async () => {
    const files = withZip(oversizedAdapter());
    await files.upload("huge.bin", "tiny really");
    await expect(collect(files.zip(["huge.bin"]))).rejects.toThrow(
      "exceeds 4 GiB"
    );
  });

  test("a missing key surfaces as a NotFound error on the stream", async () => {
    const files = withZip();
    expect.assertions(2);
    try {
      await collect(files.zip(["ghost.txt"]));
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("multi-chunk bodies round-trip (CRC accumulates per chunk)", async () => {
    const files = withZip(chunkedAdapter(4));
    const body = "chunked body that spans many small reads";
    await files.upload("c.txt", body);

    await files.zipTo("out.zip", ["c.txt"]);
    await files.unzip("out.zip", { into: "r/" });
    const file = await files.download("r/c.txt");
    expect(await file.text()).toBe(body);
  });

  test("cancelling the stream mid-entry stops cleanly", async () => {
    const files = withZip(chunkedAdapter(4));
    await files.upload("c.txt", "many small chunks to cancel between");

    const reader = files.zip(["c.txt"], { method: "store" }).getReader();
    // Read the local header and the first body chunk, then bail.
    await reader.read();
    await reader.read();
    await expect(reader.cancel()).resolves.toBeUndefined();
  });
});

describe("zip plugin — reading archives", () => {
  test("extracts a foreign archive (stored, no data descriptors)", async () => {
    const files = withZip();
    const crafted = craftZip([
      { data: TEXT.encode("alpha"), name: "a.txt" },
      { data: TEXT.encode("<b>bold</b>"), name: "page.html" },
    ]);
    await files.upload("in.zip", crafted);

    const results = await files.unzip("in.zip", { into: "out" });
    expect(results.map((r) => r.key)).toEqual(["out/a.txt", "out/page.html"]);
    // `into` gained its slash; content types come from the entry extensions.
    expect(results[1]?.contentType).toBe("text/html; charset=utf-8");
    const html = await files.download("out/page.html");
    expect(await html.text()).toBe("<b>bold</b>");
  });

  test("directory entries are skipped; filter narrows extraction", async () => {
    const files = withZip();
    const crafted = craftZip([
      { name: "dir/" },
      { data: TEXT.encode("keep"), name: "dir/keep.md" },
      { data: TEXT.encode("drop"), name: "dir/drop.txt" },
    ]);
    await files.upload("in.zip", crafted);

    const results = await files.unzip("in.zip", {
      filter: (name) => name.endsWith(".md"),
    });
    expect(results.map((r) => r.key)).toEqual(["dir/keep.md"]);
    expect(await files.exists("dir/drop.txt")).toBe(false);
  });

  test("unzip enforces the configured entry count limit", async () => {
    const files = withZip();
    const crafted = craftZip([
      { data: TEXT.encode("a"), name: "a.txt" },
      { data: TEXT.encode("b"), name: "b.txt" },
    ]);
    await files.upload("in.zip", crafted);

    await expect(files.unzip("in.zip", { maxEntries: 1 })).rejects.toThrow(
      "entry limit"
    );
  });

  test("unzip enforces the configured per-entry size limit", async () => {
    const files = withZip();
    const crafted = craftZip([
      { data: TEXT.encode("abc"), name: "a.txt", size: 4 },
    ]);
    await files.upload("in.zip", crafted);

    await expect(files.unzip("in.zip", { maxEntrySize: 3 })).rejects.toThrow(
      "size limit"
    );
  });

  test("unzip enforces the configured total size limit", async () => {
    const files = withZip();
    const crafted = craftZip([
      { data: TEXT.encode("abc"), name: "a.txt" },
      { data: TEXT.encode("def"), name: "b.txt" },
    ]);
    await files.upload("in.zip", crafted);

    await expect(files.unzip("in.zip", { maxTotalSize: 5 })).rejects.toThrow(
      "total size limit"
    );
  });

  test("zip-slip entry names fail closed", async () => {
    const files = withZip();
    const crafted = craftZip([
      { data: TEXT.encode("evil"), name: "../../etc/passwd" },
    ]);
    await files.upload("in.zip", crafted);

    await expect(files.unzip("in.zip", { into: "safe/" })).rejects.toThrow(
      '"." or ".." path segment'
    );
    expect(await files.exists("etc/passwd")).toBe(false);
  });

  test("encrypted entries are refused", async () => {
    const files = withZip();
    const crafted = craftZip([
      { data: TEXT.encode("secret"), flags: 0x00_01, name: "s.txt" },
    ]);
    await files.upload("in.zip", crafted);
    await expect(files.unzip("in.zip")).rejects.toThrow(
      "contains encrypted entries"
    );
  });

  test("unknown compression methods are refused", async () => {
    const files = withZip();
    const crafted = craftZip([
      { data: TEXT.encode("??"), method: 99, name: "weird.bin" },
    ]);
    await files.upload("in.zip", crafted);
    await expect(files.unzip("in.zip")).rejects.toThrow(
      "unsupported compression method 99"
    );
  });

  test("a wrong CRC fails the integrity check", async () => {
    const files = withZip();
    const crafted = craftZip([
      { crc: 1234, data: TEXT.encode("tampered"), name: "t.txt" },
    ]);
    await files.upload("in.zip", crafted);
    await expect(files.unzip("in.zip")).rejects.toThrow(
      'entry "t.txt" failed its CRC/size check'
    );
  });

  test("garbage deflate data fails to inflate", async () => {
    const files = withZip();
    const crafted = craftZip([
      {
        data: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
        method: 8,
        name: "bad.bin",
        size: 100,
      },
    ]);
    await files.upload("in.zip", crafted);
    await expect(files.unzip("in.zip")).rejects.toThrow("failed to inflate");
  });

  test.each([
    [
      "not a zip at all",
      TEXT.encode("just some plain text, definitely no EOCD"),
    ],
    ["shorter than an end record", TEXT.encode("hi")],
  ])("%s → no end-of-central-directory", async (_label, bytes) => {
    const files = withZip();
    await files.upload("in.zip", bytes);
    await expect(files.unzip("in.zip")).rejects.toThrow(
      "no end-of-central-directory record"
    );
  });

  test("ZIP64 end-record markers are refused", async () => {
    const files = withZip();
    const byCount = craftZip([{ data: TEXT.encode("x"), name: "a" }], {
      count: 0xff_ff,
    });
    await files.upload("count.zip", byCount);
    await expect(files.unzip("count.zip")).rejects.toThrow("ZIP64");

    const byOffset = craftZip([{ data: TEXT.encode("x"), name: "a" }], {
      directoryOffset: 0xff_ff_ff_ff,
    });
    await files.upload("offset.zip", byOffset);
    await expect(files.unzip("offset.zip")).rejects.toThrow("ZIP64");
  });

  test("ZIP64 per-entry size markers are refused", async () => {
    const files = withZip();
    const crafted = craftZip([
      { csize: 0xff_ff_ff_ff, data: TEXT.encode("x"), name: "a" },
    ]);
    await files.upload("in.zip", crafted);
    await expect(files.unzip("in.zip")).rejects.toThrow("ZIP64");
  });

  test("a count beyond the actual records is a truncated directory", async () => {
    const files = withZip();
    const crafted = craftZip([{ data: TEXT.encode("x"), name: "a" }], {
      count: 2,
    });
    await files.upload("in.zip", crafted);
    await expect(files.unzip("in.zip")).rejects.toThrow(
      "truncated central directory"
    );
  });

  test("a corrupted local header is rejected", async () => {
    const files = withZip();
    const crafted = craftZip([{ data: TEXT.encode("x"), name: "a" }]);
    // Break the first byte of the local header signature.
    crafted[0] = 0;
    await files.upload("in.zip", crafted);
    await expect(files.unzip("in.zip")).rejects.toThrow(
      'bad local header for "a"'
    );
  });

  test("data running past the end of the file is rejected", async () => {
    const files = withZip();
    const crafted = craftZip([
      { csize: 1000, data: TEXT.encode("abc"), name: "a", size: 1000 },
    ]);
    await files.upload("in.zip", crafted);
    await expect(files.unzip("in.zip")).rejects.toThrow(
      'truncated data for "a"'
    );
  });
});

describe("zip plugin — composition", () => {
  test("zips logical bytes through other plugins (compression at rest)", async () => {
    const files = createFiles({
      adapter: fakeAdapter(),
      plugins: [compression(), zip()],
    });
    const body = "compressible ".repeat(1000);
    await files.upload("a.txt", body);

    await files.zipTo("out.zip", ["a.txt"]);
    await files.unzip("out.zip", { into: "r/" });
    const file = await files.download("r/a.txt");
    expect(await file.text()).toBe(body);
  });
});
