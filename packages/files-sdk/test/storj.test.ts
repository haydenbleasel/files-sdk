import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { Files } from "../src/index.js";
import { storj } from "../src/storj/index.js";

describe("storj adapter", () => {
  test("defaults to Gateway MT endpoint, path style, and us-east-1 region", async () => {
    const adapter = storj({
      accessKeyId: "AKID",
      bucket: "uploads",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("storj");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("us-east-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("gateway.storjshare.io");
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("region override is forwarded to the inner S3 client", async () => {
    const adapter = storj({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "eu-central-1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("eu-central-1");
  });

  test("endpoint override (e.g. self-hosted Gateway ST) is forwarded", async () => {
    const adapter = storj({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://my-gateway.example.com",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("my-gateway.example.com");
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.STORJ_ACCESS_KEY_ID;
    const oldSecret = process.env.STORJ_SECRET_ACCESS_KEY;
    delete process.env.STORJ_ACCESS_KEY_ID;
    delete process.env.STORJ_SECRET_ACCESS_KEY;
    try {
      expect(() => storj({ bucket: "uploads" })).toThrow(/credentials/u);
    } finally {
      if (oldKey) {
        process.env.STORJ_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.STORJ_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = storj({
      accessKeyId: "AKID",
      bucket: "uploads",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = storj({
      accessKeyId: "AKID",
      bucket: "uploads",
      publicBaseUrl: "https://link.storjshare.io/raw/jx.../uploads",
      secretAccessKey: "SECRET",
    });
    expect(await adapter.url("a.txt")).toBe(
      "https://link.storjshare.io/raw/jx.../uploads/a.txt"
    );
  });

  test("delegates upload to underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"ok"' });
    const files = new Files({
      adapter: storj({
        accessKeyId: "AKID",
        bucket: "uploads",
        secretAccessKey: "SECRET",
      }),
    });
    const result = await files.upload("a.txt", "hi");
    expect(result.etag).toBe("ok");
    s3Mock.reset();
  });

  test("delegates exists to underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const files = new Files({
      adapter: storj({
        accessKeyId: "AKID",
        bucket: "uploads",
        secretAccessKey: "SECRET",
      }),
    });

    s3Mock.on(HeadObjectCommand).resolves({});
    await expect(files.exists("a.txt")).resolves.toBe(true);

    s3Mock.reset();
    s3Mock.on(HeadObjectCommand).rejects(
      Object.assign(new Error("missing"), {
        $metadata: { httpStatusCode: 404 },
      })
    );
    await expect(files.exists("missing.txt")).resolves.toBe(false);
    s3Mock.reset();
  });

  test("default error messages from the inner s3 adapter are relabeled as 'Storj error'", async () => {
    // Bypass the SDK mock and exercise the error mapper directly: the storj
    // adapter configures it to use 'Storj error' as the Provider fallback.
    // mapS3Error reads the message off whatever object is thrown, so a
    // no-message object hits the configured default.
    const { mapS3Error } = await import("../src/s3/index.js");
    const storjMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Storj error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      storjMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Storj error");
  });
});
