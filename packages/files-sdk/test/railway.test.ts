import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { Files, FilesError } from "../src/index.js";
import { railway } from "../src/railway/index.js";

// Every env var the railway adapter reads, plus the AWS_* names the s3 core
// would otherwise pick up. Cleared before each test and restored after, so the
// suite is hermetic regardless of what the developer's shell exports.
const RAILWAY_ENV_KEYS = [
  "AWS_S3_BUCKET_NAME",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_S3",
  "AWS_S3_URL_STYLE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

const BUCKET = "uploads-jdhhd8oe18xi";
const KEYS = { accessKeyId: "AKID", secretAccessKey: "SECRET" } as const;

const injectRailwayEnv = (): void => {
  // The set `railway bucket credentials` prints and the AWS SDK preset injects.
  process.env.AWS_ENDPOINT_URL = "https://t3.storageapi.dev";
  process.env.AWS_ACCESS_KEY_ID = "ENV_KEY";
  process.env.AWS_SECRET_ACCESS_KEY = "ENV_SECRET";
  process.env.AWS_S3_BUCKET_NAME = BUCKET;
  process.env.AWS_DEFAULT_REGION = "auto";
  process.env.AWS_S3_URL_STYLE = "virtual";
};

describe("railway adapter", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of RAILWAY_ENV_KEYS) {
      saved[key] = process.env[key];
      Reflect.deleteProperty(process.env, key);
    }
  });

  afterEach(() => {
    for (const key of RAILWAY_ENV_KEYS) {
      if (saved[key] === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  test("constructs with no options from the variables Railway injects", async () => {
    injectRailwayEnv();
    const adapter = railway();
    expect(adapter.name).toBe("railway");
    expect(adapter.bucket).toBe(BUCKET);
    const client = adapter.raw;
    expect(await client.config.region()).toBe("auto");
    expect(await client.config.forcePathStyle).toBe(false);
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("t3.storageapi.dev");
    const creds = await client.config.credentials();
    expect(creds.accessKeyId).toBe("ENV_KEY");
    expect(creds.secretAccessKey).toBe("ENV_SECRET");
  });

  test("defaults to the t3.storageapi.dev endpoint, region auto, virtual-hosted style", async () => {
    const adapter = railway({ bucket: BUCKET, ...KEYS });
    const client = adapter.raw;
    expect(await client.config.region()).toBe("auto");
    // Unset, so the SDK default (virtual-hosted) applies.
    expect(await client.config.forcePathStyle).toBe(false);
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("t3.storageapi.dev");
    expect(endpoint?.protocol).toBe("https:");
  });

  test("a stray AWS_REGION doesn't override the auto signing region", async () => {
    process.env.AWS_REGION = "eu-west-1";
    const adapter = railway({ bucket: BUCKET, ...KEYS });
    expect(await adapter.raw.config.region()).toBe("auto");
  });

  test("explicit options win over the injected variables", async () => {
    injectRailwayEnv();
    const adapter = railway({
      accessKeyId: "OPT_KEY",
      bucket: "other-bucket",
      endpoint: "https://storage.railway.app",
      forcePathStyle: true,
      region: "us-east-1",
      secretAccessKey: "OPT_SECRET",
    });
    expect(adapter.bucket).toBe("other-bucket");
    const client = adapter.raw;
    expect(await client.config.region()).toBe("us-east-1");
    expect(await client.config.forcePathStyle).toBe(true);
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("storage.railway.app");
    const creds = await client.config.credentials();
    expect(creds.accessKeyId).toBe("OPT_KEY");
    expect(creds.secretAccessKey).toBe("OPT_SECRET");
  });

  test("an empty endpoint option falls through to the default", async () => {
    const adapter = railway({ bucket: BUCKET, endpoint: "", ...KEYS });
    const endpoint = await adapter.raw.config.endpoint?.();
    expect(endpoint?.hostname).toBe("t3.storageapi.dev");
  });

  test('AWS_S3_URL_STYLE="path" turns on path-style addressing', async () => {
    process.env.AWS_S3_URL_STYLE = "path";
    const adapter = railway({ bucket: BUCKET, ...KEYS });
    expect(await adapter.raw.config.forcePathStyle).toBe(true);
    const url = await adapter.url("a.txt");
    expect(url).toStartWith(`https://t3.storageapi.dev/${BUCKET}/a.txt?`);
  });

  test("AWS_S3_URL_STYLE is case- and whitespace-tolerant", async () => {
    process.env.AWS_S3_URL_STYLE = " Path ";
    const adapter = railway({ bucket: BUCKET, ...KEYS });
    expect(await adapter.raw.config.forcePathStyle).toBe(true);
  });

  test("an explicit forcePathStyle overrides AWS_S3_URL_STYLE", async () => {
    process.env.AWS_S3_URL_STYLE = "path";
    const adapter = railway({ bucket: BUCKET, forcePathStyle: false, ...KEYS });
    expect(await adapter.raw.config.forcePathStyle).toBe(false);
  });

  test("an unknown AWS_S3_URL_STYLE throws Invalid at construction", () => {
    process.env.AWS_S3_URL_STYLE = "dns";
    let thrown: unknown;
    try {
      railway({ bucket: BUCKET, ...KEYS });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FilesError);
    expect((thrown as FilesError).code).toBe("Invalid");
    expect((thrown as FilesError).message).toContain('got "dns"');
  });

  test("missing bucket throws Invalid", () => {
    expect(() => railway({ ...KEYS })).toThrow(/AWS_S3_BUCKET_NAME/u);
  });

  test("missing credentials throw instead of falling back to the AWS chain", () => {
    expect(() => railway({ bucket: BUCKET })).toThrow(/missing credentials/u);
    process.env.AWS_ACCESS_KEY_ID = "ENV_KEY";
    expect(() => railway({ bucket: BUCKET })).toThrow(/missing credentials/u);
  });

  test("a lone accessKeyId or secretAccessKey throws even when env keys are set", () => {
    injectRailwayEnv();
    expect(() => railway({ accessKeyId: "AKID" })).toThrow(/together/u);
    expect(() => railway({ secretAccessKey: "SECRET" })).toThrow(/together/u);
  });

  test("url() returns a virtual-hosted presigned GET URL by default", async () => {
    const adapter = railway({ bucket: BUCKET, ...KEYS });
    const url = await adapter.url("a.txt");
    expect(url).toStartWith(`https://${BUCKET}.t3.storageapi.dev/a.txt?`);
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=3600");
  });

  test("url() honors defaultUrlExpiresIn", async () => {
    const adapter = railway({
      bucket: BUCKET,
      defaultUrlExpiresIn: 600,
      ...KEYS,
    });
    expect(await adapter.url("a.txt")).toContain("X-Amz-Expires=600");
  });

  test("url() returns the publicBaseUrl when a proxy fronts the bucket", async () => {
    const adapter = railway({
      bucket: BUCKET,
      publicBaseUrl: "https://assets.example.com",
      ...KEYS,
    });
    expect(await adapter.url("a.txt")).toBe("https://assets.example.com/a.txt");
  });

  test("declares presigned URLs and uploads, no public URL or events", () => {
    const files = new Files({ adapter: railway({ bucket: BUCKET, ...KEYS }) });
    const caps = files.capabilities;
    expect(caps.signedUrl.supported).toBe(true);
    expect(caps.signedUpload.supported).toBe(true);
    expect(caps.publicUrl).toBe(false);
    expect(caps.events).toBe(false);
    expect(caps.rangeRead).toBe(true);
    expect(caps.serverSideCopy).toBe(true);
  });

  test("delegates upload to the underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"ok"' });
    const files = new Files({ adapter: railway({ bucket: BUCKET, ...KEYS }) });
    const result = await files.upload("a.txt", "hi");
    expect(result.etag).toBe("ok");
    expect(s3Mock.commandCalls(PutObjectCommand)[0]?.args[0].input).toEqual(
      expect.objectContaining({ Bucket: BUCKET, Key: "a.txt" })
    );
    s3Mock.reset();
  });

  test("delegates exists to the underlying S3 client", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    const files = new Files({ adapter: railway({ bucket: BUCKET, ...KEYS }) });

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

  test("a bodiless provider error reads 'Railway Buckets error'", async () => {
    const s3Mock = mockClient(S3Client);
    s3Mock.reset();
    // A HEAD 5xx has no body, so the AWS SDK can only say "UnknownError".
    s3Mock.on(HeadObjectCommand).rejects(
      Object.assign(new Error("UnknownError"), {
        $metadata: { httpStatusCode: 500 },
        name: "Unknown",
      })
    );
    const files = new Files({
      adapter: railway({ bucket: BUCKET, ...KEYS }),
      retries: 0,
    });
    const thrown = await files.head("a.txt").catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(FilesError);
    expect((thrown as FilesError).code).toBe("Provider");
    expect((thrown as FilesError).message).toBe("Railway Buckets error");
    s3Mock.reset();
  });
});
