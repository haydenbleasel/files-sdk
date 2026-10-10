import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";

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
import { Files, FilesError, UploadControl } from "../src/index.js";
import type { ResumableUploadSession } from "../src/index.js";

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
    const prefix = input?.prefix ?? "";
    const matching = [...this.entries.keys()]
      .filter((key) => key.startsWith(prefix))
      .toSorted();
    // Mirror S3: with a delimiter, keys past the next delimiter roll up into
    // commonPrefixes instead of appearing in contents.
    const commonPrefixes = new Set<string>();
    const keys = matching.filter((key) => {
      const cut = input?.delimiter
        ? key.indexOf(input.delimiter, prefix.length)
        : -1;
      if (cut === -1) {
        return true;
      }
      commonPrefixes.add(key.slice(0, cut + (input?.delimiter?.length ?? 0)));
      return false;
    });
    const startIndex = input?.continuationToken
      ? Math.max(0, keys.indexOf(input.continuationToken) + 1)
      : 0;
    const endIndex =
      input?.maxKeys === undefined ? keys.length : startIndex + input.maxKeys;
    const page = keys.slice(startIndex, endIndex);
    return Promise.resolve({
      ...(commonPrefixes.size > 0 && {
        commonPrefixes: [...commonPrefixes].map((p) => ({ prefix: p })),
      }),
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

  test("head returns plain metadata", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("h.txt", "meta", { contentType: "text/custom" });

    const head = await adapter.head("h.txt");
    expect(head).toEqual({
      contentType: "text/custom",
      etag: expect.any(String),
      key: "h.txt",
      lastModified: client.entries.get("h.txt")?.lastModified.getTime(),
      size: 4,
    });
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

  test("list maps Bun S3 objects into FileInfo items with cursor", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("a/1.txt", "1");
    await adapter.upload("a/2.txt", "22");
    await adapter.upload("b/3.txt", "333");

    const out = await adapter.list({ limit: 1, prefix: "a/" });
    expect(out.items.map((item) => item.key)).toEqual(["a/1.txt"]);
    expect(out.cursor).toBe("a/1.txt");
    expect(out.items[0]?.size).toBe(1);
  });

  test("list with a delimiter forwards it and surfaces Bun's commonPrefixes", async () => {
    const client = new FakeBunS3Client();
    const listCalls: (BunS3ListObjectsOptions | null | undefined)[] = [];
    const list = client.list.bind(client);
    client.list = (input) => {
      listCalls.push(input);
      return list(input);
    };
    const files = new Files({ adapter: bunS3({ client }) });
    expect(files.capabilities.delimiter).toBe("any");
    await files.upload("top.txt", "t");
    await files.upload("a/1.txt", "1");
    await files.upload("a/deep/2.txt", "2");
    await files.upload("b/3.txt", "3");

    const root = await files.list({ delimiter: "/" });
    expect(listCalls.at(-1)).toMatchObject({ delimiter: "/" });
    expect(root.items.map((item) => item.key)).toEqual(["top.txt"]);
    expect(root.prefixes).toEqual(["a/", "b/"]);

    const nested = await files.list({ delimiter: "/", prefix: "a/" });
    expect(nested.items.map((item) => item.key)).toEqual(["a/1.txt"]);
    expect(nested.prefixes).toEqual(["a/deep/"]);

    // No delimiter: no prefixes key at all, every key listed.
    const flat = await files.list();
    expect(flat.prefixes).toBeUndefined();
    expect(flat.items).toHaveLength(4);
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

  test("an explicit expiresIn signs even with publicBaseUrl configured", async () => {
    const files = new Files({
      adapter: bunS3({
        client: new FakeBunS3Client(),
        publicBaseUrl: "https://cdn.example.com",
      }),
    });
    expect(files.capabilities.publicUrl).toBe(true);
    expect(await files.url("k.txt")).toBe("https://cdn.example.com/k.txt");
    expect(await files.url("k.txt", { expiresIn: 90 })).toBe(
      "https://signed.example.com/k.txt?expires=90&method=GET"
    );
  });

  test("declares range + delimiter, no metadata/cacheControl/progress, and a client-side copy", () => {
    const files = new Files({
      adapter: bunS3({ client: new FakeBunS3Client() }),
    });
    expect(files.capabilities).toMatchObject({
      cacheControl: false,
      delimiter: "any",
      metadata: false,
      publicUrl: false,
      rangeRead: true,
      resumable: true,
      serverSideCopy: false,
      uploadProgress: false,
    });
  });

  test("signedUpload is a SigV4-capped presigned PUT that enforces neither maxSize nor contentType", () => {
    const files = new Files({
      adapter: bunS3({ client: new FakeBunS3Client() }),
    });
    expect(files.capabilities.signedUpload).toEqual({
      contentType: false,
      maxExpiresIn: 604_800,
      maxSize: false,
      supported: true,
    });
  });

  test("signedUploadUrl returns PUT URLs and rejects maxSize", async () => {
    const adapter = bunS3({ client: new FakeBunS3Client() });

    const out = await adapter.signedUploadUrl("up.txt", { expiresIn: 60 });
    expect(out).toEqual({
      method: "PUT",
      url: "https://signed.example.com/up.txt?expires=60&method=PUT",
    });

    await expect(
      adapter.signedUploadUrl("up.txt", { expiresIn: 60, maxSize: 1024 })
    ).rejects.toMatchObject({ code: "Unsupported" });
    // A size floor needs the same POST policy; `minSize: 0` asks for nothing.
    await expect(
      adapter.signedUploadUrl("up.txt", { expiresIn: 60, minSize: 1 })
    ).rejects.toMatchObject({
      code: "Unsupported",
      message: expect.stringMatching(/`minSize` is not supported/u),
    });
    expect(
      await adapter.signedUploadUrl("up.txt", { expiresIn: 60, minSize: 0 })
    ).toMatchObject({ method: "PUT" });
  });

  test("url and signedUploadUrl reject expiresIn past the SigV4 one-week cap", async () => {
    const client = new FakeBunS3Client();
    let presigned = 0;
    const { presign } = client;
    (client as unknown as { presign: BunS3ClientLike["presign"] }).presign = (
      path,
      options
    ) => {
      presigned += 1;
      return presign(path, options);
    };
    const adapter = bunS3({ client });
    const eightDays = 8 * 24 * 60 * 60;
    expect(new Files({ adapter }).capabilities.signedUrl).toEqual({
      disposition: true,
      expiry: "exact",
      maxExpiresIn: 604_800,
      supported: true,
    });

    const urlError = await adapter.url("k.txt", { expiresIn: eightDays }).then(
      () => null,
      (error_: unknown) => error_
    );
    expect(urlError).toBeInstanceOf(FilesError);
    expect((urlError as FilesError).code).toBe("Invalid");
    expect((urlError as FilesError).permanent).toBe(true);
    expect((urlError as FilesError).message).toMatch(
      /^Bun S3 error: presigned URLs must expire within 604800 seconds/u
    );
    await expect(
      adapter.signedUploadUrl("k.txt", { expiresIn: eightDays })
    ).rejects.toMatchObject({ code: "Invalid", permanent: true });
    // A too-long default fails the same way.
    await expect(
      bunS3({ client, defaultUrlExpiresIn: eightDays }).url("k.txt")
    ).rejects.toMatchObject({ code: "Invalid" });
    expect(presigned).toBe(0);

    // An explicit expiresIn signs even with a publicBaseUrl, so the cap
    // applies there too.
    const pub = bunS3({ client, publicBaseUrl: "https://cdn.example.com" });
    await expect(
      pub.url("k.txt", { expiresIn: eightDays })
    ).rejects.toMatchObject({ code: "Invalid" });
    expect(presigned).toBe(0);

    // Exactly one week still signs.
    expect(await adapter.url("k.txt", { expiresIn: 604_800 })).toContain(
      "expires=604800"
    );
  });

  test("signedUploadUrl rejects contentType: Bun's presign can't sign it", async () => {
    // Bun signs only `host`; its `type` option becomes a response-content-type
    // query param that binds nothing on a PUT, so the type isn't enforced.
    const client = new FakeBunS3Client();
    let presigned = 0;
    const { presign } = client;
    (client as unknown as { presign: BunS3ClientLike["presign"] }).presign = (
      path,
      options
    ) => {
      presigned += 1;
      return presign(path, options);
    };
    const adapter = bunS3({ client });
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = adapter.signedUploadUrl("up.txt", {
        contentType: "text/plain",
        expiresIn: 60,
      });
    }).not.toThrow();
    const error = await (pending as Promise<unknown>).then(
      () => null,
      (error_: unknown) => error_
    );
    expect(error).toBeInstanceOf(FilesError);
    expect((error as FilesError).code).toBe("Unsupported");
    expect((error as FilesError).permanent).toBe(true);
    expect((error as FilesError).message).toMatch(
      /contentType.*not supported/u
    );
    expect(presigned).toBe(0);
  });

  test("unsupported upload options throw instead of being ignored", async () => {
    // Gated centrally by the Files wrapper: the adapter declares neither
    // `capabilities.metadata` nor `capabilities.cacheControl`.
    const files = new Files({
      adapter: bunS3({ client: new FakeBunS3Client() }),
    });

    await expect(
      files.upload("m.txt", "x", { metadata: { user: "1" } })
    ).rejects.toThrow(/metadata/u);
    await expect(
      files.upload("c.txt", "x", { cacheControl: "max-age=60" })
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

  test("credential failures are Unauthorized on every verb, not retried", async () => {
    // Bun's S3Error copies the XML <Code> and carries no HTTP status, so a
    // bad secret or key id is recognizable only by its code.
    for (const code of [
      "SignatureDoesNotMatch",
      "InvalidAccessKeyId",
      "ExpiredToken",
      "InvalidToken",
    ]) {
      const s3Error = () =>
        Object.assign(new Error(`${code} from S3`), { code, name: "S3Error" });
      expect(mapBunS3Error(s3Error())).toMatchObject({
        code: "Unauthorized",
        permanent: false,
      });
      const client = new FakeBunS3Client();
      client.entries.set("a.txt", {
        bytes: encoder.encode("a"),
        etag: '"e"',
        lastModified: new Date(0),
        type: "text/plain",
      });
      let calls = 0;
      const reject = () => {
        calls += 1;
        return Promise.reject(s3Error());
      };
      client.list = reject;
      client.write = reject;
      client.delete = reject;
      const files = new Files({ adapter: bunS3({ client }), retries: 3 });
      for (const run of [
        () => files.list(),
        () => files.upload("b.txt", "x"),
        () => files.delete("a.txt"),
        () => files.copy("a.txt", "c.txt"),
      ]) {
        calls = 0;
        // oxlint-disable-next-line no-await-in-loop -- one verb at a time, so the call count is per verb
        await expect(run()).rejects.toMatchObject({ code: "Unauthorized" });
        expect(calls).toBe(1);
      }
    }
  });

  test("a range past the end of the object (InvalidRange) is a permanent Provider error", async () => {
    const client = new FakeBunS3Client();
    await client.write("small.txt", "abc");
    let reads = 0;
    const { file } = client;
    client.file = (path) => {
      const handle = file.call(client, path);
      return {
        ...handle,
        slice: () => ({
          ...handle,
          bytes: () => {
            reads += 1;
            return Promise.reject(
              Object.assign(
                new Error("The requested range is not satisfiable"),
                {
                  code: "InvalidRange",
                  name: "S3Error",
                }
              )
            );
          },
        }),
      };
    };
    const files = new Files({ adapter: bunS3({ client }), retries: 3 });
    await expect(
      files.download("small.txt", { range: { start: 10 } })
    ).rejects.toMatchObject({
      code: "Provider",
      message: "The requested range is not satisfiable",
      permanent: true,
    });
    expect(reads).toBe(1);
    // Other unclassified failures stay retryable.
    expect(
      mapBunS3Error(Object.assign(new Error("boom"), { code: "InternalError" }))
        .permanent
    ).toBe(false);
  });

  test("a zero, negative, fractional, or NaN expiresIn is refused, per call or as the default", async () => {
    const client = new FakeBunS3Client();
    let presigned = 0;
    const { presign } = client;
    (client as unknown as { presign: BunS3ClientLike["presign"] }).presign = (
      path,
      options
    ) => {
      presigned += 1;
      return presign(path, options);
    };
    const adapter = bunS3({ client });
    for (const expiresIn of [0, -5, 1.5, Number.NaN]) {
      const invalid = {
        code: "Invalid",
        message: expect.stringMatching(
          /^Bun S3 error: a presigned URL's expiry must be a whole number of seconds, at least 1/u
        ),
      };
      // oxlint-disable-next-line no-await-in-loop -- one value at a time
      await expect(adapter.url("k.txt", { expiresIn })).rejects.toMatchObject(
        invalid
      );
      // oxlint-disable-next-line no-await-in-loop -- one value at a time
      await expect(
        bunS3({ client, defaultUrlExpiresIn: expiresIn }).url("k.txt")
      ).rejects.toMatchObject(invalid);
      // oxlint-disable-next-line no-await-in-loop -- one value at a time
      await expect(
        adapter.signedUploadUrl("k.txt", { expiresIn })
      ).rejects.toMatchObject(invalid);
    }
    expect(presigned).toBe(0);
    expect(await adapter.url("k.txt", { expiresIn: 1 })).toContain("expires=1");
  });

  test("a contentType that can't be a header is refused before the write", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    for (const contentType of ["text/plain\r\nx-evil: 1", "text/é"]) {
      // oxlint-disable-next-line no-await-in-loop -- one value at a time
      await expect(
        adapter.upload("k.txt", "x", { contentType })
      ).rejects.toMatchObject({
        code: "Invalid",
        message: expect.stringMatching(
          /^Bun S3 error: `contentType` can't be sent as an HTTP header/u
        ),
      });
      const driver = adapter.resumableUpload?.("k.bin", {});
      // oxlint-disable-next-line no-await-in-loop -- one value at a time
      await expect(
        driver?.begin({ contentType, total: 1 })
      ).rejects.toMatchObject({ code: "Invalid" });
    }
    expect(client.writes).toHaveLength(0);
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

  test("range downloads survive Bun's getter-backed S3Stats (spread copies nothing)", async () => {
    // Real Bun returns S3Stats whose fields are prototype getters, so
    // `{ ...stat }` is `{}` and lastModified came back undefined (crash).
    class GetterStats implements BunS3Stats {
      readonly #entry: Entry;
      constructor(entry: Entry) {
        this.#entry = entry;
      }
      get etag(): string {
        return this.#entry.etag;
      }
      get lastModified(): Date {
        return this.#entry.lastModified;
      }
      get size(): number {
        return this.#entry.bytes.byteLength;
      }
      get type(): string {
        return this.#entry.type;
      }
    }
    class GetterStatClient extends FakeBunS3Client {
      override stat(path: string): Promise<BunS3Stats> {
        return Promise.resolve(new GetterStats(this.mustGet(path)));
      }
    }
    const client = new GetterStatClient();
    const files = new Files({ adapter: bunS3({ client }) });
    await files.upload("r.txt", "0123456789", { contentType: "text/plain" });
    const stat = await client.stat("r.txt");
    // The reproduction: spreading the getter-backed stats copies nothing.
    expect(Object.keys({ ...stat })).toEqual([]);

    const buffered = await files.download("r.txt", {
      range: { end: 4, start: 2 },
    });
    expect(await buffered.text()).toBe("234");
    expect(buffered.size).toBe(3);
    expect(buffered.type).toBe("text/plain");
    expect(buffered.etag).toBe("etag-r.txt");
    expect(buffered.lastModified).toBe(stat.lastModified.getTime());

    const streamed = await files.download("r.txt", {
      as: "stream",
      range: { start: 7 },
    });
    expect(streamed.size).toBe(3);
    expect(streamed.type).toBe("text/plain");
    expect(await streamed.text()).toBe("789");
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
      // eslint-disable-next-line no-await-in-loop -- sequentially draining a stream reader
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

  test("head never opens the object body", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("h-meta.txt", "hi", { contentType: "text/plain" });

    let fileCalls = 0;
    const origFile = client.file.bind(client);
    client.file = (path) => {
      fileCalls += 1;
      return origFile(path);
    };
    const meta = await adapter.head("h-meta.txt");
    expect(meta.contentType).toBe("text/plain");
    expect(fileCalls).toBe(0);
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

  test("list items are plain metadata with a parsed lastModified", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("a.txt", "hi");
    const { items } = await adapter.list();
    expect(items).toEqual([
      {
        contentType: "text/plain; charset=utf-8",
        etag: expect.any(String),
        key: "a.txt",
        lastModified: client.entries.get("a.txt")?.lastModified.getTime(),
        size: 2,
      },
    ]);
  });

  test("list infers the content type from the key, like the rest of the S3 family", async () => {
    const client = new FakeBunS3Client();
    const adapter = bunS3({ client });
    await adapter.upload("docs/report.csv", "a,b");
    await adapter.upload("docs/photo.png", "x");
    await adapter.upload("docs/blob", "y");
    const { items } = await adapter.list({ prefix: "docs/" });
    const types = Object.fromEntries(
      items.map((item) => [item.key, item.contentType])
    );
    expect(types["docs/report.csv"]).toBe("text/csv; charset=utf-8");
    expect(types["docs/photo.png"]).toBe("image/png");
    // No extension to go on, so the generic fallback still applies.
    expect(types["docs/blob"]).toBe("application/octet-stream");
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

describe("bun-s3 resumable uploads (in-process)", () => {
  test("fresh upload buffers chunks and writes once", async () => {
    const client = new FakeBunS3Client();
    const files = new Files({ adapter: bunS3({ client }) });
    const control = new UploadControl();
    const result = await files.upload("big.bin", "abcdefghijkl", {
      control,
      multipart: { partSize: 4 },
    });
    expect(result.size).toBe(12);
    expect(control.status).toBe("completed");
    const got = await files.download("big.bin");
    expect(await got.text()).toBe("abcdefghijkl");
    expect(control.session?.provider).toBe("bun-s3");
  });

  test("pause holds the upload, resume finishes it", async () => {
    const client = new FakeBunS3Client();
    const files = new Files({ adapter: bunS3({ client }) });
    const control = new UploadControl();
    let paused = false;
    const promise = files.upload("p.bin", new Uint8Array(12).fill(7), {
      control,
      multipart: { concurrency: 1, partSize: 4 },
      onProgress: ({ loaded }) => {
        if (loaded === 4 && !paused) {
          paused = true;
          control.pause();
        }
      },
    });
    await delay(0);
    await delay(0);
    expect(control.status).toBe("paused");
    control.resume();
    const result = await promise;
    expect(result.size).toBe(12);
  });

  test("abort discards the pending upload", async () => {
    const client = new FakeBunS3Client();
    const files = new Files({ adapter: bunS3({ client }) });
    const control = new UploadControl();
    let aborting: Promise<void> | undefined;
    const promise = files.upload("a.bin", new Uint8Array(12).fill(9), {
      control,
      multipart: { concurrency: 1, partSize: 4 },
      onProgress: ({ loaded }) => {
        if (loaded === 4 && !aborting) {
          aborting = control.abort();
        }
      },
    });
    await expect(promise).rejects.toMatchObject({ aborted: true });
    await aborting;
    expect(control.status).toBe("aborted");
    expect(await files.exists("a.bin")).toBe(false);
  });

  test("a token can't be resumed in a different instance", async () => {
    const files = new Files({
      adapter: bunS3({ client: new FakeBunS3Client() }),
    });
    const token: ResumableUploadSession = {
      contentType: "text/plain",
      key: "x.bin",
      provider: "bun-s3",
      uploadId: "bun-1",
    };
    await expect(
      files.upload("x.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toMatchObject({
      code: "Unsupported",
      message: expect.stringMatching(/in-process only/u),
    });
  });

  test("metadata and cacheControl are rejected", async () => {
    const files = new Files({
      adapter: bunS3({ client: new FakeBunS3Client() }),
    });
    await expect(
      files.upload("m.bin", "data", {
        control: new UploadControl(),
        metadata: { a: "b" },
      })
    ).rejects.toThrow(/metadata/u);
    await expect(
      files.upload("c.bin", "data", {
        cacheControl: "public",
        control: new UploadControl(),
      })
    ).rejects.toThrow(/cacheControl/u);
  });

  test("resuming a non-bun-s3 token throws", async () => {
    const files = new Files({
      adapter: bunS3({ client: new FakeBunS3Client() }),
    });
    const token = {
      bucket: "b",
      key: "x.bin",
      provider: "gcs",
      uri: "u",
    } as ResumableUploadSession;
    await expect(
      files.upload("x.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toMatchObject({
      code: "Invalid",
      message: expect.stringMatching(/Cannot resume a gcs/u),
    });
  });
});

// What Bun 1.4 throws for a failed HEAD that isn't a 404: no status, and no
// body to read a code from.
const unknownError = () =>
  Object.assign(new Error("an unexpected error has occurred"), {
    code: "UnknownError",
    name: "S3Error",
  });

describe("bun-s3 status-less HEAD failures", () => {
  // A fake whose HEAD (`stat` / `exists`) fails the way Bun's does and whose
  // presigned URLs point at a local server answering with `status`.
  const failingHeads = (status: number) => {
    let probes = 0;
    const server = Bun.serve({
      fetch(req) {
        probes += 1;
        expect(req.method).toBe("HEAD");
        return new Response(null, { status });
      },
      port: 0,
    });
    const client = new FakeBunS3Client();
    client.entries.set("k", {
      bytes: new Uint8Array([1]),
      etag: '"e"',
      lastModified: new Date(0),
      type: "text/plain",
    });
    client.stat = () => Promise.reject(unknownError());
    client.exists = () => Promise.reject(unknownError());
    const file = client.file.bind(client);
    client.file = (path) => ({ ...file(path), stat: () => client.stat(path) });
    const presign = client.presign.bind(client);
    // oxlint-disable-next-line typescript/no-explicit-any -- the fake's readonly arrow is swapped per test
    (client as any).presign = (path: string, options?: BunS3PresignOptions) =>
      presign(path, options).replace(
        client.signingOrigin,
        `http://localhost:${server.port}`
      );
    return { client, probes: () => probes, stop: () => server.stop(true) };
  };

  test("a 401/403 is re-read from a presigned HEAD and surfaces as Unauthorized", async () => {
    for (const status of [401, 403]) {
      const { client, probes, stop } = failingHeads(status);
      try {
        const adapter = bunS3({ client });
        for (const run of [
          () => adapter.head("k"),
          () => adapter.download("k"),
          () => adapter.exists("k"),
          () => adapter.copy("k", "to"),
        ]) {
          // oxlint-disable-next-line no-await-in-loop -- sequential cases against one server
          const rejection = await run().then(
            () => null,
            (error: unknown) => error
          );
          expect(rejection).toBeInstanceOf(FilesError);
          expect((rejection as FilesError).code).toBe("Unauthorized");
          // The original Bun error stays on the chain.
          expect((rejection as FilesError).cause).toMatchObject({
            code: "UnknownError",
          });
        }
        expect(probes()).toBe(4);
      } finally {
        stop();
      }
    }
  });

  test("Files does not retry the re-classified auth failure", async () => {
    const { client, probes, stop } = failingHeads(403);
    try {
      const files = new Files({ adapter: bunS3({ client }), retries: 2 });
      await expect(files.download("k")).rejects.toMatchObject({
        code: "Unauthorized",
      });
      expect(probes()).toBe(1);
    } finally {
      stop();
    }
  });

  test("a 5xx, or a HEAD that now succeeds, keeps the retryable Provider error", async () => {
    for (const status of [500, 200]) {
      const { client, stop } = failingHeads(status);
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential cases
        await expect(bunS3({ client }).head("k")).rejects.toMatchObject({
          code: "Provider",
          message: "an unexpected error has occurred",
        });
      } finally {
        stop();
      }
    }
  });

  test("a probe that can't run keeps the original error, and coded errors skip the probe", async () => {
    const client = new FakeBunS3Client();
    client.stat = () => Promise.reject(unknownError());
    // oxlint-disable-next-line typescript/no-explicit-any -- the fake's readonly arrow is swapped per test
    (client as any).presign = () => {
      throw new Error("no credentials");
    };
    const adapter = bunS3({ client });
    await expect(adapter.head("k")).rejects.toMatchObject({
      code: "Provider",
    });
    // A rejection that isn't an object at all is mapped without probing.
    client.stat = () => Promise.reject(new Error("plain"));
    await expect(adapter.head("k")).rejects.toMatchObject({
      code: "Provider",
      message: "plain",
    });
    client.stat = () =>
      // oxlint-disable-next-line prefer-promise-reject-errors -- a non-Error rejection is the case under test
      Promise.reject("boom");
    await expect(adapter.head("k")).rejects.toBeInstanceOf(FilesError);
  });

  test("end to end on Bun's own S3Client: a bodyless 403 HEAD is Unauthorized", async () => {
    let requests = 0;
    const server = Bun.serve({
      fetch() {
        requests += 1;
        return new Response(null, { status: 403 });
      },
      port: 0,
    });
    try {
      const files = new Files({
        adapter: bunS3({
          accessKeyId: "a",
          bucket: "b",
          endpoint: `http://localhost:${server.port}`,
          region: "us-east-1",
          secretAccessKey: "s",
        }),
        retries: 2,
      });
      await expect(files.head("k")).rejects.toMatchObject({
        code: "Unauthorized",
      });
      // Bun's HEAD plus the status probe; no retries.
      expect(requests).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});
