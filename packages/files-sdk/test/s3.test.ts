import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Readable } from "node:stream";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { sdkStreamMixin } from "@smithy/util-stream";
import { mockClient } from "aws-sdk-client-mock";

import { Files, FilesError } from "../src/index.js";
import { mapS3Error, s3 } from "../src/s3/index.js";

const s3Mock = mockClient(S3Client);

// Stub @aws-sdk/lib-storage so the multipart/progress path is deterministic
// without a real multipart upload. Imported lazily by the adapter, so it's only
// pulled in when an upload needs progress, multipart, or an unsized stream. The
// static fields let tests assert how the adapter constructed the Upload.
type ProgressListener = (p: { loaded?: number; total?: number }) => void;
interface UploadOpts {
  params?: { Body?: unknown };
  partSize?: number;
  queueSize?: number;
}
class FakeUpload {
  static instances = 0;
  static lastOptions: UploadOpts | undefined;
  static aborted = 0;
  static reset(): void {
    FakeUpload.instances = 0;
    FakeUpload.lastOptions = undefined;
    FakeUpload.aborted = 0;
  }
  #listeners: ProgressListener[] = [];
  constructor(options: UploadOpts) {
    FakeUpload.instances += 1;
    FakeUpload.lastOptions = options;
  }
  on(event: string, listener: ProgressListener): void {
    if (event === "httpUploadProgress") {
      this.#listeners.push(listener);
    }
  }
  done(): Promise<{ ETag: string }> {
    for (const notify of this.#listeners) {
      notify({ loaded: 5, total: 10 });
      notify({ loaded: 10, total: 10 });
    }
    return Promise.resolve({ ETag: '"progress-etag"' });
  }
  abort(): Promise<void> {
    FakeUpload.aborted += 1;
    this.#listeners = [];
    return Promise.resolve();
  }
}
mock.module("@aws-sdk/lib-storage", () => ({ Upload: FakeUpload }));

beforeEach(() => {
  s3Mock.reset();
  FakeUpload.reset();
});

afterEach(() => {
  s3Mock.reset();
});

const streamBody = (bytes: Uint8Array | string) => {
  const buf =
    typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  return sdkStreamMixin(Readable.from(buf));
};

const firstCall = <T extends { args: unknown[] }>(calls: T[]): T => {
  const [first] = calls;
  if (!first) {
    throw new Error("expected at least one call");
  }
  return first;
};

