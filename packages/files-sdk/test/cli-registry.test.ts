import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import { loadFiles } from "../src/cli/loader.js";
import type { GlobalCliOptions } from "../src/cli/loader.js";
import { PROVIDER_NAMES, PROVIDERS } from "../src/cli/registry.js";

// Per-provider construction probes — drive each registry entry through
// loadFiles() with the minimum opts that lets the adapter construct without
// making a network call, and verify the returned adapter's `name`. This
// exercises every branch of registry.ts (which was at 13% function coverage
// before) and pins the CLI → registry → adapter wiring so a flag rename or
// factory-signature drift breaks loudly.

interface Case {
  opts: Omit<GlobalCliOptions, "provider">;
  /** Adapter's `name` field after a successful load. */
  expectedName: string;
}

const baseS3: Omit<GlobalCliOptions, "provider"> = {
  accessKeyId: "AKIATEST",
  bucket: "test-bucket",
  region: "us-east-1",
  secretAccessKey: "secret",
};

// An UploadThing token is base64(JSON({apiKey, appId})). Construct a valid
// shape so the adapter's token-decode path doesn't reject before we get to
// verify the wiring.
const uploadthingToken = Buffer.from(
  JSON.stringify({ apiKey: "sk_test", appId: "app_test" })
).toString("base64");

// Provider → (opts, expectedName). One entry per PROVIDER_NAMES key — the
// guard test below also asserts no keys are missing so adding a provider to
// the registry forces a coverage update here.
const cases: Record<string, Case> = {
  akamai: {
    expectedName: "akamai",
    opts: { ...baseS3, endpoint: "https://akamai.test" },
  },
  alibaba: { expectedName: "alibaba", opts: baseS3 },
  appwrite: {
    expectedName: "appwrite",
    opts: {
      configJson: {
        bucket: "files",
        endpoint: "https://appwrite.test/v1",
        projectId: "proj",
      },
    },
  },
  archil: {
    expectedName: "archil",
    opts: { ...baseS3, region: "aws-us-east-1" },
  },
  azure: {
    expectedName: "azure",
    // accountKey value is irrelevant — Azure validates shape, not auth.
    opts: {
      accountKey: "a2V5",
      accountName: "devstoreaccount1",
      container: "test",
    },
  },
  "backblaze-b2": { expectedName: "backblaze-b2", opts: baseS3 },
  box: {
    expectedName: "box",
    opts: { configJson: { developerToken: "tok" } },
  },
  "bunny-storage": {
    expectedName: "bunny-storage",
    opts: { configJson: { accessKey: "key", region: "de", zone: "test-zone" } },
  },
  cloudinary: {
    expectedName: "cloudinary",
    opts: { configJson: { cloudName: "demo" } },
  },
  "digitalocean-spaces": { expectedName: "digitalocean-spaces", opts: baseS3 },
  dropbox: { expectedName: "dropbox", opts: { token: "acc-tok" } },
  exoscale: { expectedName: "exoscale", opts: baseS3 },
  filebase: {
    expectedName: "filebase",
    // Filebase has no region requirement of its own (defaults to us-east-1).
    opts: { ...baseS3, region: undefined },
  },
  "firebase-storage": {
    expectedName: "firebase-storage",
    // The firebase-admin SDK doesn't validate credentials at construction;
    // a projectId + bucket are enough to drive initializeApp() to completion.
    opts: {
      bucket: "fb-test.firebasestorage.app",
      projectId: "fb-test",
    },
  },
  fs: { expectedName: "fs", opts: { root: "/tmp/files-sdk-registry-test" } },
  ftp: {
    expectedName: "ftp",
    opts: { configJson: { host: "localhost" } },
  },
  gcs: {
    expectedName: "gcs",
    // GCS construction calls into the storage SDK but doesn't validate
    // credentials at construction time; passing a projectId is enough.
    opts: { bucket: "gcs-bucket", projectId: "proj" },
  },
  "google-drive": {
    expectedName: "google-drive",
    opts: {
      configJson: {
        oauth: {
          clientId: "cid",
          clientSecret: "sec",
          refreshToken: "ref",
        },
      },
    },
  },
  hetzner: { expectedName: "hetzner", opts: baseS3 },
  "ibm-cos": { expectedName: "ibm-cos", opts: baseS3 },
  "idrive-e2": {
    expectedName: "idrive-e2",
    opts: { ...baseS3, endpoint: "https://idrive.test" },
  },
  minio: {
    expectedName: "minio",
    opts: { ...baseS3, endpoint: "http://localhost:9000" },
  },
  neon: {
    expectedName: "neon",
    // neon() requires an endpoint (or AWS_ENDPOINT_URL_S3); baseS3 has none.
    opts: { ...baseS3, endpoint: "https://br.storage.example.neon.tech" },
  },
  "netlify-blobs": {
    expectedName: "netlify-blobs",
    // Both siteId + token are required for explicit-auth mode; without both
    // the SDK falls back to ambient context detection which throws at
    // construction in test environments.
    opts: {
      siteId: "00000000-0000-0000-0000-000000000000",
      storeName: "store",
      token: "nfp_token",
    },
  },
  onedrive: {
    expectedName: "onedrive",
    opts: { configJson: { accessToken: "tok" } },
  },
  "oracle-cloud": {
    expectedName: "oracle-cloud",
    opts: { ...baseS3, configJson: { namespace: "ns" } },
  },
  ovhcloud: { expectedName: "ovhcloud", opts: baseS3 },
  pocketbase: {
    expectedName: "pocketbase",
    // The collection name must be threaded via --config-json; url is enough
    // to construct the underlying client without a network call.
    opts: {
      configJson: { collection: "files" },
      url: "http://pb.test",
    },
  },
  // The r2 factory routes to r2-http when no Workers binding is present.
  r2: {
    expectedName: "r2-http",
    opts: {
      accessKeyId: "AKIATEST",
      accountId: "acct-123",
      bucket: "test-bucket",
      secretAccessKey: "secret",
    },
  },
  s3: { expectedName: "s3", opts: baseS3 },
  scaleway: { expectedName: "scaleway", opts: baseS3 },
  sftp: {
    expectedName: "sftp",
    opts: { configJson: { host: "localhost", username: "user" } },
  },
  sharepoint: {
    expectedName: "sharepoint",
    opts: { configJson: { accessToken: "tok" } },
  },
  storj: {
    expectedName: "storj",
    opts: { ...baseS3, region: undefined },
  },
  supabase: {
    expectedName: "supabase",
    opts: {
      bucket: "files",
      serviceRoleKey: "service-role",
      url: "https://project.supabase.co",
    },
  },
  tencent: { expectedName: "tencent", opts: baseS3 },
  tigris: {
    expectedName: "tigris",
    opts: { ...baseS3, region: undefined },
  },
  uploadthing: {
    expectedName: "uploadthing",
    opts: { token: uploadthingToken },
  },
  "vercel-blob": {
    expectedName: "vercel-blob",
    opts: { token: "vercel_blob_rw_token" },
  },
  vultr: { expectedName: "vultr", opts: baseS3 },
  wasabi: { expectedName: "wasabi", opts: baseS3 },
  yandex: { expectedName: "yandex", opts: baseS3 },
};

