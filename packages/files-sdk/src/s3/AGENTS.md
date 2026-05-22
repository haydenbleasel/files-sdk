# AGENTS.md — `files-sdk/s3`

Guidance for coding agents working inside the S3 adapter. Every adapter in
files-sdk implements the same `Adapter<Raw>` contract from
[`packages/files-sdk/src/index.ts`](../index.ts); this file documents only
the deviations and pitfalls specific to `s3`. For the unified API, the
package-wide [README.md](../../README.md) and the agent skill at
[`skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md) are the
sources of truth — read them first.

`s3` is the foundational adapter. Several other S3-compatible adapters
(`bun-s3`, `r2`, `minio`, `digitalocean-spaces`, `storj`, `hetzner`,
`akamai`, `backblaze-b2`, `wasabi`, `scaleway`, `ovhcloud`, `idrive-e2`,
`vultr`, `filebase`, `exoscale`, `oracle-cloud`, `ibm-cos`, `tigris`,
`tencent`, `alibaba`, `yandex`) wrap or re-export this adapter with
provider-friendly defaults (default endpoint, label override, signing
mode), so behaviour changes here cascade to roughly half the catalog. Edit
with care.

## Overview

AWS S3 (and any S3-compatible bucket reached over the S3 HTTP API). Family:
**S3 / S3-compatible foundational**. The full unified surface — `upload`,
`download`, `head`, `exists`, `delete`, `deleteMany`, `copy`, `list`,
`url`, `signedUploadUrl` — is implemented natively against
`@aws-sdk/client-s3`, with presigning via `@aws-sdk/s3-request-presigner`
(GET / PUT) and `@aws-sdk/s3-presigned-post` (POST policy form).

Peer dependencies (all optional, declared in the package
[`package.json`](../../package.json)):

- `@aws-sdk/client-s3`
- `@aws-sdk/s3-presigned-post`
- `@aws-sdk/s3-request-presigner`

## Directory layout

```text
packages/files-sdk/src/s3/
├── index.ts                # adapter implementation
├── AGENTS.md               # this file
└── CLAUDE.md               # `@AGENTS.md`
```

Sibling files outside this directory:

- Tests: [`packages/files-sdk/test/s3.test.ts`](../../test/s3.test.ts)
- User docs: [`apps/web/content/docs/adapters/s3.mdx`](../../../../apps/web/content/docs/adapters/s3.mdx)
- Provider catalog entry: [`packages/files-sdk/src/providers/index.ts`](../providers/index.ts) (search for `slug: "s3"`)

## Build, test, typecheck

```bash
# from packages/files-sdk/
bun test test/s3.test.ts            # run only this adapter's tests
bun test                            # run the whole test suite
bun run build                       # tsup ESM bundle -> dist/s3/index.js
bun run types                       # tsgo --noEmit (uses @typescript/native-preview)
bun run test:coverage               # bun test --coverage
```

This package uses **`bun test`** (not vitest) and **`tsgo`** (not `tsc`) —
both are pinned in `package.json` `devDependencies`. The per-subpath
bundle output is `dist/s3/index.{js,d.ts}` per the `exports` map in
[`packages/files-sdk/package.json`](../../package.json).

## Public surface

Defined in [`index.ts`](index.ts):

- `s3(opts: S3AdapterOptions): S3Adapter` — factory (lines 182-570). The
  one entry point most callers use.
- `S3AdapterOptions` interface (lines 36-89) — `bucket`, `region`,
  `endpoint`, `forcePathStyle`, `credentials`, `publicBaseUrl`,
  `defaultUrlExpiresIn`, and the `@internal` `defaultProviderMessage`.
- `S3Adapter` type (lines 91-93) — `Adapter<S3Client> & { readonly bucket }`
  so callers can read the configured bucket without re-passing it.
- `mapS3Error(err, messages?): FilesError` (lines 157-180) — exported so
  the S3-compatible wrappers can reuse the same classification with their
  own per-code fallback messages.

## Authentication / configuration

Credentials are `sdk-chain` here — files-sdk does **not** call `readEnv` for
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`. The
AWS SDK's default credential chain handles them: env vars, IAM role,
shared profile, EC2 / ECS / EKS instance metadata, SSO, etc. Callers can
omit `credentials` entirely on those runtimes.

The adapter itself only reads the region:

- `opts.region` (preferred), then `AWS_REGION`, then `AWS_DEFAULT_REGION`
  via `readEnv` (lines 183-184). Missing region throws a `FilesError`
  with code `Provider` at construction (lines 185-190).

`opts.endpoint` and `opts.forcePathStyle` are passed straight through to
`S3Client`. Both are required by most S3-compatible services (and by
LocalStack) — the wrappers in `digitalocean-spaces`, `wasabi`, `minio`,
etc. set them automatically; bare `s3()` users on a non-AWS endpoint must
pass them explicitly.

## Operation map

Every method goes through the local `wrapErr` mapper, which is
`mapS3Error` by default and a relabelled variant when
`defaultProviderMessage` is set.

- `upload` — `PutObjectCommand` with body, content type, content length,
  `Cache-Control`, and user `Metadata` from `normalizeBody`. `ReadableStream`
  bodies have no upfront `ContentLength`; the adapter follows up with a
  `HeadObjectCommand` to surface the authoritative size and
  `lastModified` in the result (lines 528-539). If that head probe fails,
  size falls back to `0` rather than rejecting the upload.
- `download` — `GetObjectCommand`. Buffer path uses
  `Body.transformToByteArray()`; stream path uses
  `Body.transformToWebStream()`. The buffer path always reports the actual
  byte length, not `ContentLength`, so the size matches what the caller
  can read.
- `head` — `HeadObjectCommand`. The returned `StoredFile`'s body
  accessors lazily issue a `GetObjectCommand` if you call `text()` /
  `arrayBuffer()` / `blob()` / `stream()` — they are not free.
- `exists` — `existsByProbe(HeadObjectCommand, wrapErr)` from
  `internal/core.ts`. `NotFound` returns `false`; auth and transport
  errors propagate.
- `delete` — `DeleteObjectCommand`.
- `deleteMany` — native via `DeleteObjectsCommand`, chunked at
  `S3_DELETE_BATCH_LIMIT = 1000` (lines 117, 290-322). With
  `stopOnError: true` it falls back to per-key `DeleteObjectCommand` so
  the "stop" point lands on a single key. If a whole `DeleteObjects`
  batch rejects, the mapped error is attached to every key in that batch
  (S3 doesn't tell us which keys failed at the request level).
- `copy` — `CopyObjectCommand` server-side. `CopySource` is
  URL-encoded defensively (`${encodeURIComponent(bucket)}/${encodeURIComponent(from)}`)
  per the S3 docs; `Key` is passed unencoded because the SDK signs and
  serializes it as a request parameter, not a URL value.
- `list` — `ListObjectsV2Command`. The `cursor` field is
  `NextContinuationToken` when `IsTruncated` is true. Per-page limit is
  whatever the caller passes; the AWS-side default is 1000. Each item's
  body factory issues a fresh `GetObjectCommand` on demand, just like
  `head`.
- `url` — `resolveUrlStrategy({ publicBaseUrl, responseContentDisposition })`
  decides between the public path (`joinPublicUrl(publicBaseUrl, key)`)
  and signing (`getSignedUrl(GetObjectCommand)`). Per-call `expiresIn`
  beats `opts.defaultUrlExpiresIn`, which falls back to
  `DEFAULT_URL_EXPIRES_IN` (3600s).
- `signedUploadUrl` — **PUT or POST depending on `maxSize`**. With
  `maxSize` set, returns `createPresignedPost(...)` with a
  `content-length-range` policy (defaulting `minSize` to `1` to reject
  empty uploads — pass `minSize: 0` if you genuinely want to allow them).
  Without `maxSize`, returns `getSignedUrl(PutObjectCommand)`.

## URL behavior

- **`publicBaseUrl` precedence.** When set and `responseContentDisposition`
  is absent, `url()` returns `${publicBaseUrl}/${encodedKey}` via
  `joinPublicUrl`. The base tolerates a single trailing slash; the key is
  URL-encoded segment-by-segment (so `/` stays as the path separator and
  everything else is `encodeURIComponent`'d).
- **Default expiry.** When signing, the per-call `expiresIn` wins;
  otherwise the adapter's `defaultUrlExpiresIn` wins; otherwise
  `DEFAULT_URL_EXPIRES_IN` (3600s) from `internal/core.ts`.
- **`responseContentDisposition` always forces signing.** The relevant
  comment in `resolveUrlStrategy` ([`internal/core.ts`](../internal/core.ts)):
  > a permanent CDN URL has no signature in which to bind the override,
  > and silently dropping the override is a stored-XSS regression on
  > user-uploaded HTML/SVG. The override wins.
  So passing this option returns a presigned URL even when
  `publicBaseUrl` is set — the security override beats the unsigned
  fast-path.
- **Key encoding caveat.** `joinPublicUrl` encodes raw keys; pass them
  raw, not pre-encoded, or you'll double-encode (`%20` → `%2520`). The
  signing path leaves encoding to the AWS SDK.

## Provider quirks worth remembering

- **`DeleteObjects` caps at 1000 keys per request.** The adapter chunks
  longer key lists into separate requests (`S3_DELETE_BATCH_LIMIT`). If
  one batch fails wholesale, the mapped error is attached to every key
  in that batch and the next batch still runs.
- **`defaultProviderMessage` is `@internal`.** Sibling adapters (`r2`
  HTTP, `minio`, `digitalocean-spaces`, `storj`, `hetzner`, `akamai`,
  `backblaze-b2`, `wasabi`, `scaleway`, `ovhcloud`, `idrive-e2`,
  `vultr`, `filebase`, `exoscale`, `oracle-cloud`, `ibm-cos`, `tigris`,
  `tencent`, `alibaba`, `yandex`) pass it so unknown errors read
  "R2 error" / "MinIO error" / etc. instead of "S3 error". Don't expose
  it in user-facing types — leave the JSDoc `@internal` tag alone.
- **`forcePathStyle` is required by some S3-compatible services and
  LocalStack.** Virtual-hosted style (`https://bucket.endpoint/key`)
  fails when the endpoint can't put the bucket in the hostname; pass
  `forcePathStyle: true` to switch to `https://endpoint/bucket/key`.
- **AWS credential chain handles auth.** The `credentials` field is
  optional. On EC2 / ECS / EKS / Lambda with an attached role, omit it
  and the SDK picks up the instance credentials. Setting `credentials`
  explicitly disables the chain for this client.
- **`etag` is stripped of surrounding quotes.** S3 returns ETags as
  `"abc"` (with literal `"`); `stripEtag` (lines 95-100) removes them so
  callers see `abc`. Stay consistent if you add new ETag-returning
  paths — don't surface raw quoted values.
- **`signedUploadUrl` returns a different shape per `maxSize`.** With
  `maxSize`, `{ method: "POST", url, fields }` (multipart form). Without,
  `{ method: "PUT", url, headers? }`. The contract types are different
  and clients must handle both — the unified `SignedUpload` type is a
  union, not an intersection.
- **`responseContentDisposition` always forces signing even when
  `publicBaseUrl` is set.** See URL behavior above. This is deliberate:
  silently dropping the override would be a stored-XSS regression.
- **Stream uploads do a follow-up `head()`.** `PutObject`'s response
  doesn't carry size, and stream bodies have no upfront length. The
  adapter does a head probe so `UploadResult.size` and `lastModified`
  are authoritative; if the probe fails, size falls back to `0`.
- **Error classification keys.** `S3_NOT_FOUND_CODES = { NoSuchKey,
  NotFound }`, `S3_UNAUTH_CODES = { AccessDenied }`,
  `S3_CONFLICT_CODES = { PreconditionFailed }`. HTTP status buckets
  (404 / 401-403 / 409-412) provide a fallback for SDK errors that
  drop the code string. Anything else maps to `Provider`.

## Testing approach

Tests in [`packages/files-sdk/test/s3.test.ts`](../../test/s3.test.ts) use
[`aws-sdk-client-mock`](https://www.npmjs.com/package/aws-sdk-client-mock):
`mockClient(S3Client)` plus `s3Mock.on(PutObjectCommand).resolves(...)` /
`.rejects(...)`. The pattern covers happy-path I/O, error mapping
(`NoSuchKey` → `NotFound`, `AccessDenied` → `Unauthorized`,
`PreconditionFailed` → `Conflict`, default → `Provider`), presigned URL
output (asserts on `X-Amz-Signature=`, `X-Amz-Expires=…`, and
`response-content-disposition=`), and the `DeleteObjectsCommand`
chunking behaviour.

`bun test` is the runner. There is no vitest config in this package — do
not add one. The shared `FakeAdapter` at
[`packages/files-sdk/test/fake-adapter.ts`](../../test/fake-adapter.ts) is
used by `Files`-class tests, **not** by adapter unit tests; new s3 tests
go in `s3.test.ts` and mock the AWS SDK directly.

## Coding conventions

- Named exports only — no default exports.
- Errors wrap as `FilesError` via `wrapErr` (which delegates to
  `mapS3Error` / `buildMapS3Error`). Pass through `FilesError` instances
  unchanged — `mapS3Error` already short-circuits on them.
- Body normalization goes through `normalizeBody` from
  [`internal/core.ts`](../internal/core.ts); don't branch on `Body`
  variants in the adapter.
- Top-level regex literals only. The only one here is the inline
  `replaceAll(/^"+|"+$/gu, "")` in `stripEtag` — keep new patterns at
  module scope if they grow beyond a one-shot.
- No `process.env` outside `readEnv` from
  [`internal/env.ts`](../internal/env.ts). The bare `process.env`
  references in `s3.test.ts` are test-only setup/teardown, not runtime
  reads.
- Forward `operationOpts.signal` to the AWS client as
  `{ abortSignal: signal }`. Tests assert on this — don't drop it.
- Use `createStoredFile` from
  [`internal/stored-file.ts`](../internal/stored-file.ts) for every
  `StoredFile` you return. Don't hand-roll body accessors.

## Releases

The repo uses Changesets. Behavioural changes here need a changeset
(`bunx changeset`, then commit the entry under `.changeset/`). README
updates and AGENTS.md edits don't require one. When a public type in
`S3AdapterOptions` or `S3Adapter` changes, also flag the dependent
S3-compatible wrapper packages — the change usually surfaces transitively
through their re-exports.

## Where to look next

- User-facing docs: [`apps/web/content/docs/adapters/s3.mdx`](../../../../apps/web/content/docs/adapters/s3.mdx)
- Source: [`packages/files-sdk/src/s3/index.ts`](index.ts)
- Tests: [`packages/files-sdk/test/s3.test.ts`](../../test/s3.test.ts)
- Provider catalog entry: [`packages/files-sdk/src/providers/index.ts`](../providers/index.ts)
- Unified Adapter contract: [`packages/files-sdk/src/index.ts`](../index.ts)
- Shared adapter helpers: [`packages/files-sdk/src/internal/core.ts`](../internal/core.ts)
- Package SKILL: [`skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md)
- Package README: [`packages/files-sdk/README.md`](../../README.md)