describe("s3 adapter", () => {
  test("upload sends PutObjectCommand with bucket/key/contentType/metadata", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"abc"' });
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    const result = await files.upload("a.txt", "hello", {
      cacheControl: "public, max-age=60",
      contentType: "text/plain",
      metadata: { x: "y" },
    });
    expect(result.key).toBe("a.txt");
    expect(result.contentType).toBe("text/plain");
    expect(result.etag).toBe("abc");

    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const [{ input }] = firstCall(calls).args;
    expect(input.Bucket).toBe("test-bucket");
    expect(input.Key).toBe("a.txt");
    expect(input.ContentType).toBe("text/plain");
    expect(input.Metadata).toEqual({ x: "y" });
    expect(input.CacheControl).toBe("public, max-age=60");
  });

  test("upload forwards lib-storage progress to onProgress", async () => {
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    const events: { loaded: number; total?: number }[] = [];
    const result = await files.upload("big.bin", "hello", {
      onProgress: (p) => events.push(p),
    });

    expect(events).toEqual([
      { loaded: 5, total: 10 },
      { loaded: 10, total: 10 },
    ]);
    expect(result.etag).toBe("progress-etag");
    // The progress path goes through lib-storage's Upload, not PutObjectCommand.
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test("multipart: true routes through lib-storage Upload, not PutObject", async () => {
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    const result = await files.upload("big.bin", "hello", { multipart: true });

    expect(FakeUpload.instances).toBe(1);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(result.etag).toBe("progress-etag");
    // Size is known locally (string body), so no follow-up head is needed.
    expect(result.size).toBe(5);
  });

  test("multipart object forwards partSize and concurrency to Upload", async () => {
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    await files.upload("big.bin", "hello", {
      multipart: { concurrency: 8, partSize: 5 * 1024 * 1024 },
    });

    expect(FakeUpload.lastOptions?.partSize).toBe(5 * 1024 * 1024);
    expect(FakeUpload.lastOptions?.queueSize).toBe(8);
  });

  test("multipart defaults queueSize to 4 and omits partSize", async () => {
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    await files.upload("big.bin", "hello", { multipart: true });

    expect(FakeUpload.lastOptions?.queueSize).toBe(4);
    expect(FakeUpload.lastOptions?.partSize).toBeUndefined();
  });

  test("unknown-length stream auto-engages Upload without the multipart flag", async () => {
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 11,
      LastModified: new Date(1000),
    });
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello world"));
        controller.close();
      },
    });
    const result = await files.upload("stream.bin", stream);

    expect(FakeUpload.instances).toBe(1);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    // CompleteMultipartUpload carries no size, so the unsized stream falls back
    // to a follow-up head() for the authoritative size and lastModified.
    expect(result.size).toBe(11);
    expect(result.lastModified).toBe(1000);
  });

  test("plain sized upload still uses PutObject (Upload not loaded)", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"plain"' });
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    await files.upload("a.txt", "hello");

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    expect(FakeUpload.instances).toBe(0);
  });

  test("download returns a StoredFile with body bytes", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: streamBody("hello") as unknown as undefined,
      ContentLength: 5,
      ContentType: "text/plain",
      ETag: '"e"',
    });
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    const got = await files.download("a.txt");
    expect(got.key).toBe("a.txt");
    expect(await got.text()).toBe("hello");
    expect(got.type).toBe("text/plain");
    expect(got.etag).toBe("e");
  });

  test("download forwards a byte range as the S3 Range param", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      // S3 replies 206 with the slice as the body and ContentLength set to it.
      Body: streamBody("234") as unknown as undefined,
      ContentLength: 3,
      ContentType: "text/plain",
    });
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    const got = await files.download("a.txt", { range: { end: 4, start: 2 } });
    expect(await got.text()).toBe("234");
    expect(got.size).toBe(3);
    const calls = s3Mock.commandCalls(GetObjectCommand);
    const [{ input }] = firstCall(calls).args;
    expect(input.Range).toBe("bytes=2-4");
  });

  test("download with an open-ended range sends bytes=start-", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: streamBody("789") as unknown as undefined,
      ContentLength: 3,
      ContentType: "text/plain",
    });
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    await adapter.download("a.txt", { range: { start: 7 } });
    const calls = s3Mock.commandCalls(GetObjectCommand);
    const [{ input }] = firstCall(calls).args;
    expect(input.Range).toBe("bytes=7-");
  });

  test("head returns metadata without fetching body", async () => {
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 7,
      ContentType: "application/json",
      ETag: '"h"',
      Metadata: { foo: "bar" },
    });
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    const info = await files.head("a.json");
    expect(info.size).toBe(7);
    expect(info.type).toBe("application/json");
    expect(info.etag).toBe("h");
    expect(info.metadata).toEqual({ foo: "bar" });
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  test("exists returns true for present keys and false for missing keys", async () => {
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    s3Mock.on(HeadObjectCommand).resolves({});
    await expect(files.exists("a.txt")).resolves.toBe(true);

    s3Mock.reset();
    s3Mock.on(HeadObjectCommand).rejects(
      Object.assign(new Error("missing"), {
        $metadata: { httpStatusCode: 404 },
        name: "NotFound",
      })
    );
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("delete sends DeleteObjectCommand", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    await files.delete("a.txt");
    const calls = s3Mock.commandCalls(DeleteObjectCommand);
    expect(calls).toHaveLength(1);
    const [{ input }] = firstCall(calls).args;
    expect(input.Bucket).toBe("test-bucket");
    expect(input.Key).toBe("a.txt");
  });

  test("deleteMany uses DeleteObjectsCommand when stopOnError is false", async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({
      Deleted: [{ Key: "a.txt" }, { Key: "c.txt" }],
      Errors: [{ Code: "AccessDenied", Key: "b.txt", Message: "denied" }],
    });
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });

    const result = await files.delete(["a.txt", "b.txt", "c.txt"]);

    expect(result.deleted).toEqual(["a.txt", "c.txt"]);
    expect(result.errors?.map((item) => item.key)).toEqual(["b.txt"]);
    expect(result.errors?.[0]?.error.code).toBe("Unauthorized");
    const calls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(calls).toHaveLength(1);
    const [{ input }] = firstCall(calls).args;
    expect(input.Delete?.Objects).toEqual([
      { Key: "a.txt" },
      { Key: "b.txt" },
      { Key: "c.txt" },
    ]);
  });

  test("deleteMany stops on the first error when stopOnError is true", async () => {
    s3Mock
      .on(DeleteObjectCommand)
      .resolvesOnce({})
      .rejectsOnce(
        Object.assign(new Error("denied"), {
          $metadata: { httpStatusCode: 403 },
          name: "AccessDenied",
        })
      );
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });

    const result = await files.delete(["a.txt", "b.txt", "c.txt"], {
      stopOnError: true,
    });

    expect(result.deleted).toEqual(["a.txt"]);
    expect(result.errors?.map((item) => item.key)).toEqual(["b.txt"]);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(2);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  test("deleteMany chunks DeleteObjectsCommand into batches of 1000", async () => {
    const keys = Array.from({ length: 1500 }, (_, i) => `k-${i}.txt`);
    s3Mock
      .on(DeleteObjectsCommand)
      .resolvesOnce({ Deleted: keys.slice(0, 1000).map((Key) => ({ Key })) })
      .resolvesOnce({ Deleted: keys.slice(1000).map((Key) => ({ Key })) });
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });

    const result = await files.delete(keys);

    expect(result.deleted).toEqual(keys);
    expect(result.errors).toBeUndefined();
    const calls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args[0].input.Delete?.Objects).toHaveLength(1000);
    expect(calls[1]?.args[0].input.Delete?.Objects).toHaveLength(500);
  });

  test("copy sends CopyObjectCommand with encoded source", async () => {
    s3Mock.on(CopyObjectCommand).resolves({});
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    await files.copy("foo bar.txt", "to.txt");
    const calls = s3Mock.commandCalls(CopyObjectCommand);
    expect(calls).toHaveLength(1);
    const [{ input }] = firstCall(calls).args;
    expect(input.CopySource).toBe("test-bucket/foo%20bar.txt");
  });

  test("operation signals are forwarded to the AWS client", async () => {
    const { signal } = new AbortController();
    s3Mock.on(HeadObjectCommand).resolves({});
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });

    await files.head("a.txt", { signal });

    const call = firstCall(s3Mock.commandCalls(HeadObjectCommand));
    const [, options] = call.args as [
      HeadObjectCommand,
      { abortSignal?: AbortSignal }?,
    ];
    expect(options).toEqual({ abortSignal: signal });
  });

  test("list maps Contents into StoredFile items", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { ETag: '"1"', Key: "a/1.txt", LastModified: new Date(), Size: 1 },
        { ETag: '"2"', Key: "a/2.txt", LastModified: new Date(), Size: 2 },
      ],
      IsTruncated: true,
      NextContinuationToken: "next",
    });
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    const out = await files.list({ limit: 10, prefix: "a/" });
    expect(out.items.map((i) => i.key)).toEqual(["a/1.txt", "a/2.txt"]);
    expect(out.cursor).toBe("next");
    const calls = s3Mock.commandCalls(ListObjectsV2Command);
    const [{ input }] = firstCall(calls).args;
    expect(input.Prefix).toBe("a/");
    expect(input.MaxKeys).toBe(10);
  });

  test("url() returns a presigned GET URL by default (no publicBaseUrl)", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    // Default expiry should land on 3600 (1 hour).
    expect(url).toContain("X-Amz-Expires=3600");
  });

  test("url() honors a per-call expiresIn override", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
    });
    const url = await adapter.url("a.txt", { expiresIn: 120 });
    expect(url).toContain("X-Amz-Expires=120");
  });

  test("url() honors the adapter-level defaultUrlExpiresIn", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      defaultUrlExpiresIn: 300,
      region: "us-east-1",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Expires=300");
  });

  test("url() returns the publicBaseUrl when configured (no signing)", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      publicBaseUrl: "https://cdn.example.com",
      region: "us-east-1",
    });
    const url = await adapter.url("a.txt");
    expect(url).toBe("https://cdn.example.com/a.txt");
    // No signature querystring when we route around signing.
    expect(url).not.toContain("X-Amz-Signature=");
  });

  test("url() trims a trailing slash on publicBaseUrl", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      publicBaseUrl: "https://cdn.example.com/",
      region: "us-east-1",
    });
    expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
  });

  test("url() URL-encodes special characters in the key but preserves / as path separator", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      publicBaseUrl: "https://cdn.example.com",
      region: "us-east-1",
    });
    const url = await adapter.url("foo bar?baz#qux/a&b");
    expect(url).toBe("https://cdn.example.com/foo%20bar%3Fbaz%23qux/a%26b");
  });

  test("NoSuchKey is mapped to NotFound", async () => {
    s3Mock.on(GetObjectCommand).rejects(
      Object.assign(new Error("nope"), {
        $metadata: { httpStatusCode: 404 },
        name: "NoSuchKey",
      })
    );
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    try {
      await files.download("missing");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("AccessDenied is mapped to Unauthorized", async () => {
    s3Mock.on(GetObjectCommand).rejects(
      Object.assign(new Error("denied"), {
        $metadata: { httpStatusCode: 403 },
        name: "AccessDenied",
      })
    );
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    try {
      await files.download("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Unauthorized");
    }
  });

  test("upload normalizes Uint8Array bodies and forwards content length", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const result = await adapter.upload("k", new Uint8Array([1, 2, 3]));
    expect(result.size).toBe(3);
    const calls = s3Mock.commandCalls(PutObjectCommand);
    const [{ input }] = firstCall(calls).args;
    expect(input.Body).toBeInstanceOf(Uint8Array);
    expect(input.ContentType).toBe("application/octet-stream");
    expect(input.ContentLength).toBe(3);
  });

  test("upload normalizes ArrayBuffer bodies", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const ab = new Uint8Array([1, 2, 3, 4]).buffer;
    const result = await adapter.upload("k", ab);
    expect(result.size).toBe(4);
    const [{ input }] = firstCall(s3Mock.commandCalls(PutObjectCommand)).args;
    expect(input.ContentLength).toBe(4);
  });

  test("upload normalizes ArrayBufferView (DataView) bodies", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const view = new DataView(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    const result = await adapter.upload("k", view);
    expect(result.size).toBe(5);
  });

  test("upload normalizes Blob bodies and uses Blob.type as default", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const blob = new Blob([new Uint8Array([1, 2])], { type: "image/png" });
    const result = await adapter.upload("k", blob);
    expect(result.contentType).toBe("image/png");
    expect(result.size).toBe(2);
  });

  test("upload accepts ReadableStream bodies (auto-engages Upload)", async () => {
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: 2,
      LastModified: new Date(1_700_000_000_000),
    });
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.close();
      },
    });
    const result = await adapter.upload("k", stream);
    // Unknown-length streams can't be sent in a single PutObject, so they
    // auto-route to lib-storage's Upload, which streams the body part-by-part.
    expect(FakeUpload.instances).toBe(1);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(FakeUpload.lastOptions?.params?.Body).toBe(stream);
    expect(result.size).toBe(2);
    expect(result.lastModified).toBe(1_700_000_000_000);
  });

  test("upload of a stream body falls back to size 0 if the head() probe fails", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(HeadObjectCommand).rejects(new Error("transient"));
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.close();
      },
    });
    const result = await adapter.upload("k", stream);
    expect(result.size).toBe(0);
    expect(result.lastModified).toBeUndefined();
  });

  test("download as stream returns a streaming StoredFile", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: streamBody("streamed") as unknown as undefined,
      ContentLength: 8,
      ContentType: "text/plain",
    });
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const got = await adapter.download("a.txt", { as: "stream" });
    const reader = got.stream().getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
      }
    }
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    expect(total).toBe(8);
  });

  test("head's lazy body factory fetches via GetObjectCommand", async () => {
    s3Mock
      .on(HeadObjectCommand)
      .resolves({ ContentLength: 5, ContentType: "text/plain", ETag: '"e"' });
    s3Mock.on(GetObjectCommand).resolves({
      Body: streamBody("hello") as unknown as undefined,
      ContentLength: 5,
    });
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const info = await adapter.head("k");
    expect(await info.text()).toBe("hello");
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
  });

  test("list items lazily fetch their body via GetObjectCommand", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { ETag: '"1"', Key: "a.txt", LastModified: new Date(), Size: 5 },
      ],
      IsTruncated: false,
    });
    s3Mock.on(GetObjectCommand).resolves({
      Body: streamBody("hello") as unknown as undefined,
      ContentLength: 5,
    });
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const out = await adapter.list();
    const [item] = out.items;
    if (!item) {
      throw new Error("expected at least one item");
    }
    expect(await item.text()).toBe("hello");
  });

  test("url forwards responseContentDisposition for forced-attachment downloads", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
    });
    const url = await adapter.url("k.txt", {
      expiresIn: 60,
      responseContentDisposition: "attachment",
    });
    // S3 surfaces the override as `response-content-disposition` in the
    // querystring — without this the browser would render uploaded HTML
    // inline at the bucket's domain.
    expect(url).toContain("response-content-disposition=attachment");
    expect(url).toContain("X-Amz-Signature=");
  });

  test("url with responseContentDisposition forces signing even when publicBaseUrl is set", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      publicBaseUrl: "https://cdn.example.com",
      region: "us-east-1",
    });
    // Without the override, publicBaseUrl wins.
    expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
    // With the override, signing wins because permanent CDN URLs can't
    // carry a Content-Disposition override — silently dropping it would
    // be a security regression.
    const signed = await adapter.url("a.txt", {
      responseContentDisposition: "attachment",
    });
    expect(signed).toContain("X-Amz-Signature=");
    expect(signed).toContain("response-content-disposition=attachment");
    expect(signed).not.toContain("cdn.example.com");
  });

  test("signedUploadUrl returns method PUT with content-type header when no maxSize", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
    });
    const out = await adapter.signedUploadUrl("k.txt", {
      contentType: "text/plain",
      expiresIn: 60,
    });
    expect(out.method).toBe("PUT");
    if (out.method === "PUT") {
      expect(out.url).toContain("X-Amz-Signature=");
      expect(out.headers).toEqual({ "Content-Type": "text/plain" });
    }
  });

  test("signedUploadUrl returns method POST with fields when maxSize is set", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
    });
    const out = await adapter.signedUploadUrl("k.txt", {
      contentType: "image/png",
      expiresIn: 60,
      maxSize: 1024,
    });
    expect(out.method).toBe("POST");
    if (out.method === "POST") {
      expect(typeof out.url).toBe("string");
      expect(out.fields).toBeDefined();
      expect(out.fields["Content-Type"]).toBe("image/png");
    }
  });

  test("signedUploadUrl POST policy defaults the content-length lower bound to 1 (rejects 0-byte uploads)", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
    });
    const out = await adapter.signedUploadUrl("k.txt", {
      expiresIn: 60,
      maxSize: 1024,
    });
    expect(out.method).toBe("POST");
    if (out.method === "POST") {
      const policyJson = JSON.parse(
        Buffer.from(out.fields.Policy ?? "", "base64").toString("utf-8")
      );
      const range = (policyJson.conditions as unknown[]).find(
        (c): c is [string, number, number] =>
          Array.isArray(c) && c[0] === "content-length-range"
      );
      expect(range).toEqual(["content-length-range", 1, 1024]);
    }
  });

  test("signedUploadUrl POST policy honors explicit minSize: 0 when callers want empty uploads", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
    });
    const out = await adapter.signedUploadUrl("k.txt", {
      expiresIn: 60,
      maxSize: 1024,
      minSize: 0,
    });
    if (out.method === "POST") {
      const policyJson = JSON.parse(
        Buffer.from(out.fields.Policy ?? "", "base64").toString("utf-8")
      );
      const range = (policyJson.conditions as unknown[]).find(
        (c): c is [string, number, number] =>
          Array.isArray(c) && c[0] === "content-length-range"
      );
      expect(range).toEqual(["content-length-range", 0, 1024]);
    }
  });

  test("PreconditionFailed maps to Conflict", async () => {
    s3Mock.on(DeleteObjectCommand).rejects(
      Object.assign(new Error("conflict"), {
        $metadata: { httpStatusCode: 412 },
        name: "PreconditionFailed",
      })
    );
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    try {
      await adapter.delete("k");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Conflict");
    }
  });

  test("upload error is mapped to Provider for unknown S3 errors", async () => {
    s3Mock.on(PutObjectCommand).rejects(
      Object.assign(new Error("server error"), {
        $metadata: { httpStatusCode: 500 },
        name: "InternalError",
      })
    );
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    try {
      await adapter.upload("k", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toBe("server error");
    }
  });

  test("copy AccessDenied maps to Unauthorized", async () => {
    s3Mock.on(CopyObjectCommand).rejects(
      Object.assign(new Error("denied"), {
        $metadata: { httpStatusCode: 403 },
        name: "AccessDenied",
      })
    );
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    try {
      await adapter.copy("a", "b");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Unauthorized");
    }
  });

  test("head error: 404 maps to NotFound", async () => {
    s3Mock.on(HeadObjectCommand).rejects(
      Object.assign(new Error("nope"), {
        $metadata: { httpStatusCode: 404 },
        name: "NotFound",
      })
    );
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    try {
      await adapter.head("missing");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("list error: 500 maps to Provider", async () => {
    s3Mock.on(ListObjectsV2Command).rejects(
      Object.assign(new Error("oops"), {
        $metadata: { httpStatusCode: 500 },
      })
    );
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    try {
      await adapter.list();
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toBe("oops");
    }
  });

  test("mapS3Error falls back to default message when err has no message", () => {
    const err = mapS3Error({ $metadata: { httpStatusCode: 500 } });
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("S3 error");
  });

  test("mapS3Error returns the same FilesError instance when given one", () => {
    const original = new FilesError("Conflict", "boom");
    expect(mapS3Error(original)).toBe(original);
  });

  test("download as stream falls back to an empty stream when Body is undefined", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      ContentLength: 0,
      ContentType: "text/plain",
    });
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const got = await adapter.download("a.txt", { as: "stream" });
    const reader = got.stream().getReader();
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  test("url: presigner errors are mapped via mapS3Error", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
    });
    try {
      await adapter.url("k.txt", { expiresIn: 10_000_000 });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
    }
  });

  test("signedUploadUrl PUT path: presigner errors are mapped via mapS3Error", async () => {
    const adapter = s3({
      bucket: "b",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      region: "us-east-1",
    });
    // SigV4 caps expiresIn at 604800 seconds; anything larger throws.
    try {
      await adapter.signedUploadUrl("k.txt", { expiresIn: 10_000_000 });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
    }
  });

  test("missing region throws at construction", () => {
    const oldRegion = process.env.AWS_REGION;
    const oldDefault = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      expect(() => s3({ bucket: "x" })).toThrow(/region/u);
    } finally {
      if (oldRegion) {
        process.env.AWS_REGION = oldRegion;
      }
      if (oldDefault) {
        process.env.AWS_DEFAULT_REGION = oldDefault;
      }
    }
  });

  test("deleteMany with an empty key list resolves to an empty result without any request", async () => {
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const result = await adapter.deleteMany?.([]);
    expect(result).toEqual({ deleted: [] });
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  test("deleteMany with stopOnError returns all keys when every delete succeeds", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const result = await adapter.deleteMany?.(["a.txt", "b.txt", "c.txt"], {
      stopOnError: true,
    });
    expect(result?.deleted).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(result?.errors).toBeUndefined();
    // stopOnError takes the per-key path, never the bulk DeleteObjects.
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(3);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  test("deleteMany maps a whole-batch DeleteObjects failure onto every key in the batch", async () => {
    s3Mock.on(DeleteObjectsCommand).rejects(
      Object.assign(new Error("denied"), {
        $metadata: { httpStatusCode: 403 },
        name: "AccessDenied",
      })
    );
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const result = await adapter.deleteMany?.(["a.txt", "b.txt"]);
    // S3 doesn't tell us which keys failed when the request itself fails, so
    // the mapped error is attached to every key in the batch.
    expect(result?.deleted).toEqual([]);
    expect(result?.errors?.map((item) => item.key)).toEqual(["a.txt", "b.txt"]);
    expect(
      result?.errors?.every((item) => item.error.code === "Unauthorized")
    ).toBe(true);
    // The same mapped instance is reused across the batch's keys.
    expect(result?.errors?.[0]?.error).toBe(result?.errors?.[1]?.error);
  });

  test("mapS3Error 2-arg form returns the same FilesError instance when given one", () => {
    const original = new FilesError("NotFound", "gone");
    const mapped = mapS3Error(original, {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "R2 error",
      Unauthorized: "Unauthorized",
    });
    expect(mapped).toBe(original);
  });

  test("mapS3Error 2-arg form re-derives the code and prefers the original error's message", () => {
    const mapped = mapS3Error(
      Object.assign(new Error("server said no"), {
        $metadata: { httpStatusCode: 403 },
        name: "AccessDenied",
      }),
      {
        Conflict: "Conflict",
        NotFound: "Not found",
        Provider: "R2 error",
        Unauthorized: "Unauthorized",
      }
    );
    // Code is re-derived from the SDK error (403/AccessDenied -> Unauthorized).
    expect(mapped.code).toBe("Unauthorized");
    // The original message wins over the per-code fallback table.
    expect(mapped.message).toBe("server said no");
  });

  test("mapS3Error 2-arg form falls back to the per-code message when the error has none", () => {
    const mapped = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      {
        Conflict: "Conflict",
        NotFound: "Not found",
        Provider: "R2 error",
        Unauthorized: "Unauthorized",
      }
    );
    expect(mapped.code).toBe("Provider");
    expect(mapped.message).toBe("R2 error");
  });

  test("aborting an in-flight lib-storage upload calls Upload.abort()", async () => {
    const controller = new AbortController();
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    const events: { loaded: number }[] = [];
    // The abort listener is wired before Upload.done() runs, so aborting
    // from inside the first progress callback deterministically triggers it.
    await adapter.upload("big.bin", "hello", {
      multipart: true,
      onProgress: (p) => {
        events.push(p);
        controller.abort();
      },
      signal: controller.signal,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(FakeUpload.aborted).toBe(1);
  });
});
