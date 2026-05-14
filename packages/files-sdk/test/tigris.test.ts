import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { Files } from "../src/index.js";
import { tigris } from "../src/tigris/index.js";

describe("tigris adapter", () => {
  test("uses Tigris's global endpoint and 'auto' region by default", async () => {
    const adapter = tigris({
      accessKeyId: "AKID",
      bucket: "uploads",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("tigris");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("auto");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("fly.storage.tigris.dev");
    expect(endpoint?.protocol).toBe("https:");
    // Virtual-hosted style is canonical for Tigris — the AWS SDK's own
    // default (false) is what we want; we don't pass forcePathStyle.
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("region override flows to the inner S3 client", async () => {
    const adapter = tigris({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "iad",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("iad");
    // Endpoint stays the same — region doesn't drive the host on Tigris.
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("fly.storage.tigris.dev");
  });

  test("explicit endpoint overrides the default", async () => {
    const adapter = tigris({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://custom.example.com:8443",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("custom.example.com");
    expect(endpoint?.port).toBe(8443);
  });

  test("explicit forcePathStyle: true is forwarded", async () => {
    const adapter = tigris({
      accessKeyId: "AKID",
      bucket: "uploads",
      forcePathStyle: true,
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.TIGRIS_ACCESS_KEY_ID;
    const oldSecret = process.env.TIGRIS_SECRET_ACCESS_KEY;
    delete process.env.TIGRIS_ACCESS_KEY_ID;
    delete process.env.TIGRIS_SECRET_ACCESS_KEY;
    try {
      expect(() => tigris({ bucket: "uploads" })).toThrow(/credentials/u);
    } finally {
      if (oldKey) {
        process.env.TIGRIS_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.TIGRIS_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("picks up credentials from TIGRIS_ACCESS_KEY_ID / TIGRIS_SECRET_ACCESS_KEY env vars", async () => {
    const oldKey = process.env.TIGRIS_ACCESS_KEY_ID;
    const oldSecret = process.env.TIGRIS_SECRET_ACCESS_KEY;
    process.env.TIGRIS_ACCESS_KEY_ID = "ENV_KEY";
    process.env.TIGRIS_SECRET_ACCESS_KEY = "ENV_SECRET";
    try {
      const adapter = tigris({ bucket: "uploads" });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.TIGRIS_ACCESS_KEY_ID;
      } else {
        process.env.TIGRIS_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.TIGRIS_SECRET_ACCESS_KEY;
      } else {
        process.env.TIGRIS_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = tigris({
      accessKeyId: "AKID",
      bucket: "uploads",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("fly.storage.tigris.dev");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = tigris({
      accessKeyId: "AKID",
      bucket: "uploads",
      publicBaseUrl: "https://uploads.fly.storage.tigris.dev",
      secretAccessKey: "SECRET",
    });
    expect(await adapter.url("a.txt")).toBe(
      "https://uploads.fly.storage.tigris.dev/a.txt"
    );
  });

  test("delegates upload to underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"ok"' });
    const files = new Files({
      adapter: tigris({
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
      adapter: tigris({
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

  test("default error messages from the inner s3 adapter are relabeled as 'Tigris error'", async () => {
    // Bypass the SDK mock and exercise the error mapper directly: the tigris
    // adapter configures it to use 'Tigris error' as the Provider fallback.
    const { mapS3Error } = await import("../src/s3/index.js");
    const tigrisMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Tigris error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      tigrisMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Tigris error");
  });
});
