import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { Files } from "../src/index.js";
import { oracleCloud } from "../src/oracle-cloud/index.js";

describe("oracle-cloud adapter", () => {
  test("derives endpoint from namespace + region and defaults to path-style", async () => {
    const adapter = oracleCloud({
      accessKeyId: "AKID",
      bucket: "uploads",
      namespace: "axoki12345",
      region: "us-ashburn-1",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("oracle-cloud");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("us-ashburn-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe(
      "axoki12345.compat.objectstorage.us-ashburn-1.oraclecloud.com"
    );
    expect(endpoint?.protocol).toBe("https:");
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("region override flows to both the inner S3 client and the derived endpoint", async () => {
    const adapter = oracleCloud({
      accessKeyId: "AKID",
      bucket: "uploads",
      namespace: "axoki12345",
      region: "eu-frankfurt-1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("eu-frankfurt-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe(
      "axoki12345.compat.objectstorage.eu-frankfurt-1.oraclecloud.com"
    );
  });

  test("explicit endpoint overrides the derived value", async () => {
    const adapter = oracleCloud({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "https://custom.example.com:8443",
      namespace: "axoki12345",
      region: "us-ashburn-1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("custom.example.com");
    expect(endpoint?.port).toBe(8443);
  });

  test("explicit forcePathStyle: false is forwarded (opt out of default)", async () => {
    const adapter = oracleCloud({
      accessKeyId: "AKID",
      bucket: "uploads",
      forcePathStyle: false,
      namespace: "axoki12345",
      region: "us-ashburn-1",
      secretAccessKey: "SECRET",
    });
    const client = adapter.raw as S3Client;
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("missing namespace throws at construction", () => {
    expect(() =>
      oracleCloud({
        accessKeyId: "AKID",
        bucket: "uploads",
        namespace: "",
        region: "us-ashburn-1",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/namespace/u);
  });

  test("missing region throws at construction", () => {
    expect(() =>
      oracleCloud({
        accessKeyId: "AKID",
        bucket: "uploads",
        namespace: "axoki12345",
        region: "",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/region/u);
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.OCI_ACCESS_KEY_ID;
    const oldSecret = process.env.OCI_SECRET_ACCESS_KEY;
    delete process.env.OCI_ACCESS_KEY_ID;
    delete process.env.OCI_SECRET_ACCESS_KEY;
    try {
      expect(() =>
        oracleCloud({
          bucket: "uploads",
          namespace: "axoki12345",
          region: "us-ashburn-1",
        })
      ).toThrow(/credentials/u);
    } finally {
      if (oldKey) {
        process.env.OCI_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.OCI_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("picks up credentials from OCI_ACCESS_KEY_ID / OCI_SECRET_ACCESS_KEY env vars", async () => {
    const oldKey = process.env.OCI_ACCESS_KEY_ID;
    const oldSecret = process.env.OCI_SECRET_ACCESS_KEY;
    process.env.OCI_ACCESS_KEY_ID = "ENV_KEY";
    process.env.OCI_SECRET_ACCESS_KEY = "ENV_SECRET";
    try {
      const adapter = oracleCloud({
        bucket: "uploads",
        namespace: "axoki12345",
        region: "us-ashburn-1",
      });
      const client = adapter.raw as S3Client;
      const creds = await client.config.credentials();
      expect(creds.accessKeyId).toBe("ENV_KEY");
      expect(creds.secretAccessKey).toBe("ENV_SECRET");
    } finally {
      if (oldKey === undefined) {
        delete process.env.OCI_ACCESS_KEY_ID;
      } else {
        process.env.OCI_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.OCI_SECRET_ACCESS_KEY;
      } else {
        process.env.OCI_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = oracleCloud({
      accessKeyId: "AKID",
      bucket: "uploads",
      namespace: "axoki12345",
      region: "us-ashburn-1",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
    expect(url).toContain(
      "axoki12345.compat.objectstorage.us-ashburn-1.oraclecloud.com"
    );
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = oracleCloud({
      accessKeyId: "AKID",
      bucket: "uploads",
      namespace: "axoki12345",
      publicBaseUrl: "https://cdn.example.com",
      region: "us-ashburn-1",
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
      adapter: oracleCloud({
        accessKeyId: "AKID",
        bucket: "uploads",
        namespace: "axoki12345",
        region: "us-ashburn-1",
        secretAccessKey: "SECRET",
      }),
    });
    const result = await files.upload("a.txt", "hi");
    expect(result.etag).toBe("ok");
    s3Mock.reset();
  });

  test("default error messages from the inner s3 adapter are relabeled as 'Oracle Cloud error'", async () => {
    const { mapS3Error } = await import("../src/s3/index.js");
    const ociMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "Oracle Cloud error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error({ $metadata: { httpStatusCode: 500 } }, ociMessages);
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("Oracle Cloud error");
  });
});
