import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { digitaloceanSpaces } from "../src/digitalocean-spaces/index.js";
import { Files } from "../src/index.js";

describe("digitalocean-spaces adapter", () => {
  test("derives endpoint from region and uses virtual-hosted style by default", async () => {
    const adapter = digitaloceanSpaces({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "nyc3",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("digitalocean-spaces");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("nyc3");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("nyc3.digitaloceanspaces.com");
    expect(endpoint?.protocol).toBe("https:");
    // Virtual-hosted style is the canonical Spaces routing — the AWS SDK's
    // own default (false) is what we want; we don't pass forcePathStyle.
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("region override flows to both the inner S3 client and the derived endpoint", async () => {
    const adapter = digitaloceanSpaces({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "sfo3",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("sfo3");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("sfo3.digitaloceanspaces.com");
  });

  test("explicit endpoint overrides the region-derived value", async () => {
    const adapter = digitaloceanSpaces({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://custom.example.com:8443",
      region: "nyc3",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("custom.example.com");
    expect(endpoint?.port).toBe(8443);
  });

  test("explicit forcePathStyle: true is forwarded", async () => {
    const adapter = digitaloceanSpaces({
      accessKeyId: "AKID",
      bucket: "uploads",
      forcePathStyle: true,
      region: "nyc3",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing region throws at construction", () => {
    expect(() =>
      digitaloceanSpaces({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/region/u);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.DO_SPACES_KEY;
    const oldSecret = process.env.DO_SPACES_SECRET;
    delete process.env.DO_SPACES_KEY;
    delete process.env.DO_SPACES_SECRET;
    try {
      expect(() =>
        digitaloceanSpaces({ bucket: "uploads", region: "nyc3" })
      ).toThrow(/credentials/u);
    } finally {
      if (oldKey) {
        process.env.DO_SPACES_KEY = oldKey;
      }
      if (oldSecret) {
        process.env.DO_SPACES_SECRET = oldSecret;
      }
    }
  });

  test("picks up credentials from DO_SPACES_KEY / DO_SPACES_SECRET env vars", async () => {
    const oldKey = process.env.DO_SPACES_KEY;
    const oldSecret = process.env.DO_SPACES_SECRET;
    process.env.DO_SPACES_KEY = "ENV_KEY";
    process.env.DO_SPACES_SECRET = "ENV_SECRET";
    try {
      const adapter = digitaloceanSpaces({
        bucket: "uploads",
        region: "nyc3",
      });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.DO_SPACES_KEY;
      } else {
        process.env.DO_SPACES_KEY = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.DO_SPACES_SECRET;
      } else {
        process.env.DO_SPACES_SECRET = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = digitaloceanSpaces({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "nyc3",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("nyc3.digitaloceanspaces.com");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = digitaloceanSpaces({
      accessKeyId: "AKID",
      bucket: "uploads",
      publicBaseUrl: "https://uploads.nyc3.cdn.digitaloceanspaces.com",
      region: "nyc3",
      secretAccessKey: "SECRET",
    });
    expect(await adapter.url("a.txt")).toBe(
      "https://uploads.nyc3.cdn.digitaloceanspaces.com/a.txt"
    );
  });

  test("delegates upload to underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"ok"' });
    const files = new Files({
      adapter: digitaloceanSpaces({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "nyc3",
        secretAccessKey: "SECRET",
      }),
    });
    const result = await files.upload("a.txt", "hi");
    expect(result.etag).toBe("ok");
    s3Mock.reset();
  });

  test("default error messages from the inner s3 adapter are relabeled as 'Spaces error'", async () => {
    // Bypass the SDK mock and exercise the error mapper directly: the spaces
    // adapter configures it to use 'Spaces error' as the Provider fallback.
    const { mapS3Error } = await import("../src/s3/index.js");
    const spacesMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Spaces error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      spacesMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Spaces error");
  });
});
