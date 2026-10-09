import { describe, expect, test } from "bun:test";

import * as clientS3 from "@aws-sdk/client-s3";
import * as presignedPost from "@aws-sdk/s3-presigned-post";
import * as requestPresigner from "@aws-sdk/s3-request-presigner";

import { FilesError } from "../src/internal/errors.js";
import { lazyS3Adapter, loadS3Sdk } from "../src/internal/s3-engine.js";
import type { S3Sdk } from "../src/s3/core.js";

// `loadS3Sdk` backs the lazy "aws-sdk" engine of r2(), minio(), and rustfs().
// Its run-time-handled imports are what let a Worker build without the
// optional peers (see test/build-output.test.ts); these cover what the caller
// sees once that engine actually runs.
describe("loadS3Sdk", () => {
  test("loads the installed @aws-sdk modules", async () => {
    const sdk = await loadS3Sdk("minio");
    expect(sdk.clientS3.S3Client).toBe(clientS3.S3Client);
    expect(sdk.presignedPost.createPresignedPost).toBe(
      presignedPost.createPresignedPost
    );
    expect(sdk.requestPresigner.getSignedUrl).toBe(
      requestPresigner.getSignedUrl
    );
  });

  test("an uninstalled peer fails permanently with an install hint", async () => {
    const missing = Object.assign(
      new Error("Cannot find package '@aws-sdk/client-s3'"),
      { code: "ERR_MODULE_NOT_FOUND" }
    );
    let thrown: unknown;
    try {
      await loadS3Sdk("r2-http", () => Promise.reject(missing));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FilesError);
    const { cause, code, message, permanent } = thrown as FilesError;
    expect({ cause, code, permanent }).toEqual({
      cause: missing,
      code: "Unsupported",
      permanent: true,
    });
    expect(message).toStartWith('r2-http adapter: client "aws-sdk" requires');
    for (const hint of [
      "@aws-sdk/client-s3",
      "@aws-sdk/s3-presigned-post",
      "@aws-sdk/s3-request-presigner",
      'client: "fetch"',
    ]) {
      expect(message).toContain(hint);
    }
  });

  test("an empty stand-in module (Next.js webpack's optional-peer fallback) gets the same hint", async () => {
    // Next.js resolves an uninstalled optional peer to an empty module, so
    // the import resolves instead of rejecting.
    const empty = { clientS3: {}, presignedPost: {}, requestPresigner: {} };
    await expect(
      // SAFETY (test): deliberately the wrong shape — what an empty module
      // namespace looks like through the `S3Sdk` lens.
      loadS3Sdk("rustfs", () => Promise.resolve(empty as unknown as S3Sdk))
    ).rejects.toMatchObject({
      cause: undefined,
      code: "Unsupported",
      message: expect.stringContaining(
        'rustfs adapter: client "aws-sdk" requires'
      ),
      permanent: true,
    });
  });

  test("one missing presigner is enough to fail", async () => {
    const partial = { clientS3, presignedPost, requestPresigner: {} };
    await expect(
      // SAFETY (test): `requestPresigner` is deliberately empty.
      loadS3Sdk("minio", () => Promise.resolve(partial as unknown as S3Sdk))
    ).rejects.toMatchObject({ code: "Unsupported", permanent: true });
  });
});

describe("lazyS3Adapter", () => {
  test("exposes its bucket synchronously, for the events bucket filter", () => {
    const adapter = lazyS3Adapter(
      {
        bucket: "uploads",
        credentials: { accessKeyId: "k", secretAccessKey: "s" },
        endpoint: "http://127.0.0.1:9000",
        region: "us-east-1",
      },
      "minio"
    );
    expect(adapter.bucket).toBe("uploads");
  });
});
