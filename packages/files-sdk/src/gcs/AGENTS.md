# AGENTS.md — `files-sdk/gcs`

Guidance for coding agents working inside the `gcs` adapter. Every
adapter in files-sdk implements the unified `Adapter<Raw>` contract from
[`../index.ts`](../index.ts) — call shapes, `FilesError` codes,
`UrlOptions`, `SignUploadOptions`, body normalization. This file
documents only gcs-specific deviations. For the package-wide surface,
[`../../README.md`](../../README.md) and the skill at
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md)
are the sources of truth — read them first.

Unlike the ~20 S3-compatible adapters that wrap [`../s3/index.ts`](../s3/index.ts)
with provider-friendly defaults, **`gcs` is a primary native adapter**
built directly on
[`@google-cloud/storage`](https://www.npmjs.com/package/@google-cloud/storage)'s
`Storage` → `bucket(name)` → `file(key)` chain. It does **not** share
the S3 adapter's error-mapping table or signing primitives.

## Overview

Google Cloud Storage via the official `@google-cloud/storage` SDK.
Family: **native adapter, GCS JSON API**. The full unified surface is
implemented directly against per-file primitives: `file.save()`,
`file.download()`, `file.createReadStream()` / `createWriteStream()`,
`file.getMetadata()`, `file.exists()`, `file.delete()`, `file.copy()`,
`bucket.getFiles()`, `file.getSignedUrl({ version: "v4" })`, and
`file.generateSignedPostPolicyV4()` for presigned upload forms.

Peer dependencies (both optional in [`../../package.json`](../../package.json)):

- `@google-cloud/storage` — direct import in [`./index.ts`](./index.ts);
  missing it throws `ERR_MODULE_NOT_FOUND` at module load.
- `google-auth-library` — transitive peer used by `@google-cloud/storage`
  for credential resolution. [`../../README.md`](../../README.md)
  bundles both into
  `npm install files-sdk @google-cloud/storage google-auth-library`.

## Directory layout

```text
packages/files-sdk/src/gcs/
├── index.ts                # adapter + GCSAdapterOptions + mapGCSError
├── AGENTS.md               # this file
└── CLAUDE.md               # `@AGENTS.md`
```

Sibling files: tests at
[`../../test/gcs.test.ts`](../../test/gcs.test.ts); user docs at
[`../../../../apps/web/content/docs/adapters/gcs.mdx`](../../../../apps/web/content/docs/adapters/gcs.mdx);
provider catalog entry (search `slug: "gcs"`) in
[`../providers/index.ts`](../providers/index.ts).

## Build, test, typecheck

```bash
# from packages/files-sdk/
bun test test/gcs.test.ts            # this adapter only
bun test                             # full SDK suite
bun run build                        # tsup ESM bundle -> dist/gcs/index.js
bun run types                        # tsgo --noEmit
```

This package uses **`bun test`** (not vitest) and **`tsgo`** (not
`tsc`). The per-subpath bundle output is `dist/gcs/index.{js,d.ts}` per
the `exports` map in [`../../package.json`](../../package.json); keep
it in sync if the file layout changes.

## Public surface

Defined in [`./index.ts`](./index.ts):

- `gcs(opts: GCSAdapterOptions): GCSAdapter` — primary factory.
- `GCSAdapterOptions` — `bucket` (required), `projectId`, `keyFilename`,
  `credentials`, `publicBaseUrl`, `defaultUrlExpiresIn`. JSDoc on each
  field is the source of truth; the docs MDX renders it via
  `AutoTypeTable`.
- `GCSAdapter` — `Adapter<StorageClient> & { readonly bucket: string }`.
  `raw` is the underlying `Storage` instance, so any primitive the GCS
  SDK exposes (resumable uploads, lifecycle rules, HMAC keys, IAM,
  signed cookies, generation preconditions) is one property access away.
- `mapGCSError(err): FilesError` — exported for tests and for callers
  reusing the same HTTP-status classification through `raw`.

The adapter's `name` is `"gcs"`.

## Authentication / configuration

Credentials follow the GCS SDK's resolution chain. files-sdk classifies
this as `sdk-chain` in [`../providers/index.ts`](../providers/index.ts)
— the adapter does **not** call `readEnv` for credential values. The
`@google-cloud/storage` client handles them, in this order:

1. Explicit `opts.credentials` — `{ client_email, private_key }`. Wins
   over `keyFilename` if both are passed. Useful when credentials land
   in env vars (Vercel / Netlify) and materializing a JSON file is
   awkward.
2. Explicit `opts.keyFilename` — path to a service-account JSON file.
3. **Application Default Credentials (ADC)** — `GOOGLE_APPLICATION_CREDENTIALS`
   env var, `gcloud auth application-default login` user credentials,
   or the metadata server on Cloud Run / Cloud Functions / GKE / GCE /
   App Engine (workload identity).

[`readEnv`](../internal/env.ts) is only used to resolve the project ID:
`opts.projectId` → `GOOGLE_CLOUD_PROJECT` → `GCLOUD_PROJECT`. When none
resolve, ADC carries a project ID alongside the credentials. Env
lookups go through `readEnv` so the adapter is safe to import on
runtimes without `process` (Cloudflare Workers without `nodejs_compat`).

`bucket` is required and has **no env fallback** — the constructor
throws `FilesError("Provider", "gcs adapter: missing bucket. ...")`
when absent. Optional knobs: `publicBaseUrl` (origin used by `url()` to
skip signing; natural value for a public bucket is
`https://storage.googleapis.com/<bucket>`, or your CDN origin) and
`defaultUrlExpiresIn` (presigned-URL expiry in seconds; defaults to
`DEFAULT_URL_EXPIRES_IN` (3600 s) from
[`../internal/core.ts`](../internal/core.ts); **GCS V4 caps at 7 days**).

## Operation map

Every method wraps its `try` in `mapGCSError`. The local `metaToStored`
helper is the single translation point from `FileMetadata` to
`StoredFile` — edit it once if a new metadata field needs to round-trip.

- `upload` — `file.save(buffer, writeOpts)` for buffered bodies;
  `file.createWriteStream(writeOpts)` for `ReadableStream` bodies
  (piped via `Readable.fromWeb` + `node:stream/promises.pipeline`).
  `writeOpts.contentType`, `writeOpts.metadata.cacheControl` (top-level
  GCS metadata), and `writeOpts.metadata.metadata` (user-metadata map)
  flow through. **`resumable: false` is forced** — v1 commits to
  single-request uploads; multi-GB workloads drop to `raw`. `save()`
  doesn't return etag / size, so a follow-up `file.getMetadata()`
  surfaces authoritative values in `UploadResult`.
- `download` — buffer path runs `file.download()` and
  `file.getMetadata()` in parallel via `Promise.all`. Stream path
  pre-fetches metadata (size / contentType must be on the `StoredFile`
  before any reader pulls), wraps `file.createReadStream()` via
  `Readable.toWeb`, and returns a `kind: "stream"` `StoredFile`.
- `head` — `file.getMetadata()` only; body accessors lazily call
  `file.download()`.
- `exists` — `file.exists()` returns `[boolean]`. Some configurations
  surface a 404 as an exception instead of `[false]`, so the adapter
  catches the mapped `NotFound` and returns `false`; every other
  mapped error rethrows.
- `delete` — `file.delete()`.
- `copy` — `bucket.file(from).copy(bucket.file(to))`. Server-side and
  same-bucket only; cross-bucket requires `raw`.
- `list` — `bucket.getFiles({ autoPaginate: false, prefix?,
  maxResults?, pageToken? })`. Returns `[files, nextQuery,
  _rawResponse]`; the unified `cursor` maps to `nextQuery?.pageToken`
  and is omitted when absent. `autoPaginate: false` is forced so a
  caller `limit` is honored exactly. Each item's body factory issues a
  fresh `file.download()` on demand.
- `url` — `resolveUrlStrategy({ publicBaseUrl,
  responseContentDisposition })` chooses between the public path
  (`joinPublicUrl(publicBaseUrl, key)`) and signing
  (`file.getSignedUrl({ action: "read", version: "v4", expires,
  responseDisposition? })`). **`expires` is absolute ms-since-epoch**
  via `expiresAt(seconds)`, not seconds-from-now as on S3.
- `signedUploadUrl` — **PUT or POST policy depending on `maxSize`.**
  Without `maxSize`: `file.getSignedUrl({ action: "write", version:
  "v4", expires, contentType? })` → `{ method: "PUT", url, headers? }`.
  With `maxSize`: `file.generateSignedPostPolicyV4({ conditions:
  [["content-length-range", minSize, maxSize], ["eq", "$Content-Type",
  contentType?]], expires, fields? })` → `{ method: "POST", url,
  fields }`. GCS exposes a **native V4 POST policy primitive**, so the
  same `maxSize` branch as S3 / R2 works unchanged. `minSize` defaults
  to `1`; pass `0` to allow zero-byte uploads.

## URL behavior

- **`publicBaseUrl` precedence.** When set and
  `responseContentDisposition` is absent, `url()` returns
  `${publicBaseUrl}/${encodedKey}` via `joinPublicUrl` from
  [`../internal/core.ts`](../internal/core.ts). The base tolerates a
  single trailing slash; the key is URL-encoded segment-by-segment.
- **Default expiry.** Per-call `expiresIn` wins, then
  `opts.defaultUrlExpiresIn`, then `DEFAULT_URL_EXPIRES_IN` (3600 s).
  Both read and write signing pin `version: "v4"`.
- **`responseContentDisposition` always forces signing**, even with
  `publicBaseUrl` set. A permanent CDN URL has no signature in which
  to bind the override, and silently dropping it would be a stored-XSS
  regression on user-uploaded HTML/SVG.

## Provider quirks worth remembering

- **No string error codes — HTTP status only.** Unlike S3's `NoSuchKey`
  / `AccessDenied` / `PreconditionFailed`, the GCS `ApiError` puts the
  HTTP status on `err.code` as a **number**. `mapGCSError`'s `extract`
  reads `code` when `typeof "number"` and falls back to `err.status`
  for lower-level auth/transport errors; the three string-code sets in
  the config are intentionally empty. Mapping: 404 → `NotFound`,
  401/403 → `Unauthorized`, 409/412 → `Conflict`, anything else
  (including string codes like `"ENOTFOUND"`) → `Provider`. Branch on
  `FilesError.code` after the mapper, never on the raw provider error.
- **Concurrency primitives are not wired through.** GCS has
  `ifGenerationMatch`, `ifGenerationNotMatch`, `ifMetagenerationMatch`,
  and `ifMetagenerationNotMatch` preconditions (map to 412 → `Conflict`
  when they fail) but the unified `Adapter` has no precondition slot.
  Reach for them via `files.raw.bucket("...").file("...").save(...,
  { preconditionOpts: { ifGenerationMatch: 42 } })`. Same applies to
  resumable upload sessions, signed cookies, lifecycle config, and
  HMAC key management.
- **Resumable uploads are off by default.** `resumable: false` is
  forced on every `save()` / `createWriteStream()`. Bodies above
  ~32 MB benefit from the resumable code path on `raw`.
- **`save()` doesn't echo metadata back.** `etag`, `size`, and
  `updated` only surface via the follow-up `getMetadata()` round trip
  — don't skip that probe unless you also stop reporting authoritative
  values on `UploadResult`.
- **`bucket.getFiles()` returns `[files, nextQuery, rawResponse]`.**
  Cursor lives on `nextQuery?.pageToken`; absent means exhausted.
  `autoPaginate: false` is forced so a caller `limit` of 10 doesn't
  silently page through the entire bucket.
- **`metadata.metadata` is the user-metadata slot.** GCS separates
  top-level object metadata (`cacheControl`, `contentType`,
  `contentEncoding`, …) from arbitrary user metadata (the *nested*
  `metadata` field). The adapter writes `cacheControl` at the top and
  `options.metadata` into the nested map; `metaToStored` reads them
  back the same way.
- **Buffer view conversions preserve `byteOffset` / `byteLength`** via
  `uint8ToBuffer`, so `DataView` and offset-`Uint8Array` uploads send
  the right bytes — pinned by the `DataView` test.
- **No `deleteMany` primitive.** GCS has no batch delete on the JSON
  API surface, so `files.deleteMany` falls back to per-key `delete()`
  with bounded concurrency via `deleteManyWithFallback` in
  [`../internal/core.ts`](../internal/core.ts).
- **`url()` and `signedUploadUrl()` expect absolute ms-since-epoch.**
  The local `expiresAt(seconds)` helper converts caller seconds into
  `Date.now() + seconds * 1000`. Don't pass raw seconds — GCS treats
  it as 1970-era epoch ms and returns an instantly-expired URL.

## Testing approach

Tests in [`../../test/gcs.test.ts`](../../test/gcs.test.ts) use Bun's
`mock.module("@google-cloud/storage", () => ({ Storage: StorageStub }))`
to swap in a stub whose `bucket(name)` returns an object with
`file(name)` and `getFiles(opts)` hooks. Each operation routes through
hand-rolled mocks (`saveMock`, `downloadMock`, `getMetadataMock`,
`getSignedUrlMock`, `generateSignedPostPolicyV4Mock`, …) that
`beforeEach` resets so `mockImplementationOnce` from one test doesn't
bleed into the next.

Coverage spans construction (missing bucket, ADC fall-through, each
auth-field forwarding), upload (post-save metadata, every body
variant, stream piping), download (buffer / stream / lazy `head` body),
`exists` (tuple-`[false]`, thrown-404, 403 rethrow), `list` (prefix /
cursor / limit forwarding, tuple-cursor extraction, lazy item bodies),
`url` (public short-circuit, V4 signing default, per-call `expiresIn`,
`responseContentDisposition` forcing signing), `signedUploadUrl` (PUT
and POST-policy branches, `minSize: 0`), and the full `mapGCSError`
matrix (status-field fallback, `FilesError` pass-through, every
wrapped operation re-throwing `FilesError`). Add new fixtures here,
not in `s3.test.ts`.

## Coding conventions

- Named exports only — `gcs`, `mapGCSError`, `GCSAdapter`,
  `GCSAdapterOptions`. No default exports.
- Errors wrap as `FilesError` via `mapGCSError`; pass-through is
  automatic (the mapper short-circuits on `instanceof FilesError`).
  Construction-time validation throws
  [`FilesError("Provider", …)`](../internal/errors.ts) directly.
- Environment access goes through [`readEnv`](../internal/env.ts);
  direct `process.env` breaks Cloudflare Workers without
  `nodejs_compat`. Body normalization goes through `normalizeBody`
  from [`../internal/core.ts`](../internal/core.ts) — don't branch on
  `Body` variants in the adapter.
- Forward optional `Storage` constructor config with
  `...(opts.x && { x: opts.x })` so unset values fall through to SDK
  defaults instead of being passed as explicit `undefined`.
- Use `createStoredFile` from
  [`../internal/stored-file.ts`](../internal/stored-file.ts) for every
  `StoredFile` returned; don't hand-roll body accessors. Top-level
  regex literals only.

## Releases

The repo uses Changesets. Behavioral changes (new options, default
changes, error-shape changes) need a changeset (`bunx changeset`);
README and AGENTS.md edits don't. `GCSAdapterOptions` / `GCSAdapter`
are adapter-local — nothing in the package re-exports them — but
still bump the `files-sdk` version when their shape changes.

## Where to look next

- User-facing docs: [`../../../../apps/web/content/docs/adapters/gcs.mdx`](../../../../apps/web/content/docs/adapters/gcs.mdx).
  Source: [`./index.ts`](./index.ts). Tests:
  [`../../test/gcs.test.ts`](../../test/gcs.test.ts). Provider catalog
  entry: [`../providers/index.ts`](../providers/index.ts).
- Unified contract: [`../index.ts`](../index.ts). Shared helpers:
  [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts),
  [`../internal/stored-file.ts`](../internal/stored-file.ts).
- Sibling native adapter for reference patterns:
  [`../s3/AGENTS.md`](../s3/AGENTS.md). Package SKILL:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
  Package README: [`../../README.md`](../../README.md).
