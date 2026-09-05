import { afterEach, describe, expect, test } from "bun:test";

import { FilesError } from "../src/index.js";
import { s3Fetch } from "../src/s3-fetch/index.js";

// The public `files-sdk/s3-fetch` entry — a thin, env-aware wrapper over the
// engine tested exhaustively in s3-fetch.test.ts. These pin the wrapper's own
// behavior: option threading, env fallbacks, fail-closed construction.

const ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const clearEnv = () => {
  for (const key of ENV_KEYS) {
    // oxlint-disable-next-line no-dynamic-delete
    delete process.env[key];
  }
};

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      // oxlint-disable-next-line no-dynamic-delete
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const base = {
  accessKeyId: "K",
  bucket: "uploads",
  endpoint: "https://s3.us-east-1.amazonaws.com",
  secretAccessKey: "S",
};

describe("s3Fetch()", () => {
  test("constructs the SigV4 fetch engine under the s3-fetch name", async () => {
    clearEnv();
    const adapter = s3Fetch({ ...base, region: "us-east-1" });
    expect(adapter.name).toBe("s3-fetch");
    expect(adapter.bucket).toBe("uploads");
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Credential=K");
    expect(url).toContain("us-east-1");
    expect(url).toMatch(/^https:\/\/uploads\.s3\.us-east-1\.amazonaws\.com\//u);
  });

  test("threads forcePathStyle, publicBaseUrl, defaultUrlExpiresIn, sessionToken, and fetch", async () => {
    clearEnv();
    const seen: Request[] = [];
    const adapter = s3Fetch({
      ...base,
      defaultUrlExpiresIn: 60,
      fetch: (request) => {
        seen.push(request);
        return Promise.resolve(new Response(null, { status: 204 }));
      },
      forcePathStyle: true,
      publicBaseUrl: "https://cdn.example.com",
      sessionToken: "TOKEN",
    });
    expect(await adapter.url("a.txt")).toBe("https://cdn.example.com/a.txt");
    await adapter.delete("a.txt");
    expect(seen[0]?.url).toBe(
      "https://s3.us-east-1.amazonaws.com/uploads/a.txt"
    );
    expect(seen[0]?.headers.get("x-amz-security-token")).toBe("TOKEN");
  });

  test("falls back to AWS_* env vars for credentials, session token, and region", async () => {
    clearEnv();
    process.env.AWS_ACCESS_KEY_ID = "ENVKEY";
    process.env.AWS_SECRET_ACCESS_KEY = "ENVSECRET";
    process.env.AWS_SESSION_TOKEN = "ENVTOKEN";
    process.env.AWS_DEFAULT_REGION = "eu-west-1";
    const adapter = s3Fetch({
      bucket: "uploads",
      endpoint: "https://s3.eu-west-1.amazonaws.com",
    });
    const url = await adapter.url("a.txt");
    expect(url).toContain("X-Amz-Credential=ENVKEY");
    expect(url).toContain("eu-west-1");
    expect(url).toContain("X-Amz-Security-Token=ENVTOKEN");
  });

  test("AWS_REGION wins over AWS_DEFAULT_REGION", async () => {
    clearEnv();
    process.env.AWS_REGION = "ap-southeast-2";
    process.env.AWS_DEFAULT_REGION = "eu-west-1";
    const adapter = s3Fetch(base);
    expect(await adapter.url("a.txt")).toContain("ap-southeast-2");
  });

  test("throws a Provider error when endpoint is missing", () => {
    clearEnv();
    expect(() => s3Fetch({ ...base, endpoint: "" })).toThrow(FilesError);
    expect(() => s3Fetch({ ...base, endpoint: "" })).toThrow(
      /missing endpoint/u
    );
  });

  test("throws a Provider error when credentials are missing (no credential chain)", () => {
    clearEnv();
    expect(() =>
      s3Fetch({ bucket: "uploads", endpoint: base.endpoint })
    ).toThrow(/missing credentials/u);
    expect(() =>
      s3Fetch({ accessKeyId: "K", bucket: "uploads", endpoint: base.endpoint })
    ).toThrow(/no credential chain/u);
  });
});
