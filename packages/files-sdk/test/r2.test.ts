import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { Files, FilesError } from "../src/index.js";
import { r2 } from "../src/r2/index.js";

describe("r2 adapter — HTTP path", () => {
  test("uses S3-compatible endpoint with auto region and path-style", async () => {
    const adapter = r2({
      accessKeyId: "AKID",
      accountId: "ACCT",
      bucket: "uploads",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("r2-http");
    // The s3 adapter is loaded lazily, so `raw` is undefined until any
    // method has run. `head()` here forces the import (and is mocked away
    // by the global s3Mock — the rejection doesn't matter; we just want
    // the inner adapter to materialize so `raw` becomes accessible).
    await adapter.head("touch").catch(() => {});
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("auto");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("acct.r2.cloudflarestorage.com");
  });

  test("missing credentials throws at construction even with accountId set", () => {
    const oldKey = process.env.R2_ACCESS_KEY_ID;
    const oldSecret = process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    try {
      expect(() => r2({ accountId: "ACCT", bucket: "uploads" })).toThrow(
        /credentials/u
      );
    } finally {
      if (oldKey) {
        process.env.R2_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.R2_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("missing accountId throws at construction", () => {
    const oldId = process.env.R2_ACCOUNT_ID;
    const oldKey = process.env.R2_ACCESS_KEY_ID;
    const oldSecret = process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    try {
      expect(() => r2({ bucket: "uploads" })).toThrow(/accountId/u);
    } finally {
      if (oldId) {
        process.env.R2_ACCOUNT_ID = oldId;
      }
      if (oldKey) {
        process.env.R2_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.R2_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const files = new Files({
      adapter: r2({
        accessKeyId: "K",
        accountId: "ACCT",
        bucket: "uploads",
        secretAccessKey: "S",
      }),
    });
    const url = await files.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
  });

  test("url() returns the publicBaseUrl when configured (skips signing)", async () => {
    const files = new Files({
      adapter: r2({
        accessKeyId: "K",
        accountId: "ACCT",
        bucket: "uploads",
        publicBaseUrl: "https://pub.r2.dev",
        secretAccessKey: "S",
      }),
    });
    expect(await files.url("a.txt")).toBe("https://pub.r2.dev/a.txt");
  });

  test("delegates upload to underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"ok"' });
    const files = new Files({
      adapter: r2({
        accessKeyId: "K",
        accountId: "ACCT",
        bucket: "uploads",
        secretAccessKey: "S",
      }),
    });
    const result = await files.upload("a.txt", "hi");
    expect(result.etag).toBe("ok");
    s3Mock.reset();
  });

  test("default error messages from the inner s3 adapter are relabeled as 'R2 error'", async () => {
    // Bypass the SDK mock and exercise the error mapper directly: it's
    // configured by the r2-http adapter to use 'R2 error' as the Provider
    // fallback. mapS3Error reads the message off whatever object is thrown,
    // so a no-message object hits the configured default.
    const { mapS3Error } = await import("../src/s3/index.js");
    const r2Messages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "R2 error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error({ $metadata: { httpStatusCode: 500 } }, r2Messages);
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("R2 error");
  });
});

const fakeBinding = () => {
  const map = new Map<
    string,
    {
      bytes: Uint8Array;
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      etag: string;
      uploaded: Date;
      size: number;
    }
  >();
  let counter = 0;
  const bucket = {
    delete(key: string) {
      map.delete(key);
      return Promise.resolve();
    },
    get(key: string) {
      const entry = map.get(key);
      if (!entry) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        arrayBuffer: () =>
          Promise.resolve(
            entry.bytes.buffer.slice(
              entry.bytes.byteOffset,
              entry.bytes.byteOffset + entry.bytes.byteLength
            )
          ),
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(entry.bytes);
            c.close();
          },
        }),
        customMetadata: entry.customMetadata,
        etag: entry.etag,
        httpMetadata: entry.httpMetadata,
        key,
        size: entry.size,
        text: () => Promise.resolve(new TextDecoder().decode(entry.bytes)),
        uploaded: entry.uploaded,
      });
    },
    head(key: string) {
      const entry = map.get(key);
      if (!entry) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        customMetadata: entry.customMetadata,
        etag: entry.etag,
        httpMetadata: entry.httpMetadata,
        key,
        size: entry.size,
        uploaded: entry.uploaded,
      });
    },
    list(opts?: { prefix?: string; limit?: number; cursor?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({
          customMetadata: v.customMetadata,
          etag: v.etag,
          httpMetadata: v.httpMetadata,
          key: k,
          size: v.size,
          uploaded: v.uploaded,
        }));
      return Promise.resolve({ cursor: undefined, objects, truncated: false });
    },
    async put(
      key: string,
      body: ArrayBuffer | string | ReadableStream<Uint8Array>,
      opts?: {
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
      }
    ) {
      let bytes: Uint8Array;
      if (typeof body === "string") {
        bytes = new TextEncoder().encode(body);
      } else if (body instanceof ReadableStream) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            chunks.push(value);
            total += value.byteLength;
          }
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.byteLength;
        }
      } else {
        bytes = new Uint8Array(body);
      }
      counter += 1;
      const entry = {
        bytes,
        customMetadata: opts?.customMetadata,
        etag: `etag-${counter}`,
        httpMetadata: opts?.httpMetadata,
        size: bytes.byteLength,
        uploaded: new Date(),
      };
      map.set(key, entry);
      return {
        customMetadata: entry.customMetadata,
        etag: entry.etag,
        httpMetadata: entry.httpMetadata,
        key,
        size: entry.size,
        uploaded: entry.uploaded,
      };
    },
  };
  return { bucket, map };
};

