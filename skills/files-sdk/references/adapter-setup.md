# Adapter setup

Construction snippets and the non-obvious knobs for the most common adapters. The catalog at <https://files-sdk.dev> is the canonical list — this page covers the ones users ask about most often.

## S3 — `files-sdk/s3`

```ts
import { s3 } from "files-sdk/s3";

const adapter = s3({
  bucket: "uploads",
  region: "us-east-1", // optional; falls back to AWS_REGION / AWS_DEFAULT_REGION
  // credentials: { accessKeyId, secretAccessKey, sessionToken? }, // optional; AWS default chain otherwise
  // endpoint, forcePathStyle,                                     // for self-hosted/S3-compatible
  // publicBaseUrl: "https://cdn.example.com",                     // plain url(key) returns the CDN link
  // defaultUrlExpiresIn: 3600,
});
```

Gotchas:

- No `credentials`? The AWS SDK's default credential chain (env, shared config, EC2/ECS/EKS metadata) runs. That's usually what you want in production.
- `publicBaseUrl` flips a plain `url(key)` to return `${publicBaseUrl}/${key}` without signing — set this when you've put CloudFront in front of the bucket.
- Passing `expiresIn` or `responseContentDisposition` always forces signing, even with `publicBaseUrl` set, because a permanent CDN URL can't expire and has no signature to bind the override to.

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

- Binding-only with no `publicBaseUrl` and no HTTP creds → `url()` throws `Unsupported`. There's no signing primitive available to a binding. With a `publicBaseUrl`, a plain `url(key)` returns the permanent link, but `url(key, { expiresIn })` still throws `Unsupported` — add HTTP creds (hybrid mode) to sign.
- The `"aws-sdk"` engine is loaded lazily, so a binding-only or fetch-engine Worker builds with `files-sdk` alone: Wrangler leaves the `@aws-sdk/*` imports unresolved when the packages aren't installed. If they _are_ installed (including hoisted in a monorepo), Wrangler bundles them (~900 KiB) even though they never run, so keep them out of such a Worker. On files-sdk ≤2.6.2 a missing `@aws-sdk/*` package failed `wrangler deploy` with `Could not resolve "@aws-sdk/client-s3"`; upgrade (or alias the four packages to a stub). With `client: "aws-sdk"` and the packages missing, the first call rejects with a `FilesError` naming them.
- HTTP mode has two engines: `client: "aws-sdk"` (full surface, needs the `@aws-sdk/*` peers) and `client: "fetch"` (SigV4 `fetch` via aws4fetch, no AWS SDK; no multipart/resumable uploads, bulk deletes fan out per key). Inside Cloudflare Workers it defaults to `"fetch"`.

## Vercel Blob — `files-sdk/vercel-blob`

```ts
import { vercelBlob } from "files-sdk/vercel-blob";

const adapter = vercelBlob({
  // Credentials are optional — the adapter resolves them on every call, in
  // the same order the upstream SDK does:
  //   1. explicit `token` (RW or client token) — always wins
  //   2. `oidcToken` option + `storeId` (option or `BLOB_STORE_ID`)
  //   3. an OIDC token @vercel/blob finds itself (the request's
  //      x-vercel-oidc-token header, then VERCEL_OIDC_TOKEN), paired with
  //      `storeId` (option or `BLOB_STORE_ID`)
  //   4. `BLOB_READ_WRITE_TOKEN` env — only when no OIDC token turns up
  // token: process.env.BLOB_READ_WRITE_TOKEN,
  // oidcToken: loadOidcToken(),
  // storeId: loadStoreId(),
  access: "public", // or "private" — fixed at construction
  addRandomSuffix: false, // default false (predictable keys, S3-style)
  allowOverwrite: true, // default true so predictable keys actually work
});
```

A few things to know:

