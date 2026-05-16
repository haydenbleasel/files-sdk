import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { Files } from "../src/index.js";
import { tencent } from "../src/tencent/index.js";

describe("tencent adapter", () => {
  test("derives endpoint from region and uses virtual-hosted style by default", async () => {
    const adapter = tencent({
      accessKeyId: "AKID",
      bucket: "uploads-1250000000",
      region: "ap-guangzhou",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("tencent");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("ap-guangzhou");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("cos.ap-guangzhou.myqcloud.com");
    expect(endpoint?.protocol).toBe("https:");
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("region override flows to both the inner S3 client and the derived endpoint", async () => {
    const adapter = tencent({
      accessKeyId: "AKID",
      bucket: "uploads-1250000000",
      region: "na-siliconvalley",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("na-siliconvalley");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("cos.na-siliconvalley.myqcloud.com");
  });

  test("explicit endpoint overrides the region-derived value", async () => {
    const adapter = tencent({
      accessKeyId: "AKID",
      bucket: "uploads-1250000000",
      endpoint: "https://custom.example.com:8443",
      region: "ap-guangzhou",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("custom.example.com");
    expect(endpoint?.port).toBe(8443);
  });

  test("explicit forcePathStyle: true is forwarded", async () => {
    const adapter = tencent({
      accessKeyId: "AKID",
      bucket: "uploads-1250000000",
      forcePathStyle: true,
      region: "ap-guangzhou",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing region throws at construction", () => {
    expect(() =>
      tencent({
        accessKeyId: "AKID",
        bucket: "uploads-1250000000",
        region: "",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/region/u);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.TENCENT_SECRET_ID;
    const oldSecret = process.env.TENCENT_SECRET_KEY;
    delete process.env.TENCENT_SECRET_ID;
    delete process.env.TENCENT_SECRET_KEY;
    try {
      expect(() =>
        tencent({ bucket: "uploads-1250000000", region: "ap-guangzhou" })
      ).toThrow(/credentials/u);
    } finally {
      if (oldKey) {
        process.env.TENCENT_SECRET_ID = oldKey;
      }
      if (oldSecret) {
        process.env.TENCENT_SECRET_KEY = oldSecret;
      }
    }
  });

  test("picks up credentials from TENCENT_SECRET_ID / TENCENT_SECRET_KEY env vars", async () => {
    const oldKey = process.env.TENCENT_SECRET_ID;
    const oldSecret = process.env.TENCENT_SECRET_KEY;
    process.env.TENCENT_SECRET_ID = "ENV_KEY";
    process.env.TENCENT_SECRET_KEY = "ENV_SECRET";
    try {
      const adapter = tencent({
        bucket: "uploads-1250000000",
        region: "ap-guangzhou",
      });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.TENCENT_SECRET_ID;
      } else {
        process.env.TENCENT_SECRET_ID = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.TENCENT_SECRET_KEY;
      } else {
        process.env.TENCENT_SECRET_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = tencent({
      accessKeyId: "AKID",
      bucket: "uploads-1250000000",
      region: "ap-guangzhou",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("cos.ap-guangzhou.myqcloud.com");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = tencent({
      accessKeyId: "AKID",
      bucket: "uploads-1250000000",
      publicBaseUrl: "https://cdn.example.com",
      region: "ap-guangzhou",
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
      adapter: tencent({
        accessKeyId: "AKID",
        bucket: "uploads-1250000000",
        region: "ap-guangzhou",
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
      adapter: tencent({
        accessKeyId: "AKID",
        bucket: "uploads-1250000000",
        region: "ap-guangzhou",
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

  test("default error messages from the inner s3 adapter are relabeled as 'Tencent Cloud error'", async () => {
    const { mapS3Error } = await import("../src/s3/index.js");
    const tencentMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Tencent Cloud error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      tencentMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Tencent Cloud error");
  });
});