describe("r2 adapter — Workers binding path", () => {
  test("upload + download via binding", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({
      adapter: r2({
        binding: bucket as unknown as Parameters<typeof r2>[0] extends {
          binding: infer B;
        }
          ? B
          : never,
      }),
    });
    await files.upload("a.txt", "hello", { contentType: "text/plain" });
    const got = await files.download("a.txt");
    expect(await got.text()).toBe("hello");
    expect(got.type).toBe("text/plain");
  });

  test("delete + head returning NotFound", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    await files.upload("a.txt", "x");
    await files.delete("a.txt");
    try {
      await files.head("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("copy round-trips body since binding has no native copy", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    await files.upload("from.txt", "payload", { contentType: "text/plain" });
    await files.copy("from.txt", "to.txt");
    const got = await files.download("to.txt");
    expect(await got.text()).toBe("payload");
    expect(got.type).toBe("text/plain");
  });

  test("url() with responseContentDisposition on a plain binding throws Provider", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    await files.upload("a.txt", "x");
    try {
      await files.url("a.txt", { responseContentDisposition: "attachment" });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toMatch(/HTTP credentials/u);
    }
  });

  test("signedUploadUrl from a plain binding throws Provider", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    try {
      await files.signedUploadUrl("a.txt", { expiresIn: 60 });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Provider");
    }
  });

  test("url() from a plain binding (no publicBaseUrl, no HTTP creds) throws Provider", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    try {
      await files.url("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toMatch(
        /publicBaseUrl|HTTP credentials/u
      );
    }
  });

  test("url() from a binding with publicBaseUrl returns the configured URL", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({
      adapter: r2({
        binding: bucket as never,
        publicBaseUrl: "https://pub.r2.dev",
      }),
    });
    expect(await files.url("a.txt")).toBe("https://pub.r2.dev/a.txt");
  });

  test("hybrid: binding + HTTP creds enables signed url() while reads still go through the binding", async () => {
    const { bucket, map } = fakeBinding();
    const files = new Files({
      adapter: r2({
        accessKeyId: "K",
        accountId: "ACCT",
        binding: bucket as never,
        bucket: "uploads",
        secretAccessKey: "S",
      }),
    });
    await files.upload("a.txt", "via-binding", { contentType: "text/plain" });
    // Read goes through the binding (no AWS SDK call would succeed here
    // since the test runner has no real R2 endpoint anyway).
    expect(map.has("a.txt")).toBe(true);
    const got = await files.download("a.txt");
    expect(await got.text()).toBe("via-binding");
    // url() falls back to the lazy-loaded HTTP signer.
    const url = await files.url("a.txt", { expiresIn: 60 });
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
  });

  test("hybrid: responseContentDisposition forces signing through publicBaseUrl", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({
      adapter: r2({
        accessKeyId: "K",
        accountId: "ACCT",
        binding: bucket as never,
        bucket: "uploads",
        publicBaseUrl: "https://pub.r2.dev",
        secretAccessKey: "S",
      }),
    });
    // Without disposition: publicBaseUrl wins.
    expect(await files.url("a.txt")).toBe("https://pub.r2.dev/a.txt");
    // With disposition: signing wins.
    const signed = await files.url("a.txt", {
      responseContentDisposition: "attachment",
    });
    expect(signed).toContain("X-Amz-Signature=");
    expect(signed).toContain("response-content-disposition=attachment");
  });

  test("hybrid: signedUploadUrl works with binding + HTTP creds", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({
      adapter: r2({
        accessKeyId: "K",
        accountId: "ACCT",
        binding: bucket as never,
        bucket: "uploads",
        secretAccessKey: "S",
      }),
    });
    const out = await files.signedUploadUrl("a.txt", {
      contentType: "text/plain",
      expiresIn: 60,
    });
    expect(out.method).toBe("PUT");
    if (out.method === "PUT") {
      expect(out.url).toContain("X-Amz-Signature=");
    }
  });

  test("hybrid: url() falls back to HTTP signing when no publicBaseUrl is set", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({
      adapter: r2({
        accessKeyId: "K",
        accountId: "ACCT",
        binding: bucket as never,
        bucket: "uploads",
        secretAccessKey: "S",
      }),
    });
    const url = await files.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=3600");
  });

  test("hybrid: publicBaseUrl wins over HTTP signing fallback", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({
      adapter: r2({
        accessKeyId: "K",
        accountId: "ACCT",
        binding: bucket as never,
        bucket: "uploads",
        publicBaseUrl: "https://pub.r2.dev",
        secretAccessKey: "S",
      }),
    });
    expect(await files.url("a.txt")).toBe("https://pub.r2.dev/a.txt");
  });

  test("upload via binding accepts Uint8Array, ArrayBuffer, Blob, ReadableStream", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    await files.upload("u8.bin", new Uint8Array([1, 2, 3]));
    await files.upload("ab.bin", new Uint8Array([1, 2, 3, 4]).buffer);
    await files.upload(
      "blob.bin",
      new Blob([new Uint8Array([1, 2])], { type: "image/png" })
    );
    await files.upload(
      "stream.bin",
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
          c.close();
        },
      })
    );
    const list = await files.list();
    const keys = list.items.map((i) => i.key).toSorted();
    expect(keys).toEqual(["ab.bin", "blob.bin", "stream.bin", "u8.bin"]);
  });

  test("upload with ArrayBufferView body normalizes correctly", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    const view = new DataView(new Uint8Array([1, 2, 3, 4]).buffer);
    const result = await files.upload("v.bin", view);
    expect(result.size).toBe(4);
  });

  test("binding list filters by prefix and maps StoredFiles", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    await files.upload("a/1.txt", "1", { contentType: "text/plain" });
    await files.upload("a/2.txt", "2", { contentType: "text/plain" });
    await files.upload("b/3.txt", "3", { contentType: "text/plain" });
    const out = await files.list({ prefix: "a/" });
    expect(out.items.map((i) => i.key).toSorted()).toEqual([
      "a/1.txt",
      "a/2.txt",
    ]);
  });

  test("binding copy throws NotFound when source is missing", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    try {
      await files.copy("missing.txt", "dest.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("binding download as stream returns a streaming StoredFile", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    await files.upload("a.txt", "stream-me", { contentType: "text/plain" });
    const got = await files.download("a.txt", { as: "stream" });
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
    expect(total).toBe("stream-me".length);
  });

  test("binding upload error is mapped to Provider via mapR2Error", async () => {
    const { bucket } = fakeBinding();
    bucket.put = (() => Promise.reject(new Error("put failed"))) as never;
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    try {
      await files.upload("a.txt", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toBe("put failed");
    }
  });

  test("binding head exposes a lazy body that fetches via get()", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    await files.upload("h.txt", "lazy-body", { contentType: "text/plain" });
    const info = await files.head("h.txt");
    expect(await info.text()).toBe("lazy-body");
  });

  test("binding list items expose lazy bodies that fetch via get()", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    await files.upload("x/1.txt", "first", { contentType: "text/plain" });
    const out = await files.list({ prefix: "x/" });
    const [item] = out.items;
    if (!item) {
      throw new Error("expected at least one item");
    }
    expect(await item.text()).toBe("first");
  });

  test("binding upload error: existing FilesError passes through unchanged", async () => {
    const { bucket } = fakeBinding();
    const original = new FilesError("Conflict", "already exists");
    bucket.put = (() => Promise.reject(original)) as never;
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    try {
      await files.upload("a.txt", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBe(original);
    }
  });

  test("binding head's lazy body returns empty bytes when get races and returns null", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    await files.upload("a.txt", "data", { contentType: "text/plain" });
    // Simulate a concurrent delete: head succeeds, but the follow-up get returns null.
    bucket.get = (() => Promise.resolve(null)) as never;
    const info = await files.head("a.txt");
    expect(await info.text()).toBe("");
  });

  test("binding list item's lazy body returns empty bytes when get races and returns null", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    await files.upload("a.txt", "data", { contentType: "text/plain" });
    const out = await files.list();
    const [item] = out.items;
    if (!item) {
      throw new Error("expected at least one item");
    }
    bucket.get = (() => Promise.resolve(null)) as never;
    expect(await item.text()).toBe("");
  });

  test("binding download throws NotFound when key is missing", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    try {
      await files.download("missing.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("mapR2Error classifies R2 binding error codes", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    bucket.delete = (() =>
      Promise.reject(
        Object.assign(new Error("auth bad"), {
          code: 10_004,
          name: "R2Error",
        })
      )) as never;
    try {
      await files.delete("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Unauthorized");
    }
  });

  test("mapR2Error: precondition code 10007 maps to Conflict", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    bucket.put = (() =>
      Promise.reject(
        Object.assign(new Error("precondition failed"), {
          code: 10_007,
          name: "R2Error",
        })
      )) as never;
    try {
      await files.upload("a.txt", "x");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Conflict");
    }
  });

  test("mapR2Error: name NotFound maps to NotFound (e.g. propagated by put)", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    bucket.list = (() =>
      Promise.reject(
        Object.assign(new Error("missing"), { name: "R2NotFoundError" })
      )) as never;
    try {
      await files.list();
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("binding download wraps non-null get() errors via mapR2Error", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    bucket.get = (() =>
      Promise.reject(
        Object.assign(new Error("internal"), { code: 10_000, name: "R2Error" })
      )) as never;
    try {
      await files.download("a.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Provider");
      expect((error as FilesError).message).toBe("internal");
    }
  });

  test("binding copy wraps get() errors via mapR2Error", async () => {
    const { bucket } = fakeBinding();
    const files = new Files({ adapter: r2({ binding: bucket as never }) });
    bucket.get = (() =>
      Promise.reject(
        Object.assign(new Error("forbidden"), {
          code: 10_004,
          name: "Forbidden",
        })
      )) as never;
    try {
      await files.copy("a.txt", "b.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as FilesError).code).toBe("Unauthorized");
      expect((error as FilesError).message).toBe("forbidden");
    }
  });
});
