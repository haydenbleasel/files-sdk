# Adapter setup

Construction snippets and the non-obvious knobs for the most common adapters. The catalog at <https://files-sdk.dev> is the canonical list — this page covers the ones users ask about most often.

## S3 — `files-sdk/s3`

```ts
import { s3 } from "files-sdk/s3";

const adapter = s3({
  bucket: "uploads",
  region: "us-east-1", // optional; AWS SDK falls back to AWS_REGION
  // credentials: { accessKeyId, secretAccessKey, sessionToken? }, // optional; ADC otherwise
  // endpoint, forcePathStyle,                                     // for self-hosted/S3-compatible
  // publicBaseUrl: "https://cdn.example.com",                     // skip signing on url()
  // defaultUrlExpiresIn: 3600,
});
```

Gotchas:

- No `credentials`? The AWS SDK's default credential chain (env, shared config, EC2/ECS/EKS metadata) runs. That's usually what you want in production.
- `publicBaseUrl` flips `url()` to return `${publicBaseUrl}/${key}` and skips signing — set this when you've put CloudFront in front of the bucket.
- Passing `responseContentDisposition` always forces signing, even with `publicBaseUrl` set, because permanent CDN URLs have no signature to bind the override to.

## Cloudflare R2 — `files-sdk/r2`

Two modes, picked by which options you pass.

### HTTP (works anywhere)

```ts
import { r2 } from "files-sdk/r2";

const adapter = r2({
  bucket: "uploads",
  accountId: process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  // publicBaseUrl: "https://uploads.example.com",
});
```

### Binding (inside a Worker)

```ts
const adapter = r2({
  binding: env.UPLOADS, // R2Bucket binding from wrangler.toml
  publicBaseUrl: "https://uploads.example.com", // required for url() unless hybrid mode
});
```

### Hybrid (binding + HTTP creds)

```ts
const adapter = r2({
  binding: env.UPLOADS,
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
});
```

Reads/writes still go through the binding (no egress fees, no extra round trip). `url()` and `signedUploadUrl()` fall back to the S3-compatible HTTP signer instead of throwing.

Gotchas:

- Binding-only with no `publicBaseUrl` and no HTTP creds → `url()` throws. There's no signing primitive available to a binding.
- The HTTP adapter is loaded via dynamic import so a binding-only Worker bundle doesn't pull in `@aws-sdk/client-s3` (~500 KB+).

## Vercel Blob — `files-sdk/vercel-blob`

```ts
import { vercelBlob } from "files-sdk/vercel-blob";

const adapter = vercelBlob({
  token: process.env.BLOB_READ_WRITE_TOKEN, // optional; defaults to env
  access: "public", // or "private" — fixed at construction
  addRandomSuffix: false, // default false (predictable keys, S3-style)
  allowOverwrite: true, // default true so predictable keys actually work
});
```

Two important non-defaults to know about:

- **`access` is fixed at construction.** A single `Files` instance is unambiguously public or private. Need both? Instantiate two adapters.
- **`access: "private"` makes `url()` throw.** Private blobs have no permanent public URL. Use `download()` instead. `signedUploadUrl` does still work.
- **`allowOverwrite: true` is the default** so `addRandomSuffix: false` works at all — Vercel rejects same-pathname uploads otherwise. If you want create-only semantics, set `allowOverwrite: false` and handle the resulting `Conflict`.

## Google Cloud Storage — `files-sdk/gcs`

```ts
import { gcs } from "files-sdk/gcs";

const adapter = gcs({
  bucket: "uploads",
  // projectId: "...",                            // falls back to GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT
  // keyFilename: "./service-account.json",       // OR
  // credentials: { client_email, private_key },  // inline for Vercel/Netlify
  // publicBaseUrl: "https://storage.googleapis.com/uploads",
});
```

Notes:

- With none of `keyFilename` / `credentials` / env, falls back to Application Default Credentials (`gcloud auth`, GCE metadata, etc.).
- `url()` produces V4 signed read URLs by default; GCS caps `expiresIn` at 7 days.

## Azure Blob Storage — `files-sdk/azure`

```ts
import { azure } from "files-sdk/azure";
import { DefaultAzureCredential } from "@azure/identity";

const adapter = azure({
  container: "uploads", // (Azure calls it "container", surfaced as bucket)
  // Highest precedence:
  // connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
  // Or:
  accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME,
  accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY,
  // Or for Azure AD / Managed Identity:
  // accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME,
  // credential: new DefaultAzureCredential(),
  // sasToken: "?sv=...&sig=...",                // alternative to accountKey
  // endpoint: "http://127.0.0.1:10000/devstoreaccount1", // Azurite / sovereign clouds
  // publicBaseUrl: "https://uploads.azureedge.net",
});
```

Notes:

- A SAS-token-only adapter (no `accountKey`) **cannot mint new SAS** — `url()` and `signedUploadUrl()` throw `Provider`. Reads/writes/list still work as long as the SAS has those permissions.
- A `credential` adapter uses Azure AD / Managed Identity for SDK calls and mints User Delegation SAS URLs for `url()` and `signedUploadUrl()`. The principal needs blob data permissions plus permission to call `generateUserDelegationKey`.
- `connectionString` is the highest-precedence credential source.

## MinIO — `files-sdk/minio`

```ts
import { minio } from "files-sdk/minio";

const adapter = minio({
  bucket: "uploads",
  endpoint: "http://localhost:9000",
  accessKeyId: process.env.MINIO_ACCESS_KEY_ID,
  secretAccessKey: process.env.MINIO_SECRET_ACCESS_KEY,
});
```

Thin wrapper over `s3()` with MinIO-friendly defaults: `forcePathStyle: true`, region default, error messages relabeled `"MinIO error"`. `endpoint` is required. Other S3-compatible stores (DigitalOcean Spaces, Wasabi, Backblaze B2, Tigris, Storj, Hetzner, etc.) follow the same wrapper pattern with provider-specific defaults.

## Local filesystem — `files-sdk/fs`

```ts
import { fs } from "files-sdk/fs";

const adapter = fs({
  root: "./tmp/uploads",
  // urlBaseUrl: "http://localhost:3000/uploads", // when a dev server fronts the same root
});
```

Notes:

- Paths that resolve outside `root` (e.g. `../etc/passwd`) throw `Provider`.
- Without `urlBaseUrl`, `url()` returns a `file://` URL — fine for CLIs/tests, not for browsers.
- `signedUploadUrl()` returns a URL with `?expires=...` for parity with the cloud adapters; the fs adapter itself does not enforce the expiry — your dev upload handler is expected to validate it.

## The shape every adapter shares

Every adapter exports a factory that returns an `Adapter` satisfying the `Adapter` interface in `packages/files-sdk/src/index.ts`. As long as it satisfies that interface, the `Files` API works identically. When in doubt about a less-common adapter, read its `index.ts` — they're all small.
