import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { filebase } from "../src/filebase/index.js";
import { Files } from "../src/index.js";

describe("filebase adapter", () => {
  test("defaults to the public Filebase endpoint and us-east-1 region", async () => {
    const adapter = filebase({
      accessKeyId: "AKID",
      bucket: "uploads",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("filebase");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("us-east-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("s3.filebase.com");
    expect(endpoint?.protocol).toBe("https:");
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("explicit endpoint overrides the default", async () => {
    const adapter = filebase({
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

  test("region override flows to the inner S3 client", async () => {
    const adapter = filebase({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "eu-west-1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("eu-west-1");
  });

  test("explicit forcePathStyle: true is forwarded", async () => {
    const adapter = filebase({
      accessKeyId: "AKID",
      bucket: "uploads",
      forcePathStyle: true,
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.FILEBASE_ACCESS_KEY_ID;
    const oldSecret = process.env.FILEBASE_SECRET_ACCESS_KEY;
    delete process.env.FILEBASE_ACCESS_KEY_ID;
    delete process.env.FILEBASE_SECRET_ACCESS_KEY;
    try {
      expect(() => filebase({ bucket: "uploads" })).toThrow(/credentials/u);
    } finally {
      if (oldKey) {
        process.env.FILEBASE_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.FILEBASE_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("picks up credentials from FILEBASE_ACCESS_KEY_ID / FILEBASE_SECRET_ACCESS_KEY env vars", async () => {
    const oldKey = process.env.FILEBASE_ACCESS_KEY_ID;
    const oldSecret = process.env.FILEBASE_SECRET_ACCESS_KEY;
    process.env.FILEBASE_ACCESS_KEY_ID = "ENV_KEY";
    process.env.FILEBASE_SECRET_ACCESS_KEY = "ENV_SECRET";
    try {
      const adapter = filebase({ bucket: "uploads" });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.FILEBASE_ACCESS_KEY_ID;
      } else {
        process.env.FILEBASE_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.FILEBASE_SECRET_ACCESS_KEY;
      } else {
        process.env.FILEBASE_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = filebase({
      accessKeyId: "AKID",
      bucket: "uploads",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("s3.filebase.com");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = filebase({
      accessKeyId: "AKID",
      bucket: "uploads",
      publicBaseUrl: "https://ipfs.filebase.io/ipfs/CID",
      secretAccessKey: "SECRET",
    });
    expect(await adapter.url("a.txt")).toBe(
      "https://ipfs.filebase.io/ipfs/CID/a.txt"
    );
  });

  test("delegates upload to underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"ok"' });
    const files = new Files({
      adapter: filebase({
        accessKeyId: "AKID",
        bucket: "uploads",
        secretAccessKey: "SECRET",
      }),
    });
    const result = await files.upload("a.txt", "hi");
    expect(result.etag).toBe("ok");
    s3Mock.reset();
  });

  test("default error messages from the inner s3 adapter are relabeled as 'Filebase error'", async () => {
    const { mapS3Error } = await import("../src/s3/index.js");
    const filebaseMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Filebase error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      filebaseMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Filebase error");
  });
});
