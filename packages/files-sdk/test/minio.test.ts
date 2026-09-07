import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { AwsClient } from "aws4fetch";

import { Files } from "../src/index.js";
import { minio } from "../src/minio/index.js";
import { makeFakeS3 } from "./fake-s3-server.js";

const creds = { accessKeyId: "AKID", secretAccessKey: "SECRET" } as const;

describe("minio adapter", () => {
  test("configures the underlying S3 client with endpoint, path style, and default region", async () => {
    const adapter = minio({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "http://localhost:9000",
      secretAccessKey: "SECRET",
    });
    expect(adapter.name).toBe("minio");
    // The lazy proxy advertises the s3 engine's capability flags, so range
    // downloads work on MinIO (and every other s3-compatible adapter).
    expect(adapter.supportsRange).toBe(true);
    // The s3 adapter is loaded lazily, so `raw` is undefined until any
    // method has run; a presign needs no network and materializes it.
    await adapter.url("a.txt");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("us-east-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("localhost");
    expect(endpoint?.port).toBe(9000);
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("region override is forwarded to the inner S3 client", async () => {
    const adapter = minio({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "http://localhost:9000",
      region: "eu-central-1",
      secretAccessKey: "SECRET",
    });
    await adapter.url("a.txt");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("eu-central-1");
  });

  test("raw is undefined before any method runs and resolves to the inner S3Client after", async () => {
    const adapter = minio({
      ...creds,
      bucket: "uploads",
      endpoint: "http://localhost:9000",
    });
    expect(adapter.raw).toBeUndefined();
    await adapter.url("a.txt");
    expect(adapter.raw).toBeInstanceOf(S3Client);
  });

  test("missing endpoint throws at construction", () => {
    expect(() =>
      minio({
        accessKeyId: "AKID",
        bucket: "uploads",
        endpoint: "",
        secretAccessKey: "SECRET",
      })
    ).toThrow(/endpoint/u);
  });

  test("missing credentials throws at construction even with endpoint set", () => {
    const oldKey = process.env.MINIO_ACCESS_KEY_ID;
    const oldSecret = process.env.MINIO_SECRET_ACCESS_KEY;
    delete process.env.MINIO_ACCESS_KEY_ID;
    delete process.env.MINIO_SECRET_ACCESS_KEY;
    try {
      expect(() =>
        minio({ bucket: "uploads", endpoint: "http://localhost:9000" })
      ).toThrow(/credentials/u);
    } finally {
      if (oldKey) {
        process.env.MINIO_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret) {
        process.env.MINIO_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = minio({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "http://localhost:9000",
      secretAccessKey: "SECRET",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = minio({
      accessKeyId: "AKID",
      bucket: "uploads",
      endpoint: "http://localhost:9000",
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
      adapter: minio({
        accessKeyId: "AKID",
        bucket: "uploads",
        endpoint: "http://localhost:9000",
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
      adapter: minio({
        accessKeyId: "AKID",
        bucket: "uploads",
        endpoint: "http://localhost:9000",
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

  test("default error messages from the inner s3 adapter are relabeled as 'MinIO error'", async () => {
    // Bypass the SDK mock and exercise the error mapper directly: the minio
    // adapter configures it to use 'MinIO error' as the Provider fallback.
    // mapS3Error reads the message off whatever object is thrown, so a
    // no-message object hits the configured default.
    const { mapS3Error } = await import("../src/s3/index.js");
    const minioMessages = {
      Conflict: "Conflict",
      NotFound: "Not found",
      Provider: "MinIO error",
      Unauthorized: "Unauthorized",
    } as const;
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      minioMessages
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("MinIO error");
  });
});

// The fetch engine keeps MinIO's defaults (path style, region, error label)
// that reaching for the generic s3Fetch() drops — the #155 footgun.
describe("minio adapter — fetch engine", () => {
  const makeFetch = (overrides: Partial<Parameters<typeof minio>[0]> = {}) =>
    minio({
      ...creds,
      bucket: "uploads",
      client: "fetch",
      endpoint: "http://localhost:9000",
      ...overrides,
    });

  test("identifies as minio-fetch with an AwsClient raw and no multipart", () => {
    const adapter = makeFetch();
    expect(adapter.name).toBe("minio-fetch");
    expect(adapter.raw).toBeInstanceOf(AwsClient);
    expect(adapter.resumableUpload).toBeUndefined();
  });

  test("path-style addressing and the us-east-1 signing region by default", async () => {
    const url = new URL(await makeFetch().url("a.txt"));
    expect(url.hostname).toBe("localhost");
    expect(url.port).toBe("9000");
    expect(url.pathname).toBe("/uploads/a.txt");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/us-east-1/");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
  });

  test("forcePathStyle: false and region are forwarded", async () => {
    const url = new URL(
      await makeFetch({ forcePathStyle: false, region: "eu-central-1" }).url(
        "a.txt"
      )
    );
    expect(url.hostname).toBe("uploads.localhost");
    expect(url.pathname).toBe("/a.txt");
    expect(url.searchParams.get("X-Amz-Credential")).toContain(
      "/eu-central-1/"
    );
  });

  test("publicBaseUrl and defaultUrlExpiresIn are forwarded", async () => {
    expect(
      await makeFetch({ publicBaseUrl: "https://cdn.example.com" }).url("a.txt")
    ).toBe("https://cdn.example.com/a.txt");
    const url = new URL(await makeFetch({ defaultUrlExpiresIn: 90 }).url("a"));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("90");
  });

  test("round-trips through the injected fetch", async () => {
    const fake = makeFakeS3();
    const files = new Files({ adapter: makeFetch({ fetch: fake.fetchImpl }) });
    await files.upload("org/a.txt", "hi", { contentType: "text/plain" });
    expect(await files.exists("org/a.txt")).toBe(true);
    const stored = await files.download("org/a.txt");
    expect(await stored.text()).toBe("hi");
    expect(new URL((fake.requests[0] as Request).url).pathname).toBe(
      "/uploads/org/a.txt"
    );
  });

  test("unclassified failures are relabelled as MinIO errors", async () => {
    const adapter = makeFetch({
      fetch: () => Promise.resolve(new Response("not xml", { status: 500 })),
    });
    await expect(adapter.download("a.txt")).rejects.toMatchObject({
      code: "Provider",
      message: "MinIO error",
    });
  });
});

// Swap a global for the duration of a test. Omit `value` to remove it, so
// tests can simulate a runtime without `navigator` at all.
const stubGlobal = (name: string, value?: unknown) => {
  const target = globalThis as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  if (value === undefined) {
    // oxlint-disable-next-line no-dynamic-delete
    delete target[name];
  } else {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  return () => {
    if (original) {
      Object.defineProperty(globalThis, name, original);
    } else {
      // oxlint-disable-next-line no-dynamic-delete
      delete target[name];
    }
  };
};

describe("minio adapter — engine default on Cloudflare Workers", () => {
  const make = (client?: "aws-sdk" | "fetch") =>
    minio({
      ...creds,
      bucket: "uploads",
      ...(client && { client }),
      endpoint: "http://minio.internal:9000",
    });

  test("defaults to the fetch engine on workerd (aws-sdk needs DOMParser)", () => {
    const restore = stubGlobal("navigator", {
      userAgent: "Cloudflare-Workers",
    });
    try {
      expect(make().name).toBe("minio-fetch");
    } finally {
      restore();
    }
  });

  test("keeps the aws-sdk default on workerd when DOMParser is polyfilled", () => {
    const restoreNavigator = stubGlobal("navigator", {
      userAgent: "Cloudflare-Workers",
    });
    const restoreParser = stubGlobal("DOMParser", () => null);
    try {
      expect(make().name).toBe("minio");
    } finally {
      restoreParser();
      restoreNavigator();
    }
  });

  test('an explicit client: "aws-sdk" still wins on workerd', () => {
    const restore = stubGlobal("navigator", {
      userAgent: "Cloudflare-Workers",
    });
    try {
      expect(make("aws-sdk").name).toBe("minio");
    } finally {
      restore();
    }
  });
});
