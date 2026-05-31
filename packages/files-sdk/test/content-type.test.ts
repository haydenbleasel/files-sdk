import { describe, expect, test } from "bun:test";

import { contentType, detectContentType } from "../src/content-type/index.js";
import type { ContentTypeOptions } from "../src/content-type/index.js";
import { Files } from "../src/index.js";
import type { Adapter } from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const withContentType = (
  options: ContentTypeOptions = {},
  adapter: Adapter = fakeAdapter()
): Files => new Files({ adapter, plugins: [contentType(options)] });

const bytes = (...values: number[]): Uint8Array<ArrayBuffer> =>
  new Uint8Array(values);
const ascii = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0);
const GIF = ascii("GIF89a....");
const BMP = ascii("BM......");
const WEBP = bytes(
  0x52,
  0x49,
  0x46,
  0x46,
  0x10,
  0,
  0,
  0,
  0x57,
  0x45,
  0x42,
  0x50
);
const TIFF_LE = bytes(0x49, 0x49, 0x2a, 0x00);
const TIFF_BE = bytes(0x4d, 0x4d, 0x00, 0x2a);
const ICO = bytes(0x00, 0x00, 0x01, 0x00);
const PDF = ascii("%PDF-1.7\n...");

const typeOf = async (files: Files, key: string): Promise<string> => {
  const file = await files.head(key);
  return file.type;
};

const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

describe("detectContentType — binary signatures", () => {
  test.each([
    ["png", PNG, "image/png"],
    ["jpeg", JPEG, "image/jpeg"],
    ["gif", GIF, "image/gif"],
    ["bmp", BMP, "image/bmp"],
    ["webp", WEBP, "image/webp"],
    ["tiff little-endian", TIFF_LE, "image/tiff"],
    ["tiff big-endian", TIFF_BE, "image/tiff"],
    ["ico", ICO, "image/x-icon"],
    ["pdf", PDF, "application/pdf"],
  ])("detects %s", (_name, data, expected) => {
    expect(detectContentType(data)).toBe(expected);
  });

  test("a too-short body matches no signature", () => {
    expect(detectContentType(bytes(0x89, 0x50))).toBeUndefined();
  });
});

describe("detectContentType — text scan", () => {
  test.each([
    ["doctype", "<!DOCTYPE html><html></html>", "text/html"],
    ["html tag", "<html lang='en'>", "text/html"],
    ["script", "<script>alert(1)</script>", "text/html"],
    ["comment", "<!-- a comment -->", "text/html"],
    ["uppercase svg", "<SVG xmlns='...'></SVG>", "image/svg+xml"],
    ["bare svg", "<svg/>", "image/svg+xml"],
    ["xml prolog + svg", "<?xml version='1.0'?><svg></svg>", "image/svg+xml"],
    ["xml prolog only", "<?xml version='1.0'?><root/>", "application/xml"],
  ])("detects %s", (_name, text, expected) => {
    expect(detectContentType(ascii(text))).toBe(expected);
  });

  test("skips a leading BOM and whitespace", () => {
    const withBom = bytes(0xef, 0xbb, 0xbf, ...ascii("  \n<svg/>"));
    expect(detectContentType(withBom)).toBe("image/svg+xml");
  });

  test("a tag-like name that isn't a known tag is not html", () => {
    expect(detectContentType(ascii("<svgaroo>"))).toBeUndefined();
  });

  test("plain text matches nothing", () => {
    expect(detectContentType(ascii("just some words"))).toBeUndefined();
  });

  test("an empty body matches nothing", () => {
    expect(detectContentType(new Uint8Array(0))).toBeUndefined();
  });
});

describe("contentType plugin — correct (default)", () => {
  test("rewrites a mislabeled .png that is really HTML", async () => {
    const files = withContentType();
    await files.upload("avatar.png", ascii("<html><body>x</body></html>"), {
      contentType: "image/png",
    });
    expect(await typeOf(files, "avatar.png")).toBe("text/html");
  });

  test("fills in a generic (unset) type from the bytes", async () => {
    const files = withContentType();
    // "blob" has no extension and no contentType, so the SDK default is octet.
    await files.upload("blob", PNG);
    expect(await typeOf(files, "blob")).toBe("image/png");
  });

  test("leaves an honest declared type — and its params — untouched", async () => {
    const files = withContentType();
    await files.upload("page.html", ascii("<html></html>"), {
      contentType: "text/html; charset=utf-8",
    });
    expect(await typeOf(files, "page.html")).toBe("text/html; charset=utf-8");
  });

  test("reads a Blob's own (lying) type when no contentType is given", async () => {
    const files = withContentType();
    await files.upload("b", new Blob([ascii("<svg/>")], { type: "image/png" }));
    expect(await typeOf(files, "b")).toBe("image/svg+xml");
  });
});

