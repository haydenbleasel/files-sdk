import { describe, expect, test } from "bun:test";

import { S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { AwsClient } from "aws4fetch";

import { Files } from "../src/index.js";
import { rustfs } from "../src/rustfs/index.js";
import { makeFakeS3 } from "./fake-s3-server.js";

const creds = { accessKeyId: "AKID", secretAccessKey: "SECRET" } as const;

const ENV_KEYS = [
  "RUSTFS_ACCESS_KEY_ID",
  "RUSTFS_SECRET_ACCESS_KEY",
  "RUSTFS_ACCESS_KEY",
  "RUSTFS_SECRET_KEY",
] as const;

// Clear every credential env var for the duration of `run`, then restore.
const withoutCredentialEnv = <T>(run: () => T): T => {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) {
    // oxlint-disable-next-line no-dynamic-delete
    delete process.env[key];
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  }
};

describe("rustfs adapter", () => {
  test("configures the underlying S3 client with endpoint, path style, and default region", async () => {
    const adapter = rustfs({
      ...creds,
      bucket: "uploads",
      endpoint: "http://localhost:9000",
    });
    expect(adapter.name).toBe("rustfs");
    // The lazy proxy advertises the s3 engine's capability flags, so range
    // downloads work on RustFS like every other s3-compatible adapter.
    expect(new Files({ adapter }).capabilities.rangeRead).toBe(true);
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

  test("region and forcePathStyle overrides are forwarded to the inner S3 client", async () => {
    const adapter = rustfs({
      ...creds,
      bucket: "uploads",
      endpoint: "http://localhost:9000",
      forcePathStyle: false,
      region: "eu-central-1",
    });
    await adapter.url("a.txt");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("eu-central-1");
    expect(await client.config.forcePathStyle).toBe(false);
  });

  test("raw is undefined before any method runs and resolves to the inner S3Client after", async () => {
    const adapter = rustfs({
      ...creds,
      bucket: "uploads",
      endpoint: "http://localhost:9000",
    });
    expect(adapter.raw).toBeUndefined();
    await adapter.url("a.txt");
    expect(adapter.raw).toBeInstanceOf(S3Client);
  });

  test("missing endpoint throws at construction", () => {
    expect(() => rustfs({ ...creds, bucket: "uploads", endpoint: "" })).toThrow(
      /endpoint/u
    );
  });

  test("missing credentials throws at construction even with endpoint set", () => {
    withoutCredentialEnv(() => {
      expect(() =>
        rustfs({ bucket: "uploads", endpoint: "http://localhost:9000" })
      ).toThrow(/credentials/u);
    });
  });

  test("reads the SDK-convention RUSTFS_*_ACCESS_KEY_ID env vars", () => {
    withoutCredentialEnv(() => {
      process.env.RUSTFS_ACCESS_KEY_ID = "ENVKEY";
      process.env.RUSTFS_SECRET_ACCESS_KEY = "ENVSECRET";
      const adapter = rustfs({
        bucket: "uploads",
        client: "fetch",
        endpoint: "http://localhost:9000",
      });
      expect(adapter.name).toBe("rustfs-fetch");
    });
  });

  test("falls back to the server's own RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY names", async () => {
    // Credentials are captured at construction, so the presign can settle
    // after the env window closes.
    const pending = withoutCredentialEnv(() => {
      process.env.RUSTFS_ACCESS_KEY = "SERVERKEY";
      process.env.RUSTFS_SECRET_KEY = "SERVERSECRET";
      return rustfs({
        bucket: "uploads",
        client: "fetch",
        endpoint: "http://localhost:9000",
      }).url("a.txt");
    });
    const signed = new URL(await pending);
    expect(signed.searchParams.get("X-Amz-Credential")).toStartWith(
      "SERVERKEY/"
    );
  });

  test("url() returns a presigned GET URL by default", async () => {
    const adapter = rustfs({
      ...creds,
      bucket: "uploads",
      endpoint: "http://localhost:9000",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("a.txt");
    expect(url).toContain("X-Amz-Expires=3600");
  });

  test("url() returns the publicBaseUrl when configured", async () => {
    const adapter = rustfs({
      ...creds,
      bucket: "uploads",
      endpoint: "http://localhost:9000",
      publicBaseUrl: "https://cdn.example.com",
    });
    expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
  });

  test("defaultUrlExpiresIn is forwarded", async () => {
    const adapter = rustfs({
      ...creds,
      bucket: "uploads",
      defaultUrlExpiresIn: 90,
      endpoint: "http://localhost:9000",
    });
    expect(await adapter.url("a.txt")).toContain("X-Amz-Expires=90");
  });

  test("delegates upload to underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"ok"' });
    const files = new Files({
      adapter: rustfs({
        ...creds,
        bucket: "uploads",
        endpoint: "http://localhost:9000",
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
      adapter: rustfs({
        ...creds,
        bucket: "uploads",
        endpoint: "http://localhost:9000",
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

  test("default error messages from the inner s3 adapter are relabeled as 'RustFS error'", async () => {
    // Bypass the SDK mock and exercise the error mapper directly: the rustfs
    // adapter configures it to use 'RustFS error' as the Provider fallback.
    const { mapS3Error } = await import("../src/s3/index.js");
    const err = mapS3Error(
      { $metadata: { httpStatusCode: 500 } },
      {
        Conflict: "Conflict",
        NotFound: "Not found",
        Provider: "RustFS error",
        Unauthorized: "Unauthorized",
      }
    );
    expect(err.code).toBe("Provider");
    expect(err.message).toBe("RustFS error");
  });
});

// The fetch engine keeps RustFS's defaults (path style, region, error label)
// that reaching for the generic s3Fetch() drops — the #155 footgun.
describe("rustfs adapter — fetch engine", () => {
  const makeFetch = (overrides: Partial<Parameters<typeof rustfs>[0]> = {}) =>
    rustfs({
      ...creds,
      bucket: "uploads",
      client: "fetch",
      endpoint: "http://localhost:9000",
      ...overrides,
    });

  test("identifies as rustfs-fetch with an AwsClient raw and no multipart", () => {
    const adapter = makeFetch();
    expect(adapter.name).toBe("rustfs-fetch");
    expect(adapter.raw).toBeInstanceOf(AwsClient);
    expect(adapter.resumableUpload).toBeUndefined();
  });

  test("inherits the fetch engine's declaration: no native progress, no maxSize", () => {
    const { capabilities } = new Files({ adapter: makeFetch() });
    expect(capabilities.uploadProgress).toBe(false);
    expect(capabilities.signedUpload).toMatchObject({
      contentType: true,
      maxSize: false,
      supported: true,
    });
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

  test("unclassified failures are relabelled as RustFS errors", async () => {
    const adapter = makeFetch({
      fetch: () => Promise.resolve(new Response("not xml", { status: 500 })),
    });
    await expect(adapter.download("a.txt")).rejects.toMatchObject({
      code: "Provider",
      message: "RustFS error",
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

describe("rustfs adapter — engine default on Cloudflare Workers", () => {
  const make = (client?: "aws-sdk" | "fetch") =>
    rustfs({
      ...creds,
      bucket: "uploads",
      ...(client && { client }),
      endpoint: "http://rustfs.internal:9000",
    });

  test("defaults to the fetch engine on workerd (aws-sdk needs DOMParser)", () => {
    const restore = stubGlobal("navigator", {
      userAgent: "Cloudflare-Workers",
    });
    try {
      expect(make().name).toBe("rustfs-fetch");
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
      expect(make().name).toBe("rustfs");
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
      expect(make("aws-sdk").name).toBe("rustfs");
    } finally {
      restore();
    }
  });
});