describe("cli/registry load() per provider", () => {
  test("every PROVIDER_NAMES entry has a construction probe", () => {
    // Guard: if a new provider is added to the registry, this test fails
    // loudly so a probe gets added here too.
    const probed = Object.keys(cases).toSorted();
    expect(probed).toEqual([...PROVIDER_NAMES]);
  });

  for (const name of PROVIDER_NAMES) {
    const { opts, expectedName } = cases[name] as Case;
    test(`${name} loads end-to-end and returns an adapter named "${expectedName}"`, async () => {
      const result = await loadFiles({ provider: name, ...opts });
      expect(result.provider).toBe(name);
      expect(result.files.adapter.name).toBe(expectedName);
    });
  }
});

describe("cli/registry option merging", () => {
  test("typed flags win over --config-json on key conflict", async () => {
    // s3LikeOpts pulls `region` and `bucket` from typed fields; even when
    // the same keys are set in --config-json, the typed values should land
    // in the adapter.
    const result = await loadFiles({
      accessKeyId: "AKIATEST",
      bucket: "typed-bucket",
      configJson: { bucket: "extra-bucket", region: "us-west-2" },
      provider: "s3",
      region: "us-east-1",
      secretAccessKey: "secret",
    });
    // S3 adapter exposes `bucket` directly so we can verify which value won.
    const adapter = result.files.adapter as unknown as { bucket: string };
    expect(adapter.bucket).toBe("typed-bucket");
  });

  test("--config-json long-tail fields pass through to the adapter", async () => {
    // `forcePathStyle` is exposed as a typed flag, but adapter-specific
    // settings outside the typed flag set are only reachable via
    // --config-json. The merge path must thread `extra` into the factory
    // even when no typed value collides.
    const result = await loadFiles({
      accessKeyId: "AKIATEST",
      bucket: "test",
      configJson: { defaultProviderMessage: "Custom error label" },
      provider: "s3",
      region: "us-east-1",
      secretAccessKey: "secret",
    });
    // Construction succeeded — that's the wiring signal. The S3 adapter
    // doesn't surface defaultProviderMessage on its public type, but the
    // error-mapper would use it if a call failed.
    expect(result.files.adapter.name).toBe("s3");
  });

  test("flat --access-key-id reaches non-s3 S3 wrappers", async () => {
    // Regression: the registry used to wrap creds as `{credentials: {…}}`
    // only, which the wrapper adapters (vultr, wasabi, akamai, …) ignore
    // because they read flat `accessKeyId`/`secretAccessKey`. The wrappers
    // would then fall through to their env-var lookup and throw "missing
    // credentials" against a typed-flag CLI invocation. s3LikeOpts now
    // threads both forms.
    const prev = process.env.VULTR_ACCESS_KEY_ID;
    delete process.env.VULTR_ACCESS_KEY_ID;
    try {
      const result = await loadFiles({
        accessKeyId: "AKIATEST",
        bucket: "vultr-bucket",
        provider: "vultr",
        region: "ewr",
        secretAccessKey: "secret",
      });
      expect(result.files.adapter.name).toBe("vultr");
    } finally {
      if (prev !== undefined) {
        process.env.VULTR_ACCESS_KEY_ID = prev;
      }
    }
  });

  test("missing required field surfaces the adapter's own error", async () => {
    // `s3` requires a region. Without one (and no AWS_REGION env), the
    // adapter throws its own FilesError — registry should let it through
    // without rewriting because s3 has no `notes` to wrap with.
    const prev = {
      def: process.env.AWS_DEFAULT_REGION,
      region: process.env.AWS_REGION,
    };
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      await expect(
        loadFiles({
          accessKeyId: "AKIATEST",
          bucket: "test",
          provider: "s3",
          secretAccessKey: "secret",
        })
      ).rejects.toThrow(/missing region/iu);
    } finally {
      if (prev.region !== undefined) {
        process.env.AWS_REGION = prev.region;
      }
      if (prev.def !== undefined) {
        process.env.AWS_DEFAULT_REGION = prev.def;
      }
    }
  });

  test("OAuth provider errors get wrapped with the registry's notes hint", async () => {
    // Loader's error-wrap branch: when a provider with `notes` throws at
    // construction, the loader re-throws a FilesError that combines the
    // adapter's message with the hint. This is the path that explains to
    // a user calling `--provider box` (no auth) where to plug credentials.
    let caught: unknown;
    try {
      await loadFiles({ configJson: {}, provider: "box" });
    } catch (error) {
      caught = error;
    }
    const message = (caught as Error | undefined)?.message ?? "";
    // The adapter's own missing-auth message …
    expect(message).toMatch(/missing auth/iu);
    // … plus the registry's hint, joined with "hint:".
    expect(message).toMatch(/hint:/iu);
    // … which mentions the OAuth concept so it's actionable.
    expect(message).toMatch(/oauth/iu);
  });
});

