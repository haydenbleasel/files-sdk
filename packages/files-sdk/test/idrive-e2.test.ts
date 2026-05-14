import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { idriveE2 } from "../src/idrive-e2/index.js";
import { Files } from "../src/index.js";

describe("idrive-e2 adapter", () => {
  test("forwards endpoint and defaults region to us-east-1", async () => {
    const adapter = idriveE2({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://q9z7.va.idrivee2-12.com",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("idrive-e2");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("us-east-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("q9z7.va.idrivee2-12.com");
    expect(endpoint?.protocol).toBe("https:");
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("region override flows to the inner S3 client", async () => {
    const adapter = idriveE2({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://q9z7.va.idrivee2-12.com",
      region: "eu-west-1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("eu-west-1");
  });

  test("explicit forcePathStyle: true is forwarded", async () => {
    const adapter = idriveE2({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://q9z7.va.idrivee2-12.com",
      forcePathStyle: true,
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing endpoint throws at construction", () => {
    expect(() =>
      idriveE2({
        accessKeyId: "AKID",
        bucket: "uploads",
        endpoint: "",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/endpoint/u);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.IDRIVE_E2_ACCESS_KEY_ID;
    const oldSecret = process.env.IDRIVE_E2_SECRET_ACCESS_KEY;
    delete process.env.IDRIVE_E2_ACCESS_KEY_ID;
    delete process.env.IDRIVE_E2_SECRET_ACCESS_KEY;
    try {
      expect(() =>
        idriveE2({
          bucket: "uploads",
          endpoint: "https://q9z7.va.idrivee2-12.com",
        })
      ).toThrow(/credentials/u);
    } finally {
      if (oldKey) {
        process.env.IDRIVE_E2_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.IDRIVE_E2_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("picks up credentials from IDRIVE_E2_ACCESS_KEY_ID / IDRIVE_E2_SECRET_ACCESS_KEY env vars", async () => {
    const oldKey = process.env.IDRIVE_E2_ACCESS_KEY_ID;
    const oldSecret = process.env.IDRIVE_E2_SECRET_ACCESS_KEY;
    process.env.IDRIVE_E2_ACCESS_KEY_ID = "ENV_KEY";
    process.env.IDRIVE_E2_SECRET_ACCESS_KEY = "ENV_SECRET";
    try {
      const adapter = idriveE2({
        bucket: "uploads",
        endpoint: "https://q9z7.va.idrivee2-12.com",
      });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.IDRIVE_E2_ACCESS_KEY_ID;
      } else {
        process.env.IDRIVE_E2_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.IDRIVE_E2_SECRET_ACCESS_KEY;
      } else {
        process.env.IDRIVE_E2_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = idriveE2({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://q9z7.va.idrivee2-12.com",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("idrivee2-12.com");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = idriveE2({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://q9z7.va.idrivee2-12.com",
      publicBaseUrl: "https://cdn.example.com",
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
      adapter: idriveE2({
        accessKeyId: "AKID",
        bucket: "uploads",
        endpoint: "https://q9z7.va.idrivee2-12.com",
        secretAccessKey: "SECRET",
      }),
    });
    const result = await files.upload("a.txt", "hi");
    expect(result.etag).toBe("ok");
    s3Mock.reset();
  });

  test("default error messages from the inner s3 adapter are relabeled as 'iDrive e2 error'", async () => {
    const { mapS3Error } = await import("../src/s3/index.js");
    const idriveMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "iDrive e2 error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      idriveMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("iDrive e2 error");
  });
});
