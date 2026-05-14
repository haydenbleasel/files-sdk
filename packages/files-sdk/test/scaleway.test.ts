import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { Files } from "../src/index.js";
import { scaleway } from "../src/scaleway/index.js";

describe("scaleway adapter", () => {
  test("derives endpoint from region and uses virtual-hosted style by default", async () => {
    const adapter = scaleway({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "fr-par",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("scaleway");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("fr-par");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("s3.fr-par.scw.cloud");
    expect(endpoint?.protocol).toBe("https:");
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("region override flows to both the inner S3 client and the derived endpoint", async () => {
    const adapter = scaleway({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "nl-ams",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("nl-ams");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("s3.nl-ams.scw.cloud");
  });

  test("explicit endpoint overrides the region-derived value", async () => {
    const adapter = scaleway({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://custom.example.com:8443",
      region: "fr-par",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("custom.example.com");
    expect(endpoint?.port).toBe(8443);
  });

  test("explicit forcePathStyle: true is forwarded", async () => {
    const adapter = scaleway({
      accessKeyId: "AKID",
      bucket: "uploads",
      forcePathStyle: true,
      region: "fr-par",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("missing region throws at construction", () => {
    expect(() =>
      scaleway({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/region/u);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.SCW_ACCESS_KEY;
    const oldSecret = process.env.SCW_SECRET_KEY;
    delete process.env.SCW_ACCESS_KEY;
    delete process.env.SCW_SECRET_KEY;
    try {
      expect(() => scaleway({ bucket: "uploads", region: "fr-par" })).toThrow(
        /credentials/u
      );
    } finally {
      if (oldKey) {
        process.env.SCW_ACCESS_KEY = oldKey;
      }
      if (oldSecret) {
        process.env.SCW_SECRET_KEY = oldSecret;
      }
    }
  });

  test("picks up credentials from SCW_ACCESS_KEY / SCW_SECRET_KEY env vars", async () => {
    const oldKey = process.env.SCW_ACCESS_KEY;
    const oldSecret = process.env.SCW_SECRET_KEY;
    process.env.SCW_ACCESS_KEY = "ENV_KEY";
    process.env.SCW_SECRET_KEY = "ENV_SECRET";
    try {
      const adapter = scaleway({
        bucket: "uploads",
        region: "fr-par",
      });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.SCW_ACCESS_KEY;
      } else {
        process.env.SCW_ACCESS_KEY = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.SCW_SECRET_KEY;
      } else {
        process.env.SCW_SECRET_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = scaleway({
      accessKeyId: "AKID",
      bucket: "uploads",
      region: "fr-par",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain("s3.fr-par.scw.cloud");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = scaleway({
      accessKeyId: "AKID",
      bucket: "uploads",
      publicBaseUrl: "https://cdn.example.com",
      region: "fr-par",
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
      adapter: scaleway({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "fr-par",
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
      adapter: scaleway({
        accessKeyId: "AKID",
        bucket: "uploads",
        region: "fr-par",
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

  test("default error messages from the inner s3 adapter are relabeled as 'Scaleway error'", async () => {
    const { mapS3Error } = await import("../src/s3/index.js");
    const scalewayMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Scaleway error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      scalewayMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Scaleway error");
  });
});
