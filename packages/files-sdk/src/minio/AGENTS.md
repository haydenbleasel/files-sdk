# AGENTS.md — `files-sdk/minio`

Guidance for coding agents working inside the MinIO adapter. The unified
`Adapter<Raw>` contract — methods, option shapes, error codes, and
URL/signing semantics — lives in [src/index.ts](../index.ts); this file only
documents what minio adds (or constrains) on top of it. The adapter is a
thin wrapper over [`s3()`](../s3/index.ts) with self-hosted-friendly
defaults, so for the underlying primitive details (signing, error mapping,
presigned POST, bulk delete) read alongside the s3 source. See also
[README.md](../../README.md) and
[SKILL.md](../../../../skills/files-sdk/SKILL.md).

## Overview

`files-sdk/minio` connects a `Files` instance to a self-hosted MinIO server
(or any other server speaking the MinIO/S3 wire protocol on a custom
endpoint). It exists because every MinIO deployment needs the same three
knobs flipped from the AWS defaults:

- An explicit `endpoint` — no DNS-based bucket routing.
- `forcePathStyle: true` — virtual-hosted style needs per-bucket subdomain
  setup that self-hosted clusters rarely have.
- A region placeholder — SigV4 requires *some* region in the signature;
  MinIO ignores it for routing.

The adapter sets those for you, relabels the fallback error message so users
see "MinIO error" instead of "S3 error", reads env-var fallbacks under
`MINIO_*` names, and otherwise hands every operation to the inner s3 adapter
unchanged.

## Directory layout

```
packages/files-sdk/src/minio/
├── index.ts        # minio() factory; everything else lives in ../s3/
├── AGENTS.md       # this file
└── CLAUDE.md       # → @AGENTS.md
```

Tests live one level up at [`test/minio.test.ts`](../../test/minio.test.ts).
The user-facing docs page lives at
[`apps/web/content/docs/adapters/minio.mdx`](../../../../apps/web/content/docs/adapters/minio.mdx).

## Build, test, typecheck

```bash
bun test test/minio.test.ts   # adapter-only suite
bun test                      # full SDK test suite
bun run build                 # tsup ESM bundle → dist/
bun run types                 # tsgo --noEmit
```

Mocks are provided by `aws-sdk-client-mock` (the adapter speaks the same
wire protocol as s3, so the same mock library covers both). Tests should
exercise the minio-specific behaviour (defaults, env fallbacks, error
relabelling); the underlying operation tests already live in
[`test/s3.test.ts`](../../test/s3.test.ts) and don't need to be duplicated.

## Public surface

`src/minio/index.ts` exports:

- `minio(opts: MinioAdapterOptions): MinioAdapter` — primary factory.
- `MinioAdapterOptions` — option shape (see below).
- `MinioAdapter` — alias for `Adapter<S3Client>`. The `raw` escape hatch is
  the same `@aws-sdk/client-s3` `S3Client` you'd get from `s3()`.

`opts` deviates from `S3AdapterOptions` in a few places:

- `endpoint: string` — **required** (the factory throws if empty).
- `bucket: string` — required.
- `accessKeyId`, `secretAccessKey` — optional only if both env vars below
  are set; otherwise the factory throws.
- `region` — defaults to `"us-east-1"`.
- `forcePathStyle` — defaults to `true`.
- `publicBaseUrl`, `defaultUrlExpiresIn` — passthrough to s3.

Construction-time failures throw `FilesError("Provider", …)`. Match them in
tests with `/endpoint/u` and `/credentials/u` patterns rather than
full-string comparisons so the wording can evolve.

## Authentication / configuration

```ts
import { Files } from "files-sdk";
import { minio } from "files-sdk/minio";

const files = new Files({
  adapter: minio({
    bucket: "uploads",
    endpoint: "http://localhost:9000",
    // accessKeyId / secretAccessKey auto-loaded from
    // MINIO_ACCESS_KEY_ID / MINIO_SECRET_ACCESS_KEY when omitted
  }),
});
```

Env-var fallbacks (read via `readEnv` so the adapter still constructs on
runtimes where `process` is missing — see
[`internal/env.ts`](../internal/env.ts)):

- `MINIO_ACCESS_KEY_ID` — backs `opts.accessKeyId`.
- `MINIO_SECRET_ACCESS_KEY` — backs `opts.secretAccessKey`.

These are **adapter-read** vars, distinct from `MINIO_ROOT_USER` /
`MINIO_ROOT_PASSWORD` — those are read by the MinIO server itself to
bootstrap its admin account, not by the SDK. The provider catalog entry in
[`providers/index.ts`](../providers/index.ts) (search for `slug: "minio"`)
is the source of truth for the env spec.

There is **no** env fallback for `endpoint` — pass it inline.

## Operation map

Every method delegates to the inner s3 adapter; there is no per-method code
in `minio/index.ts`. Behaviour is therefore identical to s3:

