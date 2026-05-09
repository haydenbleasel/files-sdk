import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { akamai } from "../src/akamai/index.js";
import { Files } from "../src/index.js";

describe("akamai adapter", () => {
  test("derives endpoint from region and uses virtual-hosted style by default", async () => {
    const adapter = akamai({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "us-iad-1",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("akamai");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("us-iad-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("us-iad-1.linodeobjects.com");
    expect(endpoint?.protocol).toBe("https:");
    // Virtual-hosted style is canonical for Akamai/Linode Object Storage —
    // the AWS SDK's own default (false) is what we want; we don't pass forcePathStyle.
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("region override flows to both the inner S3 client and the derived endpoint", async () => {
    const adapter = akamai({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "nl-ams-1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("nl-ams-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("nl-ams-1.linodeobjects.com");
  });

  test("explicit endpoint overrides the region-derived value", async () => {
    const adapter = akamai({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://custom.example.com:8443",
      region: "us-iad-1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("custom.example.com");
    expect(endpoint?.port).toBe(8443);
  });

  test("explicit forcePathStyle: true is forwarded", async () => {
    const adapter = akamai({
      accessKeyId: "AKID",
      bucket: "uploads",
      forcePathStyle: true,
      region: "us-iad-1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing region throws at construction", () => {
    expect(() =>
      akamai({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/region/u);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.AKAMAI_ACCESS_KEY_ID;
    const oldSecret = process.env.AKAMAI_SECRET_ACCESS_KEY;
    delete process.env.AKAMAI_ACCESS_KEY_ID;
    delete process.env.AKAMAI_SECRET_ACCESS_KEY;
    try {
      expect(() => akamai({ bucket: "uploads", region: "us-iad-1" })).toThrow(
        /credentials/u
      );
    } finally {
      if (oldKey) {
        process.env.AKAMAI_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.AKAMAI_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("picks up credentials from AKAMAI_ACCESS_KEY_ID / AKAMAI_SECRET_ACCESS_KEY env vars", async () => {
    const oldKey = process.env.AKAMAI_ACCESS_KEY_ID;
    const oldSecret = process.env.AKAMAI_SECRET_ACCESS_KEY;
    process.env.AKAMAI_ACCESS_KEY_ID = "ENV_KEY";
    process.env.AKAMAI_SECRET_ACCESS_KEY = "ENV_SECRET";
    try {
      const adapter = akamai({
        bucket: "uploads",
        region: "us-iad-1",
      });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.AKAMAI_ACCESS_KEY_ID;
      } else {
        process.env.AKAMAI_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.AKAMAI_SECRET_ACCESS_KEY;
      } else {
        process.env.AKAMAI_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = akamai({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "us-iad-1",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("us-iad-1.linodeobjects.com");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = akamai({
      accessKeyId: "AKID",
      bucket: "uploads",
      publicBaseUrl: "https://cdn.example.com",
      region: "us-iad-1",
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
      adapter: akamai({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "us-iad-1",
        secretAccessKey: "SECRET",
      }),
    });
    const result = await files.upload("a.txt", "hi");
    expect(result.etag).toBe("ok");
    s3Mock.reset();
  });

  test("default error messages from the inner s3 adapter are relabeled as 'Akamai error'", async () => {
    // Bypass the SDK mock and exercise the error mapper directly: the akamai
    // adapter configures it to use 'Akamai error' as the Provider fallback.
    const { mapS3Error } = await import("../src/s3/index.js");
    const akamaiMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Akamai error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      akamaiMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Akamai error");
  });
});
