import { describe, expect, test } from "bun:test";

import type {
  BunS3ClientLike,
  BunS3FileLike,
  BunS3ListObjectsOptions,
  BunS3OperationOptions,
  BunS3PresignOptions,
  BunS3Stats,
  BunS3WritableBody,
} from "../src/bun-s3/index.js";
import { bunS3, mapBunS3Error } from "../src/bun-s3/index.js";
import { Files, FilesError } from "../src/index.js";

interface Entry {
  bytes: Uint8Array;
  etag: string;
  lastModified: Date;
  type: string;
}

const encoder = new TextEncoder();

const toBytes = async (body: BunS3WritableBody): Promise<Uint8Array> => {
  if (typeof body === "string") {
    return encoder.encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Response) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (body instanceof Request) {
    return new Uint8Array(await body.arrayBuffer());
  }
  return new Uint8Array(await body.arrayBuffer());
};

class FakeBunS3Client implements BunS3ClientLike {
  readonly entries = new Map<string, Entry>();
  readonly signingOrigin = "https://signed.example.com";
  readonly writes: { key: string; options?: BunS3OperationOptions }[] = [];

  file(path: string): BunS3FileLike {
    const bytes = (): Promise<Uint8Array> =>
      Promise.resolve(this.mustGet(path).bytes);
    return {
      async arrayBuffer(): Promise<ArrayBuffer> {
        const data = await bytes();
        return data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength
        ) as ArrayBuffer;
      },
      bytes,
      stat: () => this.stat(path),
      stream: () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(await bytes());
            controller.close();
          },
        }),
    };
  }

  mustGet(key: string): Entry {
    const entry = this.entries.get(key);
    if (!entry) {
      throw Object.assign(new Error("missing"), {
        code: "NoSuchKey",
        status: 404,
      });
    }
    return entry;
  }

  async write(
    path: string,
    data: BunS3WritableBody,
    options?: BunS3OperationOptions
  ): Promise<number> {
    const bytes = await toBytes(data);
    this.entries.set(path, {
      bytes,
      etag: `"etag-${path}"`,
      lastModified: new Date(1_700_000_000_000 + this.entries.size),
      type: options?.type ?? "application/octet-stream",
    });
    this.writes.push({ key: path, options });
    return bytes.byteLength;
  }

  delete(path: string): Promise<void> {
    this.entries.delete(path);
    return Promise.resolve();
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.entries.has(path));
  }

  stat(path: string): Promise<BunS3Stats> {
    const entry = this.mustGet(path);
    return Promise.resolve({
      etag: entry.etag,
      lastModified: entry.lastModified,
      size: entry.bytes.byteLength,
      type: entry.type,
    });
  }

  list(input?: BunS3ListObjectsOptions | null) {
    const keys = [...this.entries.keys()]
      .filter((key) => !input?.prefix || key.startsWith(input.prefix))
      .toSorted();
    const startIndex = input?.continuationToken
      ? Math.max(0, keys.indexOf(input.continuationToken) + 1)
      : 0;
    const endIndex =
      input?.maxKeys === undefined ? keys.length : startIndex + input.maxKeys;
    const page = keys.slice(startIndex, endIndex);
    return Promise.resolve({
      contents: page.map((key) => {
        const entry = this.mustGet(key);
        return {
          eTag: entry.etag,
          key,
          lastModified: entry.lastModified.toISOString(),
          size: entry.bytes.byteLength,
        };
      }),
      isTruncated: endIndex < keys.length,
      nextContinuationToken: page.at(-1),
    });
  }

  readonly presign = (path: string, options?: BunS3PresignOptions): string => {
    const params = new URLSearchParams({
      expires: String(options?.expiresIn ?? ""),
      method: options?.method ?? "GET",
    });
    if (options?.type) {
      params.set("type", options.type);
    }
    if (options?.contentDisposition) {
      params.set("content-disposition", options.contentDisposition);
    }
    return `${this.signingOrigin}/${encodeURIComponent(path)}?${params}`;
  };
}