| Method            | Backed by                                                                            |
| ----------------- | ------------------------------------------------------------------------------------ |
| `upload`          | `PutObjectCommand` (plus a follow-up `HEAD` for stream bodies with no known length). |
| `download`        | `GetObjectCommand`; `as: "stream"` returns the raw web stream.                       |
| `head` / `exists` | `HeadObjectCommand`; `exists` returns `false` on `NotFound`, rethrows others.        |
| `delete`          | `DeleteObjectCommand`.                                                               |
| `deleteMany`      | `DeleteObjectsCommand` (native bulk; chunked at 1000 keys per request).              |
| `copy`            | `CopyObjectCommand`.                                                                 |
| `list`            | `ListObjectsV2Command`; `cursor` round-trips `NextContinuationToken`.                |
| `url`             | Presigned `GetObject` URL or `publicBaseUrl` join — see [URL behavior](#url-behavior). |
| `signedUploadUrl` | Presigned POST (`createPresignedPost`) when `maxSize` is set; presigned PUT otherwise. |

The returned `name` is `"minio"` (overridden after spreading the s3
adapter). `raw` is the underlying `S3Client`.

## URL behavior

Inherited from the s3 adapter via `resolveUrlStrategy` in
[`internal/core.ts`](../internal/core.ts):

- `publicBaseUrl` set and no `responseContentDisposition` → returns
  `${publicBaseUrl}/${encodeURIComponent(key)}`, unsigned.
- Otherwise → presigned `GetObject` URL (default expiry `3600` s, override
  with `defaultUrlExpiresIn` on the adapter or `expiresIn` per call).
- `responseContentDisposition` **always forces signing**, even when
  `publicBaseUrl` is configured: a permanent CDN URL has no signature to
  bind the override to. This is a deliberate stored-XSS mitigation for
  buckets hosting user-uploaded HTML/SVG — see the JSDoc on
  `UrlOptions.responseContentDisposition` in [`src/index.ts`](../index.ts).

## Provider quirks worth remembering

- **`forcePathStyle: true` by default.** MinIO routes via path-style
  (`/<bucket>/<key>`) unless you've fronted it with per-bucket DNS. Flip
  `forcePathStyle: false` only when you've actually configured that.
- **Region is a placeholder.** SigV4 needs *some* region in the signature;
  MinIO doesn't use it for routing. The default `"us-east-1"` is correct
  for ~every deployment. Override only when you've intentionally configured
  per-region buckets and want the signature to reflect that.
- **HTTP endpoints are normal.** Production should run TLS, but
  `endpoint: "http://localhost:9000"` is fine for local dev. Include the
  scheme; the adapter doesn't synthesize one.
- **No env fallback for `endpoint`.** Unlike `region` (which the s3 adapter
  falls back to `AWS_REGION` for), `endpoint` must be passed explicitly or
  the factory throws. There is no `MINIO_ENDPOINT` fallback.
- **Error messages read "MinIO error".** The factory passes
  `defaultProviderMessage: "MinIO error"` into `s3()`, so the fallback on a
  no-message provider error is "MinIO error" instead of "S3 error".
  Server-side messages (when present) still surface unchanged.
- **`raw` is `S3Client`, not a MinIO-specific client.** The escape hatch is
  the AWS SDK; there's no separate MinIO SDK to reach for.

## Testing approach

Tests at [`test/minio.test.ts`](../../test/minio.test.ts) cover:

- Construction: defaults (`region`, `forcePathStyle`, endpoint
  hostname/port), region override, missing-endpoint and
  missing-credentials throws.
- `url()`: presigned by default (asserts on `X-Amz-Signature` and
  `X-Amz-Expires=3600` query params), `publicBaseUrl` concatenation.
- Delegation: `upload` and `exists` go through the inner s3 adapter
  unchanged (mocked via `aws-sdk-client-mock`).
- Error relabelling: `mapS3Error` invoked directly with the minio messages
  table to confirm the `"MinIO error"` fallback fires when the source
  error has no message of its own.

Prefer testing minio-specific behaviour (defaults, env fallbacks,
relabelling) rather than re-testing s3 operations — the s3 suite already
covers those end-to-end.

## Coding conventions

- Named exports only — no default exports.
- `process.env` is never touched directly; route every read through
  [`readEnv`](../internal/env.ts) so the adapter still constructs on
  runtimes (Cloudflare Workers without `nodejs_compat`) where `process` is
  undefined.
- Don't reimplement s3 operations here. If a behaviour change needs to land
  for both s3 and minio, change it in `s3/index.ts` and let minio inherit
  it. The only minio-specific code paths should be option defaults, env
  fallback, construction-time validation, and `defaultProviderMessage`.
- Throw `FilesError` for construction failures, never plain `Error`.
- Match the JSDoc style in [`src/index.ts`](../index.ts) — full sentences,
  explain the *why* (e.g. "SigV4 requires *some* region…") not just the
  *what*.

## Releases

`files-sdk` ships as a single package; the `files-sdk/minio` subpath rides
along with every release. Behavioural changes need a changeset at the
monorepo root. Docs-only edits (this file, the MDX page, JSDoc tweaks that
don't change runtime behaviour) don't.

## Where to look next

- Underlying primitive: [`../s3/index.ts`](../s3/index.ts) — every minio
  call funnels through this. Error mapper, presigner, and `existsByProbe`
  scaffold all live there.
- Shared helpers: [`../internal/core.ts`](../internal/core.ts),
  [`../internal/env.ts`](../internal/env.ts),
  [`../internal/errors.ts`](../internal/errors.ts).
- Provider catalog entry: [`../providers/index.ts`](../providers/index.ts).
- User-facing docs:
  [`apps/web/content/docs/adapters/minio.mdx`](../../../../apps/web/content/docs/adapters/minio.mdx).
- SDK README and mental model: [`README.md`](../../README.md) and
  [`SKILL.md`](../../../../skills/files-sdk/SKILL.md).