describe("cli/registry metadata", () => {
  test("OAuth-only providers carry a `notes` hint", () => {
    // The CLI surfaces `notes` in --help and the loader wraps adapter errors
    // with it when load() fails. The OAuth-only providers all rely on it
    // because their config doesn't fit the typed flag set.
    for (const name of [
      "appwrite",
      "box",
      "cloudinary",
      "dropbox",
      "google-drive",
      "onedrive",
      "sharepoint",
      "uploadthing",
    ]) {
      const entry = PROVIDERS[name];
      expect(entry?.notes).toBeDefined();
      expect(typeof entry?.notes).toBe("string");
      expect(entry?.notes?.length).toBeGreaterThan(0);
    }
  });

  test("flag-driven providers list their required flags", () => {
    // `required` is the list rendered into --help; verify a sample of
    // S3-derived providers declare the flags their adapter actually needs.
    expect(PROVIDERS.s3?.required).toContain("--bucket");
    expect(PROVIDERS.minio?.required).toContain("--endpoint");
    expect(PROVIDERS.scaleway?.required).toContain("--region");
    expect(PROVIDERS.fs?.required).toContain("--root");
    expect(PROVIDERS.azure?.required).toContain("--container");
    expect(PROVIDERS["netlify-blobs"]?.required).toContain("--store-name");
  });

  test("OAuth-only providers have an empty `required` list", () => {
    // Required flags don't apply when config comes via --config-json; the
    // notes string carries the guidance instead.
    for (const name of ["box", "cloudinary", "google-drive", "onedrive"]) {
      expect(PROVIDERS[name]?.required).toEqual([]);
    }
  });
});
