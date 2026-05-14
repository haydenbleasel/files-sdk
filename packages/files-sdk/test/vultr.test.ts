import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { Files } from "../src/index.js";
import { vultr } from "../src/vultr/index.js";

describe("vultr adapter", () => {
  test("derives endpoint from region and uses virtual-hosted style by default", async () => {
    const adapter = vultr({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "ewr",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("vultr");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("ewr");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("ewr.vultrobjects.com");
    expect(endpoint?.protocol).toBe("https:");
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("region override flows to both the inner S3 client and the derived endpoint", async () => {
    const adapter = vultr({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "ams",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("ams");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("ams.vultrobjects.com");
  });

  test("explicit endpoint overrides the region-derived value", async () => {
    const adapter = vultr({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://custom.example.com:8443",
      region: "ewr",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("custom.example.com");
    expect(endpoint?.port).toBe(8443);
  });

  test("explicit forcePathStyle: true is forwarded", async () => {
    const adapter = vultr({
      accessKeyId: "AKID",
      bucket: "uploads",
      forcePathStyle: true,
      region: "ewr",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing region throws at construction", () => {
    expect(() =>
      vultr({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/region/u);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.VULTR_ACCESS_KEY_ID;
    const oldSecret = process.env.VULTR_SECRET_ACCESS_KEY;
    delete process.env.VULTR_ACCESS_KEY_ID;
    delete process.env.VULTR_SECRET_ACCESS_KEY;
    try {
      expect(() => vultr({ bucket: "uploads", region: "ewr" })).toThrow(
        /credentials/u
      );
    } finally {
      if (oldKey) {
        process.env.VULTR_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.VULTR_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("picks up credentials from VULTR_ACCESS_KEY_ID / VULTR_SECRET_ACCESS_KEY env vars", async () => {
    const oldKey = process.env.VULTR_ACCESS_KEY_ID;
    const oldSecret = process.env.VULTR_SECRET_ACCESS_KEY;
    process.env.VULTR_ACCESS_KEY_ID = "ENV_KEY";
    process.env.VULTR_SECRET_ACCESS_KEY = "ENV_SECRET";
    try {
      const adapter = vultr({
        bucket: "uploads",
        region: "ewr",
      });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.VULTR_ACCESS_KEY_ID;
      } else {
        process.env.VULTR_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.VULTR_SECRET_ACCESS_KEY;
      } else {
        process.env.VULTR_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = vultr({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "ewr",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("ewr.vultrobjects.com");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = vultr({
      accessKeyId: "AKID",
      bucket: "uploads",
      publicBaseUrl: "https://cdn.example.com",
      region: "ewr",
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
      adapter: vultr({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "ewr",
        secretAccessKey: "SECRET",
      }),
    });
    const result = await files.upload("a.txt", "hi");
    expect(result.etag).toBe("ok");
    s3Mock.reset();
  });

  test("default error messages from the inner s3 adapter are relabeled as 'Vultr error'", async () => {
    const { mapS3Error } = await import("../src/s3/index.js");
    const vultrMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Vultr error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      vultrMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Vultr error");
  });
});
