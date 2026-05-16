import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { alibaba } from "../src/alibaba/index.js";
import { Files } from "../src/index.js";

describe("alibaba adapter", () => {
  test("derives endpoint from region and uses virtual-hosted style by default", async () => {
    const adapter = alibaba({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "cn-hangzhou",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("alibaba");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("cn-hangzhou");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("oss-cn-hangzhou.aliyuncs.com");
    expect(endpoint?.protocol).toBe("https:");
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("region override flows to both the inner S3 client and the derived endpoint", async () => {
    const adapter = alibaba({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "ap-southeast-1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("ap-southeast-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("oss-ap-southeast-1.aliyuncs.com");
  });

  test("explicit endpoint overrides the region-derived value", async () => {
    const adapter = alibaba({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://custom.example.com:8443",
      region: "cn-hangzhou",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("custom.example.com");
    expect(endpoint?.port).toBe(8443);
  });

  test("explicit forcePathStyle: true is forwarded", async () => {
    const adapter = alibaba({
      accessKeyId: "AKID",
      bucket: "uploads",
      forcePathStyle: true,
      region: "cn-hangzhou",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing region throws at construction", () => {
    expect(() =>
      alibaba({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/region/u);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.ALIBABA_ACCESS_KEY_ID;
    const oldSecret = process.env.ALIBABA_ACCESS_KEY_SECRET;
    delete process.env.ALIBABA_ACCESS_KEY_ID;
    delete process.env.ALIBABA_ACCESS_KEY_SECRET;
    try {
      expect(() =>
        alibaba({ bucket: "uploads", region: "cn-hangzhou" })
      ).toThrow(/credentials/u);
    } finally {
      if (oldKey) {
        process.env.ALIBABA_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.ALIBABA_ACCESS_KEY_SECRET = oldSecret;
      }
    }
  });

  test("picks up credentials from ALIBABA_ACCESS_KEY_ID / ALIBABA_ACCESS_KEY_SECRET env vars", async () => {
    const oldKey = process.env.ALIBABA_ACCESS_KEY_ID;
    const oldSecret = process.env.ALIBABA_ACCESS_KEY_SECRET;
    process.env.ALIBABA_ACCESS_KEY_ID = "ENV_KEY";
    process.env.ALIBABA_ACCESS_KEY_SECRET = "ENV_SECRET";
    try {
      const adapter = alibaba({
        bucket: "uploads",
        region: "cn-hangzhou",
      });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.ALIBABA_ACCESS_KEY_ID;
      } else {
        process.env.ALIBABA_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.ALIBABA_ACCESS_KEY_SECRET;
      } else {
        process.env.ALIBABA_ACCESS_KEY_SECRET = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = alibaba({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "cn-hangzhou",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("oss-cn-hangzhou.aliyuncs.com");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = alibaba({
      accessKeyId: "AKID",
      bucket: "uploads",
      publicBaseUrl: "https://cdn.example.com",
      region: "cn-hangzhou",
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
      adapter: alibaba({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "cn-hangzhou",
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
      adapter: alibaba({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "cn-hangzhou",
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

  test("default error messages from the inner s3 adapter are relabeled as 'Alibaba Cloud error'", async () => {
    const { mapS3Error } = await import("../src/s3/index.js");
    const alibabaMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Alibaba Cloud error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      alibabaMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Alibaba Cloud error");
  });
});
