/**
 * Live test for the `s3` adapter against a real S3 bucket.
 *
 * Skipped unless `LIVE_TESTS=1` *and* the required credentials are present, so
 * a missing secret skips cleanly instead of failing with an auth error. Mirrors
 * the CRUD + URL scenarios in `s3.test.ts`, but against the real service with no
 * `aws-sdk-client-mock`.
 *
 * Required env:
 *   LIVE_TESTS=1
 *   S3_LIVE_BUCKET           bucket to run against (objects are cleaned up)
 *   AWS_REGION               bucket region (e.g. us-east-1)
 *   AWS_ACCESS_KEY_ID        credentials
 *   AWS_SECRET_ACCESS_KEY    credentials
 *   AWS_SESSION_TOKEN        optional, for temporary credentials
 *
 *   LIVE_TESTS=1 S3_LIVE_BUCKET=my-bucket AWS_REGION=us-east-1 \
 *     AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... bun test s3.live
 */
import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { Files } from "../src/index.js";
import { s3 } from "../src/s3/index.js";
import { liveDescribeWithEnv, requireEnv } from "./live-helper.js";

const REQUIRED_ENV = [
  "S3_LIVE_BUCKET",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

const liveDescribe = liveDescribeWithEnv(REQUIRED_ENV);

// Every object lands under a unique per-run prefix so concurrent or repeated
// runs never collide, and so cleanup can delete exactly what this run created.
const runPrefix = `files-sdk-live/${randomUUID()}/`;
const createdKeys: string[] = [];

const makeFiles = (): Files => {
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  return new Files({
    adapter: s3({
      bucket: requireEnv("S3_LIVE_BUCKET"),
      credentials: {
        accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
        ...(sessionToken ? { sessionToken } : {}),
      },
      region: requireEnv("AWS_REGION"),
    }),
  });
};

const key = (name: string): string => {
  const full = runPrefix + name;
  createdKeys.push(full);
  return full;
};

afterAll(async () => {
  if (process.env.LIVE_TESTS !== "1" || createdKeys.length === 0) {
    return;
  }
  const files = makeFiles();
  await files.delete(createdKeys).catch(() => {
    // Best-effort cleanup — a failure here shouldn't mask test results.
  });
});

liveDescribe("s3 adapter (live)", () => {
  test("upload + download round-trips against real S3", async () => {
    const files = makeFiles();
    const k = key("round-trip.txt");

    const result = await files.upload(k, "hello live", {
      cacheControl: "public, max-age=60",
      contentType: "text/plain",
      metadata: { run: "live" },
    });
    expect(result.key).toBe(k);
    expect(result.contentType).toBe("text/plain");
    expect(result.etag).toBeDefined();

    const got = await files.download(k);
    expect(await got.text()).toBe("hello live");
    expect(got.type).toBe("text/plain");
    expect(got.metadata).toEqual({ run: "live" });
  });

  test("head returns metadata without transferring the body", async () => {
    const files = makeFiles();
    const k = key("head.json");
    await files.upload(k, '{"ok":true}', {
      contentType: "application/json",
      metadata: { foo: "bar" },
    });

    const info = await files.head(k);
    expect(info.size).toBe(11);
    expect(info.type).toBe("application/json");
    expect(info.metadata).toEqual({ foo: "bar" });
    await expect(files.exists(k)).resolves.toBe(true);
    await expect(files.exists(key("missing.json"))).resolves.toBe(false);
  });

  test("copy duplicates the object server-side", async () => {
    const files = makeFiles();
    const src = key("copy-src.txt");
    const dst = key("copy-dst.txt");
    await files.upload(src, "payload");

    await files.copy(src, dst);
    const copied = await files.download(dst);
    expect(await copied.text()).toBe("payload");
    await expect(files.exists(src)).resolves.toBe(true);
  });

  test("list returns uploaded objects under the prefix", async () => {
    const files = makeFiles();
    const listPrefix = `${runPrefix}listing/`;
    await files.upload(key("listing/a.txt"), "1");
    await files.upload(key("listing/b.txt"), "1");

    const out = await files.list({ prefix: listPrefix });
    const keys = out.items.map((i) => i.key).toSorted();
    expect(keys).toEqual([`${listPrefix}a.txt`, `${listPrefix}b.txt`]);
  });

  test("delete removes the object", async () => {
    const files = makeFiles();
    const k = key("delete.txt");
    await files.upload(k, "bye");

    await files.delete(k);
    await expect(files.exists(k)).resolves.toBe(false);
  });

  test("url() returns a presigned GET URL that resolves to the body", async () => {
    const files = makeFiles();
    const k = key("signed-url.txt");
    await files.upload(k, "signed-body");

    const url = await files.url(k, { expiresIn: 120 });
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain("X-Amz-Expires=120");

    // The presigned URL is actually fetchable.
    const response = await fetch(url);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe("signed-body");
  });

  test("signedUploadUrl issues a PUT URL that accepts a real upload", async () => {
    const files = makeFiles();
    const k = key("put-upload.txt");

    const signed = await files.signedUploadUrl(k, {
      contentType: "text/plain",
      expiresIn: 120,
    });
    expect(signed.method).toBe("PUT");

    if (signed.method === "PUT") {
      const put = await fetch(signed.url, {
        body: "put-body",
        headers: signed.headers,
        method: "PUT",
      });
      expect(put.ok).toBe(true);
    }

    const got = await files.download(k);
    expect(await got.text()).toBe("put-body");
  });
});
