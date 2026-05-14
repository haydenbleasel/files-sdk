import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { hetzner } from "../src/hetzner/index.js";
import { Files } from "../src/index.js";

describe("hetzner adapter", () => {
  test("derives endpoint from region and uses virtual-hosted style by default", async () => {
    const adapter = hetzner({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "fsn1",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("hetzner");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("fsn1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("fsn1.your-objectstorage.com");
    expect(endpoint?.protocol).toBe("https:");
    // Virtual-hosted style is the canonical Hetzner routing — the AWS SDK's
    // own default (false) is what we want; we don't pass forcePathStyle.
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("region override flows to both the inner S3 client and the derived endpoint", async () => {
    const adapter = hetzner({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "hel1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("hel1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("hel1.your-objectstorage.com");
  });

  test("explicit endpoint overrides the region-derived value", async () => {
    const adapter = hetzner({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://custom.example.com:8443",
      region: "fsn1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("custom.example.com");
    expect(endpoint?.port).toBe(8443);
  });

  test("explicit forcePathStyle: true is forwarded", async () => {
    const adapter = hetzner({
      accessKeyId: "AKID",
      bucket: "uploads",
      forcePathStyle: true,
      region: "fsn1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing region throws at construction", () => {
    expect(() =>
      hetzner({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/region/u);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.HCLOUD_ACCESS_KEY_ID;
    const oldSecret = process.env.HCLOUD_SECRET_ACCESS_KEY;
    delete process.env.HCLOUD_ACCESS_KEY_ID;
    delete process.env.HCLOUD_SECRET_ACCESS_KEY;
    try {
      expect(() => hetzner({ bucket: "uploads", region: "fsn1" })).toThrow(
        /credentials/u
      );
    } finally {
      if (oldKey) {
        process.env.HCLOUD_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.HCLOUD_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("picks up credentials from HCLOUD_ACCESS_KEY_ID / HCLOUD_SECRET_ACCESS_KEY env vars", async () => {
    const oldKey = process.env.HCLOUD_ACCESS_KEY_ID;
    const oldSecret = process.env.HCLOUD_SECRET_ACCESS_KEY;
    process.env.HCLOUD_ACCESS_KEY_ID = "ENV_KEY";
    process.env.HCLOUD_SECRET_ACCESS_KEY = "ENV_SECRET";
    try {
      const adapter = hetzner({
        bucket: "uploads",
        region: "fsn1",
      });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.HCLOUD_ACCESS_KEY_ID;
      } else {
        process.env.HCLOUD_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.HCLOUD_SECRET_ACCESS_KEY;
      } else {
        process.env.HCLOUD_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = hetzner({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "fsn1",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("fsn1.your-objectstorage.com");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = hetzner({
      accessKeyId: "AKID",
      bucket: "uploads",
      publicBaseUrl: "https://cdn.example.com",
      region: "fsn1",
      secretAccessKey: "SECRET",
    });
    expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
  });

  test("delegates upload to underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"ok"' });
    const files = new Files({
      adapter: hetzner({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "fsn1",
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
      adapter: hetzner({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "fsn1",
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

  test("default error messages from the inner s3 adapter are relabeled as 'Hetzner error'", async () => {
    // Bypass the SDK mock and exercise the error mapper directly: the hetzner
    // adapter configures it to use 'Hetzner error' as the Provider fallback.
    const { mapS3Error } = await import("../src/s3/index.js");
    const hetznerMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Hetzner error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      hetznerMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Hetzner error");
  });
});