- **OIDC is preferred on Vercel.** When the Blob store is connected to a project, the deployment gets `BLOB_STORE_ID` and a short-lived, auto-rotated OIDC token. On Vercel Functions that token arrives per request (`x-vercel-oidc-token` header), not in `process.env`, so the adapter passes just the store id and lets `@vercel/blob` read the token on each call — a module-scope `vercelBlob()` needs no options and no `BLOB_READ_WRITE_TOKEN`, and if the project has one anyway, the request's OIDC token still wins. Locally, `vercel env pull` writes `VERCEL_OIDC_TOKEN` and `BLOB_STORE_ID` (12-hour token; `@vercel/blob` ≥ 2.5 refreshes it in a `vercel link`ed project). Off Vercel, use `BLOB_READ_WRITE_TOKEN`.
- **`missing credentials` can come from the first call.** Construction throws it only when there's no store id and no RW token. With just a store id, the adapter can't know whether a token will arrive, so the first operation that finds none throws the same `FilesError` (`permanent`, `@vercel/blob`'s error as `cause`).
- **Pass `oidcToken` / `storeId` explicitly** when your framework doesn't load `.env.local` into `process.env` (Vite, etc.). Otherwise the adapter silently falls back to `BLOB_READ_WRITE_TOKEN` (or throws if no RW token is set either). A passed `oidcToken` is used as given, never refreshed.
- **Explicit `token` always wins** over OIDC env vars, mirroring the SDK. Set it only when you actually want to override.
- **`access` is fixed at construction.** A single `Files` instance is unambiguously public or private. Need both? Instantiate two adapters.
- **`access: "private"` makes `url()` presign.** Private blobs have no permanent public URL, so `url()` returns a presigned `GET` scoped to that key that expires after `expiresIn` (default 3600 via `defaultUrlExpiresIn`; Vercel caps it at 7 days). `responseContentDisposition` still throws `Unsupported` (Vercel URLs can't carry it), and range downloads aren't available in private mode. `signedUploadUrl` works in both modes.
- **Public blobs can't expire.** In `access: "public"` mode, `url(key)` returns the permanent CDN URL and `url(key, { expiresIn })` throws `Unsupported`. Drop `expiresIn`, or use a private adapter for expiring links.
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

- A SAS-token-only adapter (no `accountKey`) **cannot mint new SAS** — `url()` and `signedUploadUrl()` throw `Unsupported`. Reads/writes/list still work as long as the SAS has those permissions.
- A `credential` adapter uses Azure AD / Managed Identity for SDK calls and mints User Delegation SAS URLs for `url()` and `signedUploadUrl()`. The principal needs blob data permissions plus permission to call `generateUserDelegationKey`.
- `connectionString` is the highest-precedence credential source.
- Azurite: `@azure/storage-blob` 12.34+ sends service version `2026-10-06`, newer than Azurite 3.37.0 accepts. Start Azurite with `--skipApiVersionCheck`.

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

Thin wrapper over `s3()` with MinIO-friendly defaults: `forcePathStyle: true`, region default, error messages relabeled `"MinIO error"`. `endpoint` is required. **`files-sdk/rustfs`** (`rustfs()`) is the same shape for RustFS servers, with `RUSTFS_ACCESS_KEY_ID` / `RUSTFS_SECRET_ACCESS_KEY` env fallbacks (and the server's own `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY`). Other S3-compatible stores (DigitalOcean Spaces, Wasabi, Backblaze B2, Tigris, Storj, Hetzner, etc.) follow the same wrapper pattern with provider-specific defaults.

**No AWS SDK / Cloudflare Workers:** `r2()`, `minio()`, and `rustfs()` accept `client: "fetch"` to swap `@aws-sdk/client-s3` for a SigV4 `fetch` engine (aws4fetch), and default to it inside Workers. For any other S3-compatible endpoint, use `s3Fetch()` from **`files-sdk/s3-fetch`** (static credentials only, `forcePathStyle: true` for MinIO-style hosts). The fetch engine covers upload, download (+ ranges), head, list (+ delimiter), copy, `url()`, and `signedUploadUrl()`; `multipart`/`control` uploads throw and `ReadableStream` bodies are buffered. The other S3 wrappers always use the AWS SDK.

## Local filesystem — `files-sdk/fs`

```ts
import { fs } from "files-sdk/fs";

const adapter = fs({
  root: "./tmp/uploads",
  // urlBaseUrl: "http://localhost:3000/uploads", // when a dev server fronts the same root
});
```

Notes:

- Paths that resolve outside `root` (e.g. `../etc/passwd`) throw `Invalid`.
- Without `urlBaseUrl`, `url()` returns a `file://` URL — fine for CLIs/tests, not for browsers. Either way the link is permanent, so `url(key, { expiresIn })` throws `Unsupported`.
- `signedUploadUrl()` throws `Unsupported` — the fs adapter has no upload server or signer to enforce expiry, size, or content type. Upload through `files.upload()` or your own route.

## The shape every adapter shares

Every adapter exports a factory that returns an `Adapter` satisfying the `Adapter` interface (declared in `node_modules/files-sdk/dist/index.d.ts`). As long as it satisfies that interface, the `Files` API works identically. When in doubt about a less-common adapter, read its options JSDoc in `node_modules/files-sdk/dist/<adapter>/index.d.ts` or its page under the bundled `docs/adapters/`, and check `files.capabilities` at runtime.