describe("bun-s3 adapter", () => {
  test("upload and download round-trip through a Bun S3 client", async () => {
    const client = new FakeBunS3Client();
    const files = new Files({ adapter: bunS3({ client }) });

    const result = await files.upload("a.txt", "hello", {
      contentType: "text/plain",
    });
    expect(result).toMatchObject({
      contentType: "text/plain",
      etag: "etag-a.txt",
      key: "a.txt",
      size: 5,
    });

    const got = await files.download("a.txt");
    expect(await got.text()).toBe("hello");
    expect(got.type).toBe("text/plain");
    expect(got.etag).toBe("etag-a.txt");
    expect(client.writes[0]?.options?.type).toBe("text/plain");
  });

  test("upload accepts ReadableStream bodies by wrapping them for Bun.s3", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("streamed"));
        controller.close();
      },
    });

    const result = await adapter.upload("stream.txt", stream);
    expect(result.size).toBe(8);
    const downloaded = await adapter.download("stream.txt");
    expect(await downloaded.text()).toBe("streamed");
  });

  test("head returns metadata and lazily fetches the body", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("h.txt", "lazy", { contentType: "text/custom" });

    const head = await adapter.head("h.txt");
    expect(head.size).toBe(4);
    expect(head.type).toBe("text/custom");
    expect(await head.text()).toBe("lazy");
  });

  test("exists returns false for missing objects", async () => {
    const adapter = bunS3({ client: new FakeBunS3Client() });

    await expect(adapter.exists("missing.txt")).resolves.toBe(false);
  });

  test("copy reads from the Bun S3 file and writes the destination", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("from.txt", "copy me", { contentType: "text/plain" });

    await adapter.copy("from.txt", "to.txt");

    const copied = await adapter.download("to.txt");
    expect(await copied.text()).toBe("copy me");
    expect(copied.type).toBe("text/plain");
  });

  test("list maps Bun S3 objects into StoredFile items with cursor", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("a/1.txt", "1");
    await adapter.upload("a/2.txt", "22");
    await adapter.upload("b/3.txt", "333");

    const out = await adapter.list({ limit: 1, prefix: "a/" });
    expect(out.items.map((item) => item.key)).toEqual(["a/1.txt"]);
    expect(out.cursor).toBe("a/1.txt");
    expect(await out.items[0]?.text()).toBe("1");
  });

  test("url returns publicBaseUrl unless responseContentDisposition forces signing", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({
      client,
      publicBaseUrl: "https://cdn.example.com/",
    });

    expect(await adapter.url("a b.txt")).toBe(
      "https://cdn.example.com/a%20b.txt"
    );
    const signed = await adapter.url("a b.txt", {
      responseContentDisposition: "attachment",
    });
    expect(signed).toContain("https://signed.example.com/");
    expect(signed).toContain("content-disposition=attachment");
  });

  test("signedUploadUrl returns PUT URLs and rejects maxSize", async () => {
    const adapter = bunS3({ client: new FakeBunS3Client() });

    const out = await adapter.signedUploadUrl("up.txt", {
      contentType: "text/plain",
      expiresIn: 60,
    });
    expect(out).toEqual({
      headers: { "Content-Type": "text/plain" },
      method: "PUT",
      url: "https://signed.example.com/up.txt?expires=60&method=PUT&type=text%2Fplain",
    });

    await expect(
      adapter.signedUploadUrl("up.txt", { expiresIn: 60, maxSize: 1024 })
    ).rejects.toMatchObject({ code: "Provider" });
  });

  test("unsupported upload options throw instead of being ignored", async () => {
    const adapter = bunS3({ client: new FakeBunS3Client() });

    await expect(
      adapter.upload("m.txt", "x", { metadata: { user: "1" } })
    ).rejects.toThrow(/metadata/u);
    await expect(
      adapter.upload("c.txt", "x", { cacheControl: "max-age=60" })
    ).rejects.toThrow(/cacheControl/u);
  });

  test("rejects ambiguous options when a custom client is provided", () => {
    const client = new FakeBunS3Client();
    expect(() => bunS3({ bucket: "b", client })).toThrow(
      /client.*bucket\/region\/credentials.*bucket/u
    );
    expect(() =>
      bunS3({ accessKeyId: "x", client, region: "us-east-1" })
    ).toThrow(/region, accessKeyId/u);
  });

  test("maps Bun S3 errors into FilesError codes", () => {
    const missing = Object.assign(new Error("nope"), { status: 404 });
    expect(mapBunS3Error(missing)).toBeInstanceOf(FilesError);
    expect(
      mapBunS3Error(
        Object.assign(new Error("denied"), {
          code: "ERR_S3_MISSING_CREDENTIALS",
        })
      ).code
    ).toBe("Unauthorized");
    expect(
      mapBunS3Error(
        Object.assign(new Error("bad path"), {
          code: "ERR_S3_INVALID_PATH",
        })
      ).code
    ).toBe("Provider");
  });
});
