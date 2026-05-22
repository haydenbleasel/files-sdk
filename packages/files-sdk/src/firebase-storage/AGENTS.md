# AGENTS.md — `files-sdk/firebase-storage`

Guidance for coding agents working on the `firebase-storage` adapter.
The unified `Adapter` contract — call shapes, `FilesError`, `UrlOptions`,
`SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file only documents firebase-storage-specific
behavior. **`firebase-storage` is a primary native adapter** built on
[`firebase-admin`](https://www.npmjs.com/package/firebase-admin)'s
`initializeApp` → `getStorage(app).bucket(name)` chain; the returned
`Bucket` is `@google-cloud/storage` under the hood, so V4 signing, POST
policy uploads, and server-side copy match the GCS surface — see
[`../gcs/AGENTS.md`](../gcs/AGENTS.md) for primitive-level parallels. It does
**not** wrap [`gcs()`](../gcs/index.ts) or [`s3()`](../s3/index.ts).
Cross-references: [`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

[Firebase Cloud Storage](https://firebase.google.com/docs/storage) via the
official `firebase-admin` SDK. Family: **native adapter, GCS JSON API
(Firebase-flavoured credentials and bucket defaults)**. Every operation
targets `bucket.file(key)` primitives — `save()`, `download()`,
`createReadStream()` / `createWriteStream()`, `getMetadata()`, `exists()`,
`delete()`, `copy()`, `bucket.getFiles()`, `getSignedUrl({ version: "v4" })`,
and `generateSignedPostPolicyV4()` for presigned upload forms.

Peer dependency (optional in [`../../package.json`](../../package.json)):

- `firebase-admin` — direct import in [`index.ts`](./index.ts); missing it
  throws `ERR_MODULE_NOT_FOUND` at module load. `@google-cloud/storage` is
  transitive via `firebase-admin/storage`.

## Directory layout

```text
packages/files-sdk/src/firebase-storage/
├── index.ts                   # firebaseStorage() + options + mapFirebaseStorageError
├── AGENTS.md                  # this file
└── CLAUDE.md                  # @AGENTS.md — Claude-Code re-export
```

Sibling files: tests at
[`../../test/firebase-storage.test.ts`](../../test/firebase-storage.test.ts);
user docs at
[`../../../../apps/web/content/docs/adapters/firebase-storage.mdx`](../../../../apps/web/content/docs/adapters/firebase-storage.mdx);
provider catalog entry (search `slug: "firebase-storage"`) in
[`../providers/index.ts`](../providers/index.ts).

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/firebase-storage.test.ts   # this adapter only
bun test                                 # full SDK suite
bun run build                            # tsup ESM bundle -> dist/firebase-storage/
bun run types                            # tsgo --noEmit
```

This package uses **`bun test`** (not vitest) and **`tsgo`** (not `tsc`).
The `./firebase-storage` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep that entry
in sync if the file layout changes.

## Public surface

Exports from [`index.ts`](./index.ts):

- `firebaseStorage(opts?: FirebaseStorageAdapterOptions): FirebaseStorageAdapter`
  — primary factory.
- `FirebaseStorageAdapter` — `Adapter<Bucket> & { readonly bucket: string }`.
  `raw` is the underlying `@google-cloud/storage` `Bucket`, so any GCS-side
  primitive (resumable uploads, lifecycle rules, generation preconditions,
  Firebase download-token URLs) is one property access away.
- `FirebaseStorageAdapterOptions` — JSDoc on every field is the source of
  truth; the docs MDX pulls it via `AutoTypeTable`.
- `mapFirebaseStorageError(err): FilesError` — exported for tests and for
  callers reusing the same HTTP-status classification through `raw`.

The adapter's `name` is `"firebase-storage"`. The factory also exposes
`adapter.bucket` (resolved bucket name string).

## Authentication / configuration

Credential resolution (first match wins):

1. **`opts.app` as a `Bucket`** — returned as-is; no Firebase init.
2. **`opts.app` as a Firebase `App`** — `getStorage(app).bucket(name)` where
   `name` is `opts.bucket` → `FIREBASE_STORAGE_BUCKET` →
   `app.options.storageBucket` → default bucket (no arg).
3. **Inline `opts.credentials`** — `{ clientEmail, privateKey }` via
   `cert()`. Literal `\n` in the private key is unescaped before `cert()`
   when threaded through user code (env-sourced keys are normalized by
   Firebase when read directly).
4. **`opts.serviceAccountPath`** — JSON file path via `cert()`; wins over
   inline credentials. Falls back to `GOOGLE_APPLICATION_CREDENTIALS`.
5. **Application Default Credentials** — `applicationDefault()` when none of
   the above apply (`gcloud auth application-default login`, GCE/GKE/Cloud
   Run metadata, workload identity).

Env fallbacks (via [`readEnv`](../internal/env.ts), safe on Workers without
`nodejs_compat`):

| Field | Options / env |
| ----- | ------------- |
| `bucket` | `opts.bucket` → `FIREBASE_STORAGE_BUCKET` → `<projectId>.firebasestorage.app` when `projectId` is known |
| `projectId` | `opts.projectId` → `FIREBASE_PROJECT_ID` → `GOOGLE_CLOUD_PROJECT` → `GCLOUD_PROJECT` (optional — ADC may carry it) |
| Inline SA | `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` (both required) |
| JSON path | `GOOGLE_APPLICATION_CREDENTIALS` |

**Bucket naming.** The Firebase console shows `<project>.appspot.com` on
older projects and `<project>.firebasestorage.app` on newer ones. Pass the
literal name from the console — do not assume the default matches your
project era. Construction throws
`FilesError("Provider", "firebase-storage adapter: missing bucket. …")`
when neither `bucket`, `FIREBASE_STORAGE_BUCKET`, nor a derivable
`projectId` is available.

**Idempotent Firebase init.** `initializeApp()` is called at most once per
stable app name `files-sdk:${projectId ?? "default"}:${storageBucket}`
(override with `opts.appName`). Subsequent `firebaseStorage()` calls with
the same name reuse the existing app via `getApps()`.

Optional knobs: `publicBaseUrl` (unsigned `url()` when set), and
`defaultUrlExpiresIn` (signed-read expiry; defaults to `3600` via
`DEFAULT_URL_EXPIRES_IN` in [`../internal/core.ts`](../internal/core.ts);
GCS V4 caps at 7 days).

**Emulator support.** The adapter does not wire Firebase Storage or GCS
emulator hosts. For local emulation, pass a pre-configured `Bucket` (or
`App` whose storage client points at the emulator) via `opts.app`, or use
`adapter.raw` with emulator-aware `@google-cloud/storage` client options.

## Operation map

Every method wraps its `try` in `mapFirebaseStorageError`. `metaToStored` is
the single translation point from `FileMetadata` to `StoredFile`.

- `upload` — `file.save(buffer, writeOpts)` for buffered bodies;
  `file.createWriteStream(writeOpts)` for `ReadableStream` bodies (piped via
  `Readable.fromWeb` + `pipeline`). `writeOpts.metadata.metadata` carries
  `options.metadata` (user custom metadata); `cacheControl` is top-level.
  **`resumable: false` is forced.** Post-upload `getMetadata()` supplies
  authoritative `etag` / `lastModified` / `size` on `UploadResult`.
- `download` — buffer path: parallel `download()` + `getMetadata()`. Stream
  path: metadata first, then `createReadStream()` as a web stream.
- `head` — `getMetadata()` only; body accessors lazily `download()`.
- `exists` — `file.exists()` tuple; caught `NotFound` → `false`.
- `delete` — `file.delete()`.
- `copy` — `bucket.file(from).copy(bucket.file(to))` (same bucket).
- `list` — `bucket.getFiles({ autoPaginate: false, prefix?, maxResults?,
  pageToken? })`; cursor from `nextQuery?.pageToken`.
- `url` — `resolveUrlStrategy` → `joinPublicUrl` or
  `getSignedUrl({ action: "read", version: "v4", expires, responseDisposition? })`.
  `expires` is absolute ms via `expiresAt(seconds)`.
- `signedUploadUrl` — without `maxSize`: V4 PUT via `getSignedUrl`. With
  `maxSize`: `generateSignedPostPolicyV4` with
  `content-length-range` (and optional `Content-Type` eq). `minSize`
  defaults to `1`.

No `deleteMany` primitive — `files.deleteMany` uses per-key `delete()` with
bounded concurrency via `deleteManyWithFallback` in
[`../internal/core.ts`](../internal/core.ts).

## URL behavior

- **`publicBaseUrl`.** When set and `responseContentDisposition` is absent,
  `url()` returns `${publicBaseUrl}/${encodedKey}` via `joinPublicUrl`.
- **Default.** V4 signed read URL; per-call `expiresIn` overrides
  `defaultUrlExpiresIn`.
- **`responseContentDisposition` always forces signing**, even with
  `publicBaseUrl` — same stored-XSS rationale as other signing adapters
  (`resolveUrlStrategy` in [`../internal/core.ts`](../internal/core.ts)).
- **Firebase download tokens (`?alt=media&token=…`) are out of scope for
  v1.** `url()` never mints them; use `adapter.raw` if the client SDK URL
  form is required.

## Provider quirks worth remembering

- **Same HTTP-status error model as GCS.** `@google-cloud/storage` puts HTTP
  status on `err.code` (number); `mapFirebaseStorageError` also reads
  `err.status`. String codes (e.g. `"ENOTFOUND"`) → `Provider`. Mapping:
  404 → `NotFound`, 401/403 → `Unauthorized`, 409/412 → `Conflict`.
- **Share Firebase with Firestore/Auth.** Pass an existing `App` via `opts.app`
  so credentials and project config aren't duplicated. Pass a `Bucket` when
  the consumer already holds a storage handle.
- **Service account needs Storage permissions.** Firebase console rules govern
  client access; server-side Admin SDK calls need IAM roles on the bucket
  (typically `roles/storage.objectAdmin` or tighter scoped roles).
- **Rules vs Admin SDK.** Security rules do not apply to `firebase-admin`
  server calls — treat the adapter as trusted backend access only.
- **Resumable uploads off.** Large objects need `raw` and resumable
  `createWriteStream` / upload session APIs.
- **`metadata.metadata` is custom metadata.** Top-level `cacheControl` /
  `contentType` are separate from the nested user-metadata map; round-trip
  matches GCS conventions.
- **Signed URLs need a signing-capable credential.** Service-account keys
  (inline, JSON file, or ADC with a key) work; some ADC modes without a
  private key cannot sign — surface as `Provider` errors from `getSignedUrl`.

## Testing approach

Tests in
[`../../test/firebase-storage.test.ts`](../../test/firebase-storage.test.ts)
mock `firebase-admin/app` and `firebase-admin/storage` with hand-rolled
bucket/file hooks (`saveMock`, `getSignedUrlMock`,
`generateSignedPostPolicyV4Mock`, …). `beforeEach` clears mocks and env vars.

Coverage spans construction (missing bucket, derived bucket from `projectId`,
explicit bucket, cert vs ADC, env fallbacks, `\n` unescaping,
`serviceAccountPath` precedence, idempotent `initializeApp`, pre-built `App` /
`Bucket`), upload (metadata, stream pipe, `resumable: false`), download
(buffer / stream), `head` / `exists` / `delete` / `copy` / `list`, `url`
(public short-circuit, signing, `responseContentDisposition`), `signedUploadUrl`
(PUT vs POST policy), lazy bodies on `head` / `list`, pre-built `App` bucket
fallbacks, and the full `mapFirebaseStorageError` matrix plus wrapped
operation errors. Add firebase-specific fixtures here, not in `gcs.test.ts`.

## Coding conventions

- Named exports only — `firebaseStorage`, `mapFirebaseStorageError`,
  `FirebaseStorageAdapter`, `FirebaseStorageAdapterOptions`.
- Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts); operation errors
  go through `mapFirebaseStorageError`.
- Environment access via [`readEnv`](../internal/env.ts) — never
  `process.env` directly.
- Body normalization via `normalizeBody` from
  [`../internal/core.ts`](../internal/core.ts).
- Use `createStoredFile` from
  [`../internal/stored-file.ts`](../internal/stored-file.ts) for every
  `StoredFile`. `uint8ToBuffer` / `bufferToUint8` preserve byte offsets.
- `isBucket()` duck-types `opts.app` so both `App` and `Bucket` share one
  option slot without a union import cycle at the type level.
- Top-level regex literals only.

## Releases

Ships with the monorepo from [`../../package.json`](../../package.json).
Behavioral changes need a Changesets entry and
[`../../CHANGELOG.md`](../../CHANGELOG.md) note; docs-only edits do not.
The `firebase-storage` subpath is already in `exports`.

## Where to look next

- Unified contract: [`../index.ts`](../index.ts). Sibling GCS adapter:
  [`../gcs/index.ts`](../gcs/index.ts) + [`../gcs/AGENTS.md`](../gcs/AGENTS.md).
- Shared helpers: [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts),
  [`../internal/stored-file.ts`](../internal/stored-file.ts).
- Provider catalog (`slug: "firebase-storage"`):
  [`../providers/index.ts`](../providers/index.ts).
- User-facing docs:
  [`../../../../apps/web/content/docs/adapters/firebase-storage.mdx`](../../../../apps/web/content/docs/adapters/firebase-storage.mdx).
- Package README: [`../../README.md`](../../README.md).
- SKILL: [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
- Tests: [`../../test/firebase-storage.test.ts`](../../test/firebase-storage.test.ts).
- CLI registry: [`../cli/registry.ts`](../cli/registry.ts) (`--key-filename`,
  `--config-json` for inline / `FIREBASE_*` env vars).
