import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { Files } from "../src/index.js";
import { yandex } from "../src/yandex/index.js";

describe("yandex adapter", () => {
  test("uses Yandex's global endpoint and 'ru-central1' region by default", async () => {
    const adapter = yandex({
      accessKeyId: "AKID",
      bucket: "uploads",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("yandex");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("ru-central1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("storage.yandexcloud.net");
    expect(endpoint?.protocol).toBe("https:");
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("region override flows to the inner S3 client", async () => {
    const adapter = yandex({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "ru-central2",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("ru-central2");
    // Endpoint stays the same — region doesn't drive the host on Yandex.
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("storage.yandexcloud.net");
  });

  test("explicit endpoint overrides the default", async () => {
    const adapter = yandex({
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
    const adapter = yandex({
      accessKeyId: "AKID",
      bucket: "uploads",
      forcePathStyle: true,
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.YANDEX_ACCESS_KEY_ID;
    const oldSecret = process.env.YANDEX_SECRET_ACCESS_KEY;
    delete process.env.YANDEX_ACCESS_KEY_ID;
    delete process.env.YANDEX_SECRET_ACCESS_KEY;
    try {
      expect(() => yandex({ bucket: "uploads" })).toThrow(/credentials/u);
    } finally {
      if (oldKey) {
        process.env.YANDEX_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.YANDEX_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("picks up credentials from YANDEX_ACCESS_KEY_ID / YANDEX_SECRET_ACCESS_KEY env vars", async () => {
    const oldKey = process.env.YANDEX_ACCESS_KEY_ID;
    const oldSecret = process.env.YANDEX_SECRET_ACCESS_KEY;
    process.env.YANDEX_ACCESS_KEY_ID = "ENV_KEY";
    process.env.YANDEX_SECRET_ACCESS_KEY = "ENV_SECRET";
    try {
      const adapter = yandex({ bucket: "uploads" });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.YANDEX_ACCESS_KEY_ID;
      } else {
        process.env.YANDEX_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.YANDEX_SECRET_ACCESS_KEY;
      } else {
        process.env.YANDEX_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = yandex({
      accessKeyId: "AKID",
      bucket: "uploads",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("storage.yandexcloud.net");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = yandex({
      accessKeyId: "AKID",
      bucket: "uploads",
      publicBaseUrl: "https://uploads.storage.yandexcloud.net",
      secretAccessKey: "SECRET",
    });
    expect(await adapter.url("a.txt")).toBe(
      "https://uploads.storage.yandexcloud.net/a.txt"
    );
  });

  test("delegates upload to underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"ok"' });
    const files = new Files({
      adapter: yandex({
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
      adapter: yandex({
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

  test("default error messages from the inner s3 adapter are relabeled as 'Yandex Cloud error'", async () => {
    const { mapS3Error } = await import("../src/s3/index.js");
    const yandexMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Yandex Cloud error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      yandexMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Yandex Cloud error");
  });
});
