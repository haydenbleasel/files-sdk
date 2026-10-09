import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bunS3 } from "../src/bun-s3/index.js";
import { PROVIDERS as CLI_PROVIDERS } from "../src/cli/registry.js";
import type { ProviderOpts } from "../src/cli/registry.js";
import { convex } from "../src/convex/index.js";
import { Files } from "../src/index.js";
import type { Adapter } from "../src/index.js";
import { memory } from "../src/memory/index.js";
import { PROVIDER_NAMES } from "../src/providers/index.js";

// The adapter comparison table on the docs site (/docs/adapters) reads
// apps/web/lib/adapter-capabilities.json. This builds every adapter offline
// with placeholder credentials, reads `files.capabilities`, and checks the
// committed file still matches, so the table can't drift from the adapters.
// After changing an adapter's capability flags, regenerate it:
//
//   WRITE_ADAPTER_CAPABILITIES=1 bun test adapter-capabilities
const SNAPSHOT_PATH = path.join(
  import.meta.dir,
  "../../../apps/web/lib/adapter-capabilities.json"
);

const S3_OPTS: ProviderOpts = {
  accessKeyId: "AKIAEXAMPLEEXAMPLE00",
  bucket: "bucket",
  region: "us-east-1",
  secretAccessKey: "example-secret-access-key-0000000000000",
};

// firebase-admin parses the service-account key when the app is created.
const { privateKey: PLACEHOLDER_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

// Placeholder construction options for the adapters that need more than the
// S3-style defaults, in the CLI registry's flat option shape.
const PROVIDER_OPTS = new Map<string, ProviderOpts>([
  ["akamai", { ...S3_OPTS, region: "us-east-1" }],
  [
    "appwrite",
    {
      extra: {
        apiKey: "key",
        bucketId: "bucket",
        endpoint: "https://cloud.appwrite.io/v1",
        projectId: "project",
      },
    },
  ],
  [
    "azure",
    {
      accountKey: "ZXhhbXBsZQ==",
      accountName: "account",
      container: "container",
    },
  ],
  ["box", { extra: { developerToken: "token" } }],
  [
    "bunny-storage",
    { extra: { accessKey: "key", region: "de", zone: "zone" } },
  ],
  [
    "cloudinary",
    { extra: { apiKey: "key", apiSecret: "secret", cloudName: "cloud" } },
  ],
  ["dropbox", { extra: { accessToken: "token" } }],
  [
    "firebase-storage",
    {
      bucket: "bucket.appspot.com",
      extra: {
        credentials: {
          clientEmail: "a@b.iam.gserviceaccount.com",
          privateKey: PLACEHOLDER_PRIVATE_KEY,
        },
        projectId: "project",
      },
    },
  ],
  ["fs", {}],
  ["ftp", { extra: { host: "ftp.example.com" } }],
  ["gcs", { bucket: "bucket", projectId: "project" }],
  [
    "google-drive",
    {
      extra: {
        credentials: {
          client_email: "a@b.iam.gserviceaccount.com",
          private_key: "key",
        },
      },
    },
  ],
  ["idrive-e2", { ...S3_OPTS, endpoint: "https://e2.example.com" }],
  ["minio", { ...S3_OPTS, endpoint: "http://localhost:9000" }],
  ["neon", { ...S3_OPTS, endpoint: "https://storage.example.com" }],
  [
    "netlify-blobs",
    { extra: { siteID: "site", token: "token" }, storeName: "store" },
  ],
  ["onedrive", { extra: { accessToken: "token", driveId: "drive" } }],
  ["r2", { ...S3_OPTS, accountId: "0123456789abcdef0123456789abcdef" }],
  ["rustfs", { ...S3_OPTS, endpoint: "http://localhost:9000" }],
  ["s3-fetch", { ...S3_OPTS, endpoint: "https://s3.us-east-1.amazonaws.com" }],
  ["oracle-cloud", { ...S3_OPTS, extra: { namespace: "namespace" } }],
  [
    "pocketbase",
    {
      extra: { authToken: "token", collection: "files" },
      url: "https://pocketbase.example.com",
    },
  ],
  [
    "sftp",
    {
      extra: {
        host: "sftp.example.com",
        password: "password",
        username: "user",
      },
    },
  ],
  ["sharepoint", { extra: { accessToken: "token", driveId: "drive" } }],
  [
    "supabase",
    {
      bucket: "bucket",
      serviceRoleKey: "key",
      url: "https://project.supabase.co",
    },
  ],
  [
    "uploadthing",
    {
      token: btoa(
        JSON.stringify({
          apiKey: "sk_live_example",
          appId: "app",
          regions: ["sea1"],
        })
      ),
    },
  ],
  ["vercel-blob", { token: "vercel_blob_rw_examplestore_random" }],
  [
    "webdav",
    {
      extra: {
        baseUrl: "https://dav.example.com",
        password: "password",
        username: "user",
      },
    },
  ],
]);

// Adapters the CLI can't construct, built directly.
const DIRECT = new Map<string, () => Adapter>([
  [
    "bun-s3",
    () => bunS3({ ...S3_OPTS, endpoint: "https://s3.us-east-1.amazonaws.com" }),
  ],
  [
    "convex",
    () =>
      convex({
        ctx: {
          storage: {
            delete: () => Promise.resolve(),
            getUrl: () => Promise.resolve(null),
            store: () => Promise.resolve("id"),
          },
        } as never,
      }),
  ],
  ["memory", () => memory()],
]);

const loadAdapter = (slug: string, root: string): Promise<Adapter> => {
  const direct = DIRECT.get(slug);
  if (direct) {
    return Promise.resolve(direct());
  }
  const registration = CLI_PROVIDERS[slug];
  if (!registration) {
    throw new Error(`no way to construct the "${slug}" adapter`);
  }
  const opts = PROVIDER_OPTS.get(slug) ?? S3_OPTS;
  return registration.load(slug === "fs" ? { root } : opts);
};

/** What the comparison table shows for one adapter, with default options. */
const snapshotOf = (adapter: Adapter) => {
  const caps = new Files({ adapter }).capabilities;
  return {
    cacheControl: caps.cacheControl,
    conditional: {
      create: caps.conditional.create,
      delete: caps.conditional.delete,
      replace: caps.conditional.replace,
    },
    delimiter: caps.delimiter,
    metadata: caps.metadata,
    rangeRead: caps.rangeRead,
    resumable: caps.multipart,
    serverSideCopy: caps.serverSideCopy,
    signedUrl: caps.signedUrl.supported
      ? { maxExpiresIn: caps.signedUrl.maxExpiresIn ?? null }
      : null,
    uploadProgress: caps.uploadProgress,
  };
};

describe("adapter capabilities snapshot (docs comparison table)", () => {
  test("matches apps/web/lib/adapter-capabilities.json", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "files-sdk-caps-"));
    const settled = await Promise.allSettled(
      PROVIDER_NAMES.map(
        async (slug) =>
          [slug, snapshotOf(await loadAdapter(slug, root))] as const
      )
    );
    const failures = settled.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${PROVIDER_NAMES[index]}: ${String(result.reason)}`]
        : []
    );
    expect(failures).toEqual([]);
    const entries = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    const json = `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
    if (process.env.WRITE_ADAPTER_CAPABILITIES) {
      writeFileSync(SNAPSHOT_PATH, json);
    }
    expect(readFileSync(SNAPSHOT_PATH, "utf-8")).toBe(json);
  });
});
