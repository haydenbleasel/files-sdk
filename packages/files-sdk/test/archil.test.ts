import { describe, expect, test } from "bun:test";

import type { S3Client } from "@aws-sdk/client-s3";
import type { Disk } from "disk";

import { archil } from "../src/archil/index.js";

const creds = { accessKeyId: "AKID", secretAccessKey: "SECRET" };

describe("archil adapter", () => {
  test("derives the endpoint and signing region from the Archil region", async () => {
    const adapter = archil({
      bucket: "dsk-abc",
      region: "aws-us-east-1",
      ...creds,
    });
    expect(adapter.name).toBe("archil");
    expect(adapter.diskId).toBe("dsk-abc");
    const client = adapter.raw as S3Client;
    expect(await client.config.region()).toBe("us-east-1");
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("s3.green.us-east-1.aws.prod.archil.com");
    // Path-style: the disk id is the bucket, so virtual-hosted would misroute.
    expect(await client.config.forcePathStyle).toBe(true);
  });

  test("applies the gcp-us-central1 endpoint override", async () => {
    const adapter = archil({
      bucket: "dsk-abc",
      region: "gcp-us-central1",
      ...creds,
    });
    const client = adapter.raw as S3Client;
    const endpoint = await client.config.endpoint?.();
    expect(endpoint?.hostname).toBe("s3.blue.us-central1.gcp.prod.archil.com");
    expect(await client.config.region()).toBe("us-central1");
  });

  test("branch scopes the bucket to <diskId>.<branch> across the surface", async () => {
    const adapter = archil({
      branch: "feature-x",
      bucket: "dsk-abc",
      region: "aws-us-east-1",
      ...creds,
    });
    expect(adapter.branch).toBe("feature-x");
    expect(adapter.diskId).toBe("dsk-abc");
    const url = new URL(await adapter.url("data.json"));
    expect(url.pathname).toBe("/dsk-abc.feature-x/data.json");
  });

  test("infers bucket + region from a Disk instance, exposed at adapter.disk", () => {
    const disk = { id: "dsk-xyz", region: "aws-us-west-2" } as unknown as Disk;
    const adapter = archil({ disk, ...creds });
    expect(adapter.diskId).toBe("dsk-xyz");
    expect(adapter.disk).toBe(disk);
  });

  test("does not expose adapter.disk when constructed from a bucket id", () => {
    const adapter = archil({
      bucket: "dsk-abc",
      region: "aws-us-east-1",
      ...creds,
    });
    expect(adapter.disk).toBeUndefined();
  });

  test("rejects unknown region, missing region, invalid branch, and missing bucket", () => {
    expect(() =>
      archil({ bucket: "dsk-abc", region: "useast1", ...creds })
    ).toThrow("unknown region");
    // Empty string is falsy, so it trips the missing-region guard before the
    // shape check — no ARCHIL_REGION env juggling needed.
    expect(() => archil({ bucket: "dsk-abc", region: "", ...creds })).toThrow(
      "missing `region`"
    );
    expect(() =>
      archil({
        branch: "a/b",
        bucket: "dsk-abc",
        region: "aws-us-east-1",
        ...creds,
      })
    ).toThrow("invalid branch");
    expect(() => archil({ region: "aws-us-east-1", ...creds })).toThrow(
      "missing `bucket`"
    );
  });

  test("missing credentials throws at construction", () => {
    const oldKey = process.env.ARCHIL_S3_ACCESS_KEY_ID;
    const oldSecret = process.env.ARCHIL_S3_SECRET_ACCESS_KEY;
    delete process.env.ARCHIL_S3_ACCESS_KEY_ID;
    delete process.env.ARCHIL_S3_SECRET_ACCESS_KEY;
    try {
      expect(() =>
        archil({ bucket: "dsk-abc", region: "aws-us-east-1" })
      ).toThrow("missing credentials");
    } finally {
      if (oldKey === undefined) {
        delete process.env.ARCHIL_S3_ACCESS_KEY_ID;
      } else {
        process.env.ARCHIL_S3_ACCESS_KEY_ID = oldKey;
      }
      if (oldSecret === undefined) {
        delete process.env.ARCHIL_S3_SECRET_ACCESS_KEY;
      } else {
        process.env.ARCHIL_S3_SECRET_ACCESS_KEY = oldSecret;
      }
    }
  });
});
