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
    const stat = (): Promise<BunS3Stats> => this.stat(path);
    // `build` recurses through slice() so a sliced handle reads only its
    // sub-range — Blob-style exclusive end, matching Bun's S3File.slice.
    const build = (read: () => Promise<Uint8Array>): BunS3FileLike => ({
      async arrayBuffer(): Promise<ArrayBuffer> {
        const data = await read();
        return data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength
        ) as ArrayBuffer;
      },
      bytes: read,
      slice: (begin?: number, end?: number) =>
        build(async () => {
          const data = await read();
          return data.subarray(begin, end);
        }),
      stat,
      stream: () =>
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(await read());
            controller.close();
          },
        }),
    });
    return build(() => Promise.resolve(this.mustGet(path).bytes));
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

  test("mapBunS3Error classifies via HTTP status and known codes", () => {
    expect(
      mapBunS3Error(Object.assign(new Error("not found"), { statusCode: 404 }))
        .code
    ).toBe("NotFound");
    expect(
      mapBunS3Error(Object.assign(new Error("forbidden"), { status: 403 })).code
    ).toBe("Unauthorized");
    expect(
      mapBunS3Error(
        Object.assign(new Error("etag mismatch"), {
          code: "PreconditionFailed",
        })
      ).code
    ).toBe("Conflict");
    expect(
      mapBunS3Error(
        Object.assign(new Error("aws-style"), { Code: "NoSuchKey" })
      ).code
    ).toBe("NotFound");
    // FilesError instances pass through unchanged so adapters can rethrow
    // their own programmatic errors without re-wrapping.
    const preWrapped = new FilesError("Provider", "explicit");
    expect(mapBunS3Error(preWrapped)).toBe(preWrapped);
  });

  test("delete removes the underlying object", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("d.txt", "bye");
    expect(client.entries.has("d.txt")).toBe(true);
    await adapter.delete("d.txt");
    expect(client.entries.has("d.txt")).toBe(false);
  });

  test("download stream mode returns a readable stream of the bytes", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("s.txt", "stream me", { contentType: "text/plain" });

    const got = await adapter.download("s.txt", { as: "stream" });
    expect(got.type).toBe("text/plain");
    expect(got.size).toBe(9);
    const reader = got.stream().getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
    const flat = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const c of chunks) {
      flat.set(c, offset);
      offset += c.byteLength;
    }
    expect(new TextDecoder().decode(flat)).toBe("stream me");
  });

  test("range slices via Bun's exclusive-end slice() and reports slice length", async () => {
    const client = new FakeBunS3Client();
    const files = new Files({ adapter: bunS3({ client }) });
    await files.upload("r.txt", "0123456789", { contentType: "text/plain" });
    const got = await files.download("r.txt", { range: { end: 4, start: 2 } });
    expect(await got.text()).toBe("234");
    expect(got.size).toBe(3);
  });

  test("open-ended range streams from start to EOF", async () => {
    const client = new FakeBunS3Client();
    const files = new Files({ adapter: bunS3({ client }) });
    await files.upload("r.txt", "0123456789", { contentType: "text/plain" });
    const got = await files.download("r.txt", {
      as: "stream",
      range: { start: 7 },
    });
    expect(got.size).toBe(3);
    const reader = got.stream().getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
    const flat = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const c of chunks) {
      flat.set(c, offset);
      offset += c.byteLength;
    }
    expect(new TextDecoder().decode(flat)).toBe("789");
  });

  test("download maps provider errors for missing keys", async () => {
    const adapter = bunS3({ client: new FakeBunS3Client() });
    await expect(adapter.download("missing.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("head maps provider errors for missing keys", async () => {
    const adapter = bunS3({ client: new FakeBunS3Client() });
    await expect(adapter.head("missing.txt")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("head body is lazy and fetched only when accessed", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("h-lazy.txt", "hi", { contentType: "text/plain" });

    let bytesCalls = 0;
    const origFile = client.file.bind(client);
    client.file = (path) => {
      const f = origFile(path);
      return {
        ...f,
        bytes: () => {
          bytesCalls += 1;
          return f.bytes ? f.bytes() : Promise.resolve(new Uint8Array());
        },
      };
    };
    const meta = await adapter.head("h-lazy.txt");
    expect(bytesCalls).toBe(0);
    expect(await meta.text()).toBe("hi");
    expect(bytesCalls).toBe(1);
  });

  test("exists rethrows non-NotFound provider errors", async () => {
    const client = new FakeBunS3Client();
    client.exists = () =>
      Promise.reject(Object.assign(new Error("forbidden"), { status: 403 }));
    const adapter = bunS3({ client });
    await expect(adapter.exists("k")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("copy maps provider errors when the source is missing", async () => {
    const adapter = bunS3({ client: new FakeBunS3Client() });
    await expect(adapter.copy("nope", "to")).rejects.toMatchObject({
      code: "NotFound",
    });
  });

  test("copy preserves the source content type", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("from.bin", new Uint8Array([1, 2, 3]), {
      contentType: "application/x-thing",
    });
    await adapter.copy("from.bin", "to.bin");
    const dest = client.entries.get("to.bin");
    expect(dest?.type).toBe("application/x-thing");
  });

  test("list without options returns all items and paginates via cursor", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("k1", "a");
    await adapter.upload("k2", "bb");
    await adapter.upload("k3", "ccc");

    const all = await adapter.list();
    expect(all.items.map((i) => i.key)).toEqual(["k1", "k2", "k3"]);
    expect(all.cursor).toBeUndefined();

    const first = await adapter.list({ limit: 2 });
    expect(first.items.map((i) => i.key)).toEqual(["k1", "k2"]);
    expect(first.cursor).toBe("k2");
    const second = await adapter.list({ cursor: first.cursor, limit: 2 });
    expect(second.items.map((i) => i.key)).toEqual(["k3"]);
    expect(second.cursor).toBeUndefined();
  });

  test("list items carry parsed lastModified and lazily fetch bodies", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("a.txt", "hi");
    const { items } = await adapter.list();
    const [item] = items;
    expect(item?.lastModified).toBe(
      client.entries.get("a.txt")?.lastModified.getTime()
    );
    expect(await item?.text()).toBe("hi");
  });

  test("list maps provider errors", async () => {
    const client = new FakeBunS3Client();
    client.list = () =>
      Promise.reject(Object.assign(new Error("denied"), { status: 403 }));
    const adapter = bunS3({ client });
    await expect(adapter.list()).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("signedUploadUrl omits Content-Type header when none is requested", async () => {
    const adapter = bunS3({ client: new FakeBunS3Client() });
    const out = await adapter.signedUploadUrl("up.txt", { expiresIn: 60 });
    expect(out.method).toBe("PUT");
    if (out.method !== "PUT") {
      throw new Error("expected PUT");
    }
    expect(out.headers).toBeUndefined();
    expect(out.url).toContain("method=PUT");
    expect(out.url).not.toContain("type=");
  });

  test("signedUploadUrl maps presign errors", async () => {
    const client = new FakeBunS3Client();
    // override presign to throw
    (client as unknown as { presign: BunS3ClientLike["presign"] }).presign =
      () => {
        throw Object.assign(new Error("bad sig"), {
          code: "ERR_S3_INVALID_SIGNATURE",
        });
      };
    const adapter = bunS3({ client });
    await expect(
      adapter.signedUploadUrl("up.txt", { expiresIn: 60 })
    ).rejects.toMatchObject({ code: "Unauthorized" });
  });

  test("url signs with defaultUrlExpiresIn when no per-call expiry is set", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client, defaultUrlExpiresIn: 42 });
    const u = await adapter.url("k.txt");
    expect(u).toContain("expires=42");
    expect(u).toContain("method=GET");
  });

  test("url honors per-call expiresIn override", async () => {
    const adapter = bunS3({ client: new FakeBunS3Client() });
    const u = await adapter.url("k.txt", { expiresIn: 7 });
    expect(u).toContain("expires=7");
  });

  test("url maps presign errors", async () => {
    const client = new FakeBunS3Client();
    (client as unknown as { presign: BunS3ClientLike["presign"] }).presign =
      () => {
        throw new Error("boom");
      };
    const adapter = bunS3({ client });
    await expect(adapter.url("k")).rejects.toMatchObject({ code: "Provider" });
  });

  test("upload infers content type from a Blob body", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    const blob = new Blob(["payload"], { type: "image/svg+xml" });

    const result = await adapter.upload("blob.svg", blob);
    expect(result.contentType).toBe("image/svg+xml");
    expect(client.writes.at(-1)?.options?.type).toBe("image/svg+xml");
  });

  test("upload falls back when the post-write stat probe fails", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    const origStat = client.stat.bind(client);
    let statCalls = 0;
    client.stat = (path) => {
      statCalls += 1;
      if (statCalls === 1) {
        return Promise.reject(new Error("stat unavailable"));
      }
      return origStat(path);
    };
    const result = await adapter.upload("f.txt", "hello", {
      contentType: "text/plain",
    });
    expect(result).toEqual({
      contentType: "text/plain",
      key: "f.txt",
      size: 5,
    });
  });

  test("upload maps errors from the underlying write", async () => {
    const client = new FakeBunS3Client();
    client.write = () =>
      Promise.reject(Object.assign(new Error("denied"), { status: 403 }));
    const adapter = bunS3({ client });
    await expect(adapter.upload("k.txt", "x")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("delete maps provider errors from the underlying client", async () => {
    const client = new FakeBunS3Client();
    client.delete = () =>
      Promise.reject(Object.assign(new Error("denied"), { status: 403 }));
    const adapter = bunS3({ client });
    await expect(adapter.delete("k.txt")).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  test("default-client construction passes options to Bun.S3Client", () => {
    const g = globalThis as unknown as {
      Bun?: {
        S3Client?: unknown;
      };
    };
    const originalS3Client = g.Bun?.S3Client;
    if (!g.Bun) {
      g.Bun = {};
    }
    const captured: BunS3OperationOptions[] = [];
    const FakeCtor = function FakeS3Client(
      this: unknown,
      options?: BunS3OperationOptions
    ): void {
      if (options) {
        captured.push(options);
      }
    } as unknown as new (options?: BunS3OperationOptions) => BunS3ClientLike;
    g.Bun.S3Client = FakeCtor;
    try {
      const adapter = bunS3({
        accessKeyId: "AKIA",
        bucket: "b",
        endpoint: "https://s3.example.com",
        region: "us-west-2",
        secretAccessKey: "secret",
        sessionToken: "session",
        virtualHostedStyle: true,
      });
      expect(adapter.bucket).toBe("b");
      expect(captured[0]).toEqual({
        accessKeyId: "AKIA",
        bucket: "b",
        endpoint: "https://s3.example.com",
        region: "us-west-2",
        secretAccessKey: "secret",
        sessionToken: "session",
        virtualHostedStyle: true,
      });
    } finally {
      g.Bun.S3Client = originalS3Client;
    }
  });

  test("default-client construction throws when Bun.S3Client is unavailable", () => {
    const g = globalThis as unknown as {
      Bun?: { S3Client?: unknown };
    };
    const originalS3Client = g.Bun?.S3Client;
    if (!g.Bun) {
      g.Bun = {};
    }
    g.Bun.S3Client = undefined;
    try {
      expect(() => bunS3()).toThrow(/only available in the Bun runtime/u);
    } finally {
      g.Bun.S3Client = originalS3Client;
    }
  });
});