describe("contentType plugin — reject", () => {
  test("throws on a genuine mismatch", async () => {
    const files = withContentType({ onMismatch: "reject" });
    await expect(
      files.upload("avatar.png", ascii("<html></html>"), {
        contentType: "image/png",
      })
    ).rejects.toThrow(
      /is declared "image\/png" but its bytes are "text\/html"/u
    );
  });

  test("still fills a generic type rather than rejecting it", async () => {
    const files = withContentType({ onMismatch: "reject" });
    // A declared octet-stream is "unset", not a contradiction.
    await files.upload("blob", PNG);
    expect(await typeOf(files, "blob")).toBe("image/png");
  });
});

describe("contentType plugin — unknown bytes", () => {
  test("trusts the declared type by default", async () => {
    const files = withContentType();
    await files.upload("notes.txt", "hello there", {
      contentType: "text/plain; charset=utf-8",
    });
    expect(await typeOf(files, "notes.txt")).toBe("text/plain; charset=utf-8");
  });

  test("rejects when onUnknown is reject", async () => {
    const files = withContentType({ onUnknown: "reject" });
    await expect(files.upload("mystery.bin", bytes(1, 2, 3))).rejects.toThrow(
      /could not identify the contents/u
    );
  });
});

describe("contentType plugin — body shapes", () => {
  test("ArrayBuffer", async () => {
    const files = withContentType();
    await files.upload("file", PDF.buffer);
    expect(await typeOf(files, "file")).toBe("application/pdf");
  });

  test("ArrayBufferView (non-Uint8Array)", async () => {
    const files = withContentType();
    await files.upload("file", new Int8Array(PNG));
    expect(await typeOf(files, "file")).toBe("image/png");
  });

  test("Blob without a type infers from the key, leaving honest matches", async () => {
    const files = withContentType();
    // ".png" + PNG bytes already agree, so nothing is rewritten.
    await files.upload("photo.png", new Blob([PNG]));
    const file = await files.download("photo.png");
    const out = new Uint8Array(await file.arrayBuffer());
    expect(out).toEqual(PNG);
  });
});

describe("contentType plugin — streams", () => {
  test("sniffs a short stream that ends within the peek window", async () => {
    const files = withContentType();
    await files.upload("icon", streamOf(ascii("<svg/>")));
    const file = await files.download("icon");
    expect(file.type).toBe("image/svg+xml");
    expect(await file.text()).toBe("<svg/>");
  });

  test("replays the prefix and the remainder of a longer stream", async () => {
    const files = withContentType();
    const head = new Uint8Array(600);
    head.set(PNG, 0);
    const tail = new Uint8Array(100).fill(7);
    await files.upload("big", streamOf(head, tail));
    const file = await files.download("big");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(700);
  });

  test("cancelling the replayed body cancels the source stream", async () => {
    let sourceCancelled = false;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        sourceCancelled = true;
      },
      start(controller) {
        // 600 bytes (>= the peek window) leaves the stream open afterwards.
        const chunk = new Uint8Array(600);
        chunk.set(PNG, 0);
        controller.enqueue(chunk);
      },
    });
    const adapter: Adapter = {
      ...fakeAdapter(),
      async upload(key, body) {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        await reader.cancel();
        return { contentType: "image/png", key, size: 0 };
      },
    };
    const files = new Files({ adapter, plugins: [contentType()] });
    await files.upload("img", source);
    expect(sourceCancelled).toBe(true);
  });
});

describe("contentType plugin — pass-through verbs", () => {
  test("signedUploadUrl fails closed", async () => {
    const files = withContentType();
    await expect(
      files.signedUploadUrl("a.png", { expiresIn: 60 })
    ).rejects.toThrow(/bypasses magic-byte sniffing/u);
  });

  test("download, copy, move, and url pass straight through", async () => {
    const files = withContentType();
    await files.upload("a.png", PNG);
    await files.copy("a.png", "b.png");
    await files.move("b.png", "c.png");
    expect(await files.exists("c.png")).toBe(true);
    expect(await files.url("a.png")).toContain("a.png");
    const file = await files.download("a.png");
    const out = new Uint8Array(await file.arrayBuffer());
    expect(out).toEqual(PNG);
  });
});
