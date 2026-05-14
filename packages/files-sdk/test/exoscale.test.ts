import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { exoscale } from "../src/exoscale/index.js";
import { Files } from "../src/index.js";

describe("exoscale adapter", () => {
  test("derives endpoint from region (zone) and uses virtual-hosted style by default", async () => {
    const adapter = exoscale({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "ch-gva-2",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("exoscale");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("ch-gva-2");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("sos-ch-gva-2.exo.io");
    expect(endpoint?.protocol).toBe("https:");
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("region override flows to both the inner S3 client and the derived endpoint", async () => {
    const adapter = exoscale({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "de-fra-1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("de-fra-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("sos-de-fra-1.exo.io");
  });

  test("explicit endpoint overrides the region-derived value", async () => {
    const adapter = exoscale({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://custom.example.com:8443",
      region: "ch-gva-2",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("custom.example.com");
    expect(endpoint?.port).toBe(8443);
  });

  test("explicit forcePathStyle: true is forwarded", async () => {
    const adapter = exoscale({
      accessKeyId: "AKID",
      bucket: "uploads",
      forcePathStyle: true,
      region: "ch-gva-2",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing region throws at construction", () => {
    expect(() =>
      exoscale({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/region/u);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.EXOSCALE_API_KEY;
    const oldSecret = process.env.EXOSCALE_API_SECRET;
    delete process.env.EXOSCALE_API_KEY;
    delete process.env.EXOSCALE_API_SECRET;
    try {
      expect(() => exoscale({ bucket: "uploads", region: "ch-gva-2" })).toThrow(
        /credentials/u
      );
    } finally {
      if (oldKey) {
        process.env.EXOSCALE_API_KEY = oldKey;
      }
      if (oldSecret) {
        process.env.EXOSCALE_API_SECRET = oldSecret;
      }
    }
  });

  test("picks up credentials from EXOSCALE_API_KEY / EXOSCALE_API_SECRET env vars", async () => {
    const oldKey = process.env.EXOSCALE_API_KEY;
    const oldSecret = process.env.EXOSCALE_API_SECRET;
    process.env.EXOSCALE_API_KEY = "ENV_KEY";
    process.env.EXOSCALE_API_SECRET = "ENV_SECRET";
    try {
      const adapter = exoscale({
        bucket: "uploads",
        region: "ch-gva-2",
      });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.EXOSCALE_API_KEY;
      } else {
        process.env.EXOSCALE_API_KEY = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.EXOSCALE_API_SECRET;
      } else {
        process.env.EXOSCALE_API_SECRET = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = exoscale({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "ch-gva-2",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("sos-ch-gva-2.exo.io");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = exoscale({
      accessKeyId: "AKID",
      bucket: "uploads",
      publicBaseUrl: "https://cdn.example.com",
      region: "ch-gva-2",
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
      adapter: exoscale({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "ch-gva-2",
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
      adapter: exoscale({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "ch-gva-2",
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

  test("default error messages from the inner s3 adapter are relabeled as 'Exoscale error'", async () => {
    const { mapS3Error } = await import("../src/s3/index.js");
    const exoMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Exoscale error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error({ $metadata: { httpStatusCode: 500 } }, exoMessages);
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Exoscale error");
  });
});
