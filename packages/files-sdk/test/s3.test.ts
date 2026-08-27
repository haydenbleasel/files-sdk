import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Readable } from "node:stream";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { sdkStreamMixin } from "@smithy/util-stream";
import { mockClient } from "aws-sdk-client-mock";

import { Files, FilesError, UploadControl } from "../src/index.js";
import type {
  AdapterUploadOptions,
  ResumableUploadSession,
} from "../src/index.js";
import { mapS3Error, s3 } from "../src/s3/index.js";
import type { S3Adapter } from "../src/s3/index.js";

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
  static completed = 0;
  static reset(): void {
    FakeUpload.instances = 0;
    FakeUpload.lastOptions = undefined;
    FakeUpload.aborted = 0;
    FakeUpload.completed = 0;
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
    FakeUpload.completed += 1;
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
    typeof bytes === "string"
      ? Buffer.from(bytes, "utf-8")
      : Buffer.from(bytes);
  return sdkStreamMixin(Readable.from(buf));
};

const firstCall = <T extends { args: unknown[] }>(calls: T[]): T => {
  const [first] = calls;
  if (!first) {
    throw new Error("expected at least one call");
  }
  return first;
};

const requireNativeConditional = (
  adapter: S3Adapter
): Required<NonNullable<S3Adapter["conditional"]>> => {
  const { conditional } = adapter;
  const {
    copy,
    create,
    delete: remove,
    exactRead,
    replace,
  } = conditional ?? {};
  if (!copy || !create || !remove || !exactRead || !replace) {
    throw new Error("expected the native AWS S3 conditional primitives");
  }
  return {
    copy,
    create,
    delete: remove,
    exactRead,
    replace,
  };
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

  test("native conditional primitives are exposed only for AWS S3 endpoints", () => {
    const native = s3({ bucket: "b", region: "us-east-1" });
    const conditional = requireNativeConditional(native);
    expect(conditional.copy).toMatchObject({
      atomicSourceDestination: true,
      destinationCreate: true,
      destinationReplace: true,
      sourceEtag: true,
    });

    const compatible = s3({
      bucket: "b",
      endpoint: "https://storage.example.test",
      region: "us-east-1",
    });
    expect(compatible.conditional).toBeUndefined();
    expect(s3Mock.calls()).toHaveLength(0);
  });

  test("an AWS_ENDPOINT_URL* redirect hides the primitives; `conditional` overrides either way", () => {
    const saved = {
      base: process.env.AWS_ENDPOINT_URL,
      s3: process.env.AWS_ENDPOINT_URL_S3,
    };
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_ENDPOINT_URL_S3;
    try {
      // S3Client honors these on its own, so an env-redirected client is an
      // S3-compatible service as far as conditional-header support goes.
      process.env.AWS_ENDPOINT_URL_S3 = "http://localhost:9000";
      expect(
        s3({ bucket: "b", region: "us-east-1" }).conditional
      ).toBeUndefined();
      delete process.env.AWS_ENDPOINT_URL_S3;
      process.env.AWS_ENDPOINT_URL = "http://localhost:4566";
      expect(
        s3({ bucket: "b", region: "us-east-1" }).conditional
      ).toBeUndefined();
      // An explicit opt-in wins over both the env redirect and a custom
      // endpoint (VPC / FIPS / GovCloud hostnames are still AWS).
      expect(
        s3({ bucket: "b", conditional: true, region: "us-east-1" }).conditional
      ).toBeDefined();
      delete process.env.AWS_ENDPOINT_URL;
      expect(
        s3({
          bucket: "b",
          conditional: true,
          endpoint: "https://bucket.vpce-abc.s3.us-east-1.vpce.amazonaws.com",
          region: "us-east-1",
        }).conditional
      ).toBeDefined();
      // And an explicit opt-out disables them on a canonical bucket.
      const optedOut = new Files({
        adapter: s3({ bucket: "b", conditional: false, region: "us-east-1" }),
      });
      expect(optedOut.capabilities.conditional.create).toBe(false);
    } finally {
      if (saved.base === undefined) {
        delete process.env.AWS_ENDPOINT_URL;
      } else {
        process.env.AWS_ENDPOINT_URL = saved.base;
      }
      if (saved.s3 === undefined) {
        delete process.env.AWS_ENDPOINT_URL_S3;
      } else {
        process.env.AWS_ENDPOINT_URL_S3 = saved.s3;
      }
    }
    expect(s3Mock.calls()).toHaveLength(0);
  });

  test("custom endpoints fail every Files conditional operation before provider I/O", async () => {
    const files = new Files({
      adapter: s3({
        bucket: "b",
        endpoint: "https://storage.example.test",
        region: "us-east-1",
      }),
    });

    expect(files.capabilities.conditional).toEqual({
      copy: {
        atomicSourceDestination: false,
        destinationCreate: false,
        destinationReplace: false,
        sourceEtag: false,
      },
      create: false,
      delete: false,
      exactRead: false,
      multipart: { create: false, replace: false },
      replace: false,
    });
    await expect(
      files.upload("created.txt", "body", {
        condition: { type: "create" },
      })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      files.upload("replaced.txt", "body", {
        condition: { etag: "old-etag", type: "replace" },
      })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      files.download("record.txt", { condition: { etag: "exact-etag" } })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      files.delete("record.txt", { condition: { etag: "delete-etag" } })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      files.copy("from.txt", "to.txt", {
        condition: {
          destination: { type: "create" },
          source: { etag: "source-etag" },
        },
      })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  test("Files preserves prefixes and retries AWS conditional request conflicts natively", async () => {
    s3Mock
      .on(PutObjectCommand)
      .rejectsOnce(
        Object.assign(new Error("retry the request"), {
          $metadata: { httpStatusCode: 409 },
          name: "ConditionalRequestConflict",
        })
      )
      .resolvesOnce({ ETag: '"created-etag"' });
    const files = new Files({
      adapter: s3({ bucket: "b", region: "us-east-1" }),
      prefix: "tenant/workspace",
    });

    expect(files.capabilities.conditional).toMatchObject({
      copy: {
        atomicSourceDestination: true,
        destinationCreate: true,
        destinationReplace: true,
        sourceEtag: true,
      },
      create: true,
      delete: true,
      exactRead: true,
      replace: true,
    });
    const result = await files.upload("record.txt", "body", {
      condition: { type: "create" },
      retries: { backoff: () => 0, max: 1 },
    });

    expect(result.etag).toBe("created-etag");
    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const [{ input }] = call.args;
      expect(input.Key).toBe("tenant/workspace/record.txt");
      expect(input.IfNoneMatch).toBe("*");
    }
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  test("conditional create uses one PutObject with If-None-Match and preserves upload options", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"created-etag"' });
    const conditional = requireNativeConditional(
      s3({ bucket: "test-bucket", region: "us-east-1" })
    );
    const { signal } = new AbortController();
    const progress: { loaded: number; total?: number }[] = [];

    const result = await conditional.create("created.txt", "hello", {
      cacheControl: "private, max-age=60",
      contentType: "text/plain",
      metadata: { owner: "alice" },
      onProgress: (event) => progress.push(event),
      signal,
    });

    expect(result).toEqual({
      contentType: "text/plain",
      etag: "created-etag",
      key: "created.txt",
      size: 5,
    });
    expect(progress).toEqual([
      { loaded: 0, total: 5 },
      { loaded: 5, total: 5 },
    ]);
    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const [{ input }, sendOptions] = firstCall(calls).args as [
      PutObjectCommand,
      { abortSignal?: AbortSignal }?,
    ];
    expect(input).toMatchObject({
      Bucket: "test-bucket",
      CacheControl: "private, max-age=60",
      ContentLength: 5,
      ContentType: "text/plain",
      IfNoneMatch: "*",
      Key: "created.txt",
      Metadata: { owner: "alice" },
    });
    expect(input.IfMatch).toBeUndefined();
    expect(sendOptions).toEqual({ abortSignal: signal });
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  test("conditional replace quotes one canonical ETag and returns the new bare ETag", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"new-etag"' });
    const conditional = requireNativeConditional(
      s3({ bucket: "b", region: "us-east-1" })
    );

    const result = await conditional.replace(
      "record.bin",
      new Uint8Array([1, 2, 3]),
      "old\\etag"
    );

    expect(result.etag).toBe("new-etag");
    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const [{ input }] = firstCall(calls).args;
    expect(input.IfMatch).toBe('"old\\etag"');
    expect(input.IfNoneMatch).toBeUndefined();
    expect(input.ContentLength).toBe(3);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  test("exact read combines If-Match, range, signal, and normalized response metadata", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: streamBody("234") as unknown as undefined,
      ContentLength: 3,
      ContentType: "text/plain",
      ETag: '"exact-etag"',
      Metadata: { protected: "true" },
    });
    const conditional = requireNativeConditional(
      s3({ bucket: "b", region: "us-east-1" })
    );
    const { signal } = new AbortController();

    const got = await conditional.exactRead("record.txt", "exact-etag", {
      range: { end: 4, start: 2 },
      signal,
    });

    expect(await got.text()).toBe("234");
    expect(got.etag).toBe("exact-etag");
    expect(got.metadata).toEqual({ protected: "true" });
    const calls = s3Mock.commandCalls(GetObjectCommand);
    expect(calls).toHaveLength(1);
    const [{ input }, sendOptions] = firstCall(calls).args as [
      GetObjectCommand,
      { abortSignal?: AbortSignal }?,
    ];
    expect(input).toMatchObject({
      Bucket: "b",
      IfMatch: '"exact-etag"',
      Key: "record.txt",
      Range: "bytes=2-4",
    });
    expect(sendOptions).toEqual({ abortSignal: signal });
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  test("exact read surfaces its validated predicate when S3 omits the response ETag", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: streamBody("body") as unknown as undefined,
      ContentLength: 4,
    });
    const conditional = requireNativeConditional(
      s3({ bucket: "b", region: "us-east-1" })
    );

    const got = await conditional.exactRead("record.txt", "known-etag");

    expect(got.etag).toBe("known-etag");
  });

  test("exact read preserves stream mode when S3 returns an empty body", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      ContentLength: 0,
      ETag: '"exact-etag"',
    });
    const conditional = requireNativeConditional(
      s3({ bucket: "b", region: "us-east-1" })
    );

    const got = await conditional.exactRead("record.txt", "exact-etag", {
      as: "stream",
    });

    expect(await got.text()).toBe("");
    expect(got.size).toBe(0);
    expect(got.etag).toBe("exact-etag");
  });

  test("exact read fails closed when the response ETag disagrees with its predicate", async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: streamBody("body") as unknown as undefined,
      ContentLength: 4,
      ETag: '"different-etag"',
    });
    const conditional = requireNativeConditional(
      s3({ bucket: "b", region: "us-east-1" })
    );

    await expect(
      conditional.exactRead("record.txt", "expected-etag")
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  test("conditional delete uses one DeleteObject with If-Match and signal", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    const conditional = requireNativeConditional(
      s3({ bucket: "b", region: "us-east-1" })
    );
    const { signal } = new AbortController();

    await conditional.delete("record.txt", "delete-etag", { signal });

    const calls = s3Mock.commandCalls(DeleteObjectCommand);
    expect(calls).toHaveLength(1);
    const [{ input }, sendOptions] = firstCall(calls).args as [
      DeleteObjectCommand,
      { abortSignal?: AbortSignal }?,
    ];
    expect(input).toMatchObject({
      Bucket: "b",
      IfMatch: '"delete-etag"',
      Key: "record.txt",
    });
    expect(sendOptions).toEqual({ abortSignal: signal });
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  test("conditional copy enforces source and destination predicates in the same command", async () => {
    s3Mock.on(CopyObjectCommand).resolves({});
    const conditional = requireNativeConditional(
      s3({ bucket: "test-bucket", region: "us-east-1" })
    );
    const { signal } = new AbortController();

    await conditional.copy.run(
      "source folder/a.txt",
      "created.txt",
      {
        destination: { type: "create" },
        source: { etag: "source-etag" },
      },
      { signal }
    );
    await conditional.copy.run("source.txt", "replaced.txt", {
      destination: { etag: "destination-etag", type: "replace" },
      source: { etag: "source-etag-2" },
    });

    const calls = s3Mock.commandCalls(CopyObjectCommand);
    expect(calls).toHaveLength(2);
    const [createCommand, createSendOptions] = firstCall(calls).args as [
      CopyObjectCommand,
      { abortSignal?: AbortSignal }?,
    ];
    const { input: createInput } = createCommand;
    expect(createInput).toMatchObject({
      Bucket: "test-bucket",
      CopySource: "test-bucket/source%20folder%2Fa.txt",
      CopySourceIfMatch: '"source-etag"',
      IfNoneMatch: "*",
      Key: "created.txt",
    });
    expect(createInput?.IfMatch).toBeUndefined();
    expect(createSendOptions).toEqual({ abortSignal: signal });

    const [replaceCommand] = firstCall(calls.slice(1)).args as [
      CopyObjectCommand,
      { abortSignal?: AbortSignal }?,
    ];
    const { input: replaceInput } = replaceCommand;
    expect(replaceInput).toMatchObject({
      CopySourceIfMatch: '"source-etag-2"',
      IfMatch: '"destination-etag"',
      Key: "replaced.txt",
    });
    expect(replaceInput?.IfNoneMatch).toBeUndefined();
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test("conditional copy maps a provider failure without issuing fallback I/O", async () => {
    s3Mock
      .on(CopyObjectCommand)
      .rejects(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    const conditional = requireNativeConditional(
      s3({ bucket: "test-bucket", region: "us-east-1" })
    );

    await expect(
      conditional.copy.run("source.txt", "destination.txt", {
        destination: { type: "create" },
        source: { etag: "source-etag" },
      })
    ).rejects.toMatchObject({ code: "Unauthorized" });

    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test("conditional uploads reject multipart, resumable control, and unsized streams before provider I/O", async () => {
    const conditional = requireNativeConditional(
      s3({ bucket: "b", region: "us-east-1" })
    );
    const multipart = {
      multipart: true,
    } as unknown as AdapterUploadOptions;
    const controlled = {
      control: new UploadControl(),
    } as unknown as AdapterUploadOptions;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });

    await expect(
      conditional.create("multipart.bin", "body", multipart)
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      conditional.create("controlled.bin", "body", controlled)
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      conditional.create("stream.bin", stream)
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    expect(s3Mock.calls()).toHaveLength(0);
    expect(FakeUpload.instances).toBe(0);
  });

  test("conditional operations reject non-canonical ETags before provider I/O", async () => {
    const conditional = requireNativeConditional(
      s3({ bucket: "b", region: "us-east-1" })
    );

    await expect(
      conditional.replace("record.txt", "body", '"already-quoted"')
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      conditional.exactRead("record.txt", "W/weak-etag")
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      conditional.delete("record.txt", "first,second")
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      conditional.copy.run("from", "to", {
        destination: { type: "create" },
        source: { etag: "*" },
      })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  test("conditional create and replace fail permanently when S3 omits the committed ETag", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const conditional = requireNativeConditional(
      s3({ bucket: "b", region: "us-east-1" })
    );

    await expect(
      conditional.create("created.txt", "body")
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      conditional.replace("replaced.txt", "body", "old-etag")
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(2);
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  test("conditional output ETags are validated and progress observers cannot retry a committed write", async () => {
    s3Mock
      .on(PutObjectCommand)
      .resolvesOnce({ ETag: '"bad,etag"' })
      .resolvesOnce({ ETag: '"good-etag"' });
    const conditional = requireNativeConditional(
      s3({ bucket: "b", region: "us-east-1" })
    );

    await expect(
      conditional.create("invalid.txt", "body")
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      conditional.create("observed.txt", "body", {
        onProgress() {
          throw new Error("observer failed");
        },
      })
    ).resolves.toMatchObject({ etag: "good-etag" });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(2);
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

  test("list infers the content type from the key", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { ETag: '"1"', Key: "a/report.csv", LastModified: new Date(), Size: 1 },
        { ETag: '"2"', Key: "a/photo.png", LastModified: new Date(), Size: 2 },
        { ETag: '"3"', Key: "a/blob", LastModified: new Date(), Size: 3 },
      ],
      IsTruncated: false,
    });
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    const out = await files.list({ prefix: "a/" });
    expect(out.items.map((i) => i.type)).toEqual([
      "text/csv; charset=utf-8",
      "image/png",
      // No extension to go on, so the generic fallback still applies
      "application/octet-stream",
    ]);
  });

  test("list passes Delimiter and maps CommonPrefixes to prefixes", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: "a/b/" }, { Prefix: "a/c/" }, {}],
      Contents: [
        { ETag: '"1"', Key: "a/1.txt", LastModified: new Date(), Size: 1 },
      ],
      IsTruncated: false,
    });
    const files = new Files({
      adapter: s3({ bucket: "test-bucket", region: "us-east-1" }),
    });
    const out = await files.list({ delimiter: "/", prefix: "a/" });
    expect(out.items.map((i) => i.key)).toEqual(["a/1.txt"]);
    expect(out.prefixes).toEqual(["a/b/", "a/c/"]);
    const calls = s3Mock.commandCalls(ListObjectsV2Command);
    const [{ input }] = firstCall(calls).args;
    expect(input.Delimiter).toBe("/");
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
      // eslint-disable-next-line no-await-in-loop -- sequentially draining a stream reader
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

  test("ConditionalRequestConflict maps to a retryable Provider error", () => {
    const providerError = Object.assign(new Error("retry the request"), {
      $metadata: { httpStatusCode: 409 },
      name: "ConditionalRequestConflict",
    });

    const error = mapS3Error(providerError);

    expect(error.code).toBe("Provider");
    expect(error.permanent).toBe(false);
    expect(error.cause).toBe(providerError);
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

  test("a signal already aborted before Upload is built aborts instead of uploading", async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = s3({ bucket: "b", region: "us-east-1" });
    // The signal can flip during the awaits that precede the Upload (body
    // normalization, the lazy lib-storage import); an "abort" listener never
    // fires for an already-aborted signal, so the upload used to proceed.
    await expect(
      adapter.upload("big.bin", "hello", {
        multipart: true,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ aborted: true });
    expect(FakeUpload.instances).toBe(1);
    expect(FakeUpload.aborted).toBe(1);
    expect(FakeUpload.completed).toBe(0);
  });
});

const rbAdapter = () => s3({ bucket: "rb", region: "us-east-1" });

describe("s3 resumable uploads", () => {
  const FIVE_MIB = 5 * 1024 * 1024;
  const adapter = rbAdapter;

  const mockSession = () => {
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "u1" });
    s3Mock.on(UploadPartCommand).resolves({ ETag: '"p"' });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"final"' });
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: FIVE_MIB + 10,
      ContentType: "application/octet-stream",
      LastModified: new Date(0),
    });
  };

  test("fresh multipart upload creates, uploads parts, and completes", async () => {
    mockSession();
    const files = new Files({ adapter: adapter() });
    const control = new UploadControl();
    const result = await files.upload(
      "big.bin",
      new Uint8Array(FIVE_MIB + 10),
      {
        control,
        multipart: { partSize: FIVE_MIB },
      }
    );
    expect(result.size).toBe(FIVE_MIB + 10);
    expect(result.etag).toBe("final");
    expect(control.status).toBe("completed");
    expect(s3Mock.commandCalls(CreateMultipartUploadCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(UploadPartCommand)).toHaveLength(2);
    const [complete] = s3Mock.commandCalls(CompleteMultipartUploadCommand);
    const completeInput = complete?.args[0]?.input as {
      MultipartUpload?: { Parts?: unknown[] };
    };
    expect(completeInput.MultipartUpload?.Parts).toHaveLength(2);
    expect(control.session?.provider).toBe("s3");
  });

  test("resume skips already-uploaded parts via ListParts", async () => {
    s3Mock.on(ListPartsCommand).resolves({
      IsTruncated: false,
      Parts: [{ ETag: '"p1"', PartNumber: 1, Size: FIVE_MIB }],
    });
    s3Mock.on(UploadPartCommand).resolves({ ETag: '"p2"' });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"final"' });
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: FIVE_MIB + 10 });
    const files = new Files({ adapter: adapter() });
    const token: ResumableUploadSession = {
      bucket: "rb",
      key: "big.bin",
      partSize: FIVE_MIB,
      provider: "s3",
      uploadId: "u1",
    };
    const result = await files.upload(
      "big.bin",
      new Uint8Array(FIVE_MIB + 10),
      { control: UploadControl.from(token), multipart: { partSize: FIVE_MIB } }
    );
    expect(result.size).toBe(FIVE_MIB + 10);
    expect(s3Mock.commandCalls(CreateMultipartUploadCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(UploadPartCommand)).toHaveLength(1);
  });

  test("ListParts pagination is followed across pages", async () => {
    s3Mock
      .on(ListPartsCommand)
      .resolvesOnce({
        IsTruncated: true,
        NextPartNumberMarker: "1",
        Parts: [{ ETag: '"p1"', PartNumber: 1, Size: FIVE_MIB }],
      })
      .resolves({
        IsTruncated: false,
        Parts: [{ ETag: '"p2"', PartNumber: 2, Size: 10 }],
      });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({ ETag: '"final"' });
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: FIVE_MIB + 10 });
    const files = new Files({ adapter: adapter() });
    const token: ResumableUploadSession = {
      bucket: "rb",
      key: "big.bin",
      partSize: FIVE_MIB,
      provider: "s3",
      uploadId: "u1",
    };
    // Both parts already present → no new UploadPart calls.
    const result = await files.upload(
      "big.bin",
      new Uint8Array(FIVE_MIB + 10),
      { control: UploadControl.from(token), multipart: { partSize: FIVE_MIB } }
    );
    expect(result.size).toBe(FIVE_MIB + 10);
    expect(s3Mock.commandCalls(UploadPartCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(ListPartsCommand)).toHaveLength(2);
  });

  test("abort discards the multipart upload", async () => {
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "u1" });
    s3Mock.on(UploadPartCommand).resolves({ ETag: '"p"' });
    s3Mock.on(AbortMultipartUploadCommand).resolves({});
    const files = new Files({ adapter: adapter() });
    const control = new UploadControl();
    let aborting: Promise<void> | undefined;
    const promise = files.upload("big.bin", new Uint8Array(FIVE_MIB + 10), {
      control,
      multipart: { concurrency: 1, partSize: FIVE_MIB },
      onProgress: ({ loaded }) => {
        if (loaded >= FIVE_MIB && !aborting) {
          aborting = control.abort();
        }
      },
    });
    await expect(promise).rejects.toMatchObject({ aborted: true });
    await aborting;
    expect(s3Mock.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1);
    expect(control.status).toBe("aborted");
  });

  test("a missing UploadId from CreateMultipartUpload throws", async () => {
    s3Mock.on(CreateMultipartUploadCommand).resolves({});
    const files = new Files({ adapter: adapter() });
    await expect(
      files.upload("big.bin", "data", { control: new UploadControl() })
    ).rejects.toThrow(/UploadId/u);
  });

  test("a CreateMultipartUpload failure is wrapped", async () => {
    s3Mock.on(CreateMultipartUploadCommand).rejects(new Error("boom"));
    const files = new Files({ adapter: adapter() });
    await expect(
      files.upload("big.bin", "data", { control: new UploadControl() })
    ).rejects.toBeInstanceOf(FilesError);
  });

  test("an UploadPart failure rejects when retries are exhausted", async () => {
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "u1" });
    s3Mock.on(UploadPartCommand).rejects(new Error("part boom"));
    const files = new Files({ adapter: adapter() });
    await expect(
      files.upload("big.bin", "data", {
        control: new UploadControl(),
        retries: 0,
      })
    ).rejects.toBeInstanceOf(FilesError);
  });

  test("a CompleteMultipartUpload failure is wrapped", async () => {
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "u1" });
    s3Mock.on(UploadPartCommand).resolves({ ETag: '"p"' });
    s3Mock
      .on(CompleteMultipartUploadCommand)
      .rejects(new Error("complete boom"));
    const files = new Files({ adapter: adapter() });
    await expect(
      files.upload("big.bin", "data", { control: new UploadControl() })
    ).rejects.toBeInstanceOf(FilesError);
  });

  test("resuming a token from another provider throws", async () => {
    const files = new Files({ adapter: adapter() });
    const token = {
      bucket: "rb",
      key: "big.bin",
      provider: "gcs",
      uri: "x",
    } as ResumableUploadSession;
    await expect(
      files.upload("big.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/Cannot resume a gcs/u);
  });

  test("resuming a token for a different key throws", async () => {
    const files = new Files({ adapter: adapter() });
    const token: ResumableUploadSession = {
      bucket: "rb",
      key: "other.bin",
      partSize: FIVE_MIB,
      provider: "s3",
      uploadId: "u1",
    };
    await expect(
      files.upload("big.bin", "data", { control: UploadControl.from(token) })
    ).rejects.toThrow(/does not match/u);
  });
});
