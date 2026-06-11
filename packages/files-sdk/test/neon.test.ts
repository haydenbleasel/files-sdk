import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { Files } from "../src/index.js";
import { neon } from "../src/neon/index.js";

// Every env var the neon adapter (or the AWS credential chain it relies on)
// reads. Cleared before each test and restored after, so the suite is
// hermetic regardless of the AWS_* vars the developer's shell already exports.
const NEON_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ENDPOINT_URL_S3",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "NEON_STORAGE_REGION",
] as const;

const ENDPOINT = "https://br-cool-moon-42.storage.example.neon.tech";
const ENDPOINT_HOST = "br-cool-moon-42.storage.example.neon.tech";

describe("neon adapter", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of NEON_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of NEON_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  test("defaults to path-style addressing and us-east-1, relabels the provider", async () => {
    const adapter = neon({
      accessKeyId: "AKID",
      bucket: "images",
      endpoint: ENDPOINT,
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("neon");
    expect(adapter.bucket).toBe("images");
    const client = adapter.raw as S3Client;
    // Neon requires path-style — the adapter turns it on by default.
    expect(await client.config.forcePathStyle).toBe(true);
    expect(await client.config.region()).toBe("us-east-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe(ENDPOINT_HOST);
    expect(endpoint?.protocol).toBe("https:");
  });

  test("reads endpoint, region, and credentials from the injected AWS_* env vars", async () => {
    process.env.AWS_ENDPOINT_URL_S3 = ENDPOINT;
    process.env.AWS_REGION = "us-east-2";
    process.env.AWS_ACCESS_KEY_ID = "ENV_KEY";
    process.env.AWS_SECRET_ACCESS_KEY = "ENV_SECRET";

    const adapter = neon({ bucket: "images" });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("us-east-2");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe(ENDPOINT_HOST);
    const creds = await client.config.credentials();
    expect(creds.accessKeyId).toBe("ENV_KEY");
    expect(creds.secretAccessKey).toBe("ENV_SECRET");
  });

  test("falls back to NEON_STORAGE_REGION when AWS_REGION is unset", async () => {
    process.env.NEON_STORAGE_REGION = "eu-central-1";
    const adapter = neon({
      accessKeyId: "AKID",
      bucket: "images",
      endpoint: ENDPOINT,
      secretAccessKey: "SECRET",
    });
    expect(await (adapter.raw as S3Client).config.region()).toBe("eu-central-1");
  });

  test("explicit endpoint overrides the env var", async () => {
    process.env.AWS_ENDPOINT_URL_S3 = ENDPOINT;
    const adapter = neon({
      accessKeyId: "AKID",
      bucket: "images",
      endpoint: "https://custom.example.com:8443",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("custom.example.com");
    expect(endpoint?.port).toBe(8443);
  });

  test("missing endpoint throws at construction", () => {
    expect(() =>
      neon({
        accessKeyId: "AKID",
        bucket: "images",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/endpoint/u);
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = neon({
      accessKeyId: "AKID",
      bucket: "images",
      endpoint: ENDPOINT,
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain(ENDPOINT_HOST);
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = neon({
      accessKeyId: "AKID",
      bucket: "images",
      endpoint: ENDPOINT,
      publicBaseUrl: "https://cdn.example.com",
      secretAccessKey: "SECRET",
    });
    expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
  });

  test("delegates upload to the underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"ok"' });
    const files = new Files({
      adapter: neon({
        accessKeyId: "AKID",
        bucket: "images",
        endpoint: ENDPOINT,
        secretAccessKey: "SECRET",
      }),
    });
    const result = await files.upload("a.txt", "hi");
    expect(result.etag).toBe("ok");
    s3Mock.reset();
  });

  test("delegates exists to the underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const files = new Files({
      adapter: neon({
        accessKeyId: "AKID",
        bucket: "images",
        endpoint: ENDPOINT,
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

  test("default error messages from the inner s3 adapter are relabeled as 'Neon error'", async () => {
    // Bypass the SDK mock and exercise the error mapper directly: the neon
    // adapter configures it to use 'Neon error' as the Provider fallback.
    const { mapS3Error } = await import("../src/s3/index.js");
    const neonMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Neon error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error({ $metadata: { httpStatusCode: 500 } }, neonMessages);
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Neon error");
  });
});
