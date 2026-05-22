# AGENTS.md — `files-sdk/tencent`

Guidance for coding agents working inside the `tencent` adapter. The
unified `Adapter<Raw>` contract (call shapes, `FilesError`,
`UrlOptions`, `SignUploadOptions`, body normalization) lives in
[`../index.ts`](../index.ts); this file documents only the
tencent-specific deviations. `tencent()` is a thin wrapper around
[`s3()`](../s3/index.ts) for Tencent Cloud Object Storage (COS)'s
S3-compatible API — see [`../s3/AGENTS.md`](../s3/AGENTS.md) for
operation, error, and presign primitives. Cross-references:
[`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A thin shim that calls `s3()` with a COS endpoint, Tencent credentials,
and a `defaultProviderMessage` of `"Tencent Cloud error"` so callers
don't see `"S3 error"` from a Tencent-typed adapter. No per-method code
here — every operation is forwarded by spread. The only
tencent-specific knobs are endpoint derivation from the region code,
the credential env-var pair, and the error-message relabel. The
returned adapter's `raw` is the underlying `@aws-sdk/client-s3`
`S3Client`; anything the AWS SDK can do against COS (multipart,
server-side copy, lifecycle) is one property access away.

## Directory layout

```text
packages/files-sdk/src/tencent/
├── index.ts                   # tencent() factory + TencentAdapterOptions
├── AGENTS.md                  # this file
└── CLAUDE.md                  # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/tencent.test.ts`](../../test/tencent.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/tencent.mdx`](../../../../apps/web/content/docs/adapters/tencent.mdx).

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/tencent.test.ts   # adapter unit tests only
bun test                        # full SDK suite
bun run build                   # tsup → dist/, including dist/tencent/
bun run types                   # tsgo --noEmit (typecheck only)
```

The `tencent` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep that
entry in sync if the file layout changes.

## Public surface

Exports from [`index.ts`](./index.ts):

- `tencent(opts: TencentAdapterOptions): TencentAdapter` — primary factory.
- `TencentAdapter` — type alias for `Adapter<S3Client>`.
- `TencentAdapterOptions` — config interface; JSDoc on every field is
  the source of truth and feeds the docs MDX via `AutoTypeTable`.

The adapter's `name` is `"tencent"` (set after spreading the inner
adapter, so it overrides `s3()`'s `"s3"`).

## Authentication / configuration

Required:

- `bucket` — string, **must include the `-<appid>` suffix** (e.g.
  `uploads-1250000000`). COS namespaces bucket names globally by
  `<name>-<appid>`; the bare name yields `NoSuchBucket` on first
  request. No env fallback.
- `region` — COS region code (`ap-guangzhou`, `ap-shanghai`,
  `ap-beijing`, `ap-singapore`, `na-siliconvalley`, `eu-frankfurt`, …;
  full list on `TencentAdapterOptions.region`). Doubles as the SigV4
  region. No env fallback — missing region throws at construction.
- Credentials — `accessKeyId` + `secretAccessKey`, or
  `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` env vars. Missing both
  throws. Env-var names follow Tencent console terminology (SecretId /
  SecretKey).

Optional: `endpoint` (overrides the derived
`https://cos.${region}.myqcloud.com` — use for VPC private endpoints,
COS Accelerate, or test doubles); `forcePathStyle` (defaults to
`false`; virtual-hosted is canonical for COS, flip only for proxies
that demand path-style); `publicBaseUrl` (origin used by `url()` when
set, skipping signing — natural values are
`https://${bucket}.cos.${region}.myqcloud.com` for public-read buckets
or a CDN domain bound to the bucket); `defaultUrlExpiresIn` (default
presigned-URL expiry in seconds, defaults to `3600` via
`DEFAULT_URL_EXPIRES_IN` in [`../internal/core.ts`](../internal/core.ts)).

The provider catalog entry in
[`../providers/index.ts`](../providers/index.ts) (search
`slug: "tencent"`) declares the same env contract via the shared
`s3Compatible(...)` helper. Env lookups go through
[`readEnv`](../internal/env.ts) so the adapter is safe to import on
runtimes without `process` (Cloudflare Workers without `nodejs_compat`).

## Operation map

`tencent()` calls `s3()` with the resolved config and spreads the
returned adapter, overriding only `name`. `upload`, `download`, `head`,
`exists`, `delete`, `deleteMany`, `copy`, `list`, `url`, and
`signedUploadUrl` all live in [`../s3/index.ts`](../s3/index.ts) and
are inherited unchanged — including `deleteMany`'s 1000-key chunking,
`signedUploadUrl`'s PUT-vs-presigned-POST split on `maxSize`, and
`exists`' 404-as-`false` classification. Provider errors flow through
`mapS3Error` with the Tencent fallback table — `Provider`-coded
messages read `"Tencent Cloud error"` instead of `"S3 error"` while
preserving any server-side message on the wire.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules:

- Default: presigned `GetObject` URL, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn` seconds, signed with SigV4
  against `cos.${region}.myqcloud.com`.
- With `publicBaseUrl`: returns `${publicBaseUrl}/${key}` unsigned, via
  `joinPublicUrl` from [`../internal/core.ts`](../internal/core.ts)
  (URL-encodes path segments).
- With `opts.responseContentDisposition`: always signs, even when
  `publicBaseUrl` is set — a permanent CDN URL has no signature in
  which to bind the override. See `resolveUrlStrategy` in
  [`../internal/core.ts`](../internal/core.ts).

Tencent Cloud CDN can be bound to a COS bucket origin; the natural
`publicBaseUrl` value is that CDN domain rather than the raw bucket
origin.

## Provider quirks worth remembering

- **AppId-suffixed bucket names.** COS namespaces buckets globally by
  `<name>-<appid>` (e.g. `uploads-1250000000`). The adapter passes
  `opts.bucket` through verbatim; callers who paste the bare name from
  a console screen get `NoSuchBucket` on the first request. There is
  no auto-derivation — the adapter does not know your AppId.
- **Endpoint host is `cos.<region>.myqcloud.com`, not `s3.…`.** A
  bucket in `ap-guangzhou` lives at `cos.ap-guangzhou.myqcloud.com`.
  Region doubles as the SigV4 region — picking the wrong one fails
  signing before the request reaches the bucket.
- **Buckets are single-region** and immutable after create; cross-region
  replication is a separate console feature, not a runtime knob.
- **No instance-role credential chain.** The COS S3-compatible surface
  has no metadata-service equivalent; static `SecretId` / `SecretKey`
  (generated under *Cloud Access Management → API Keys*) are the only
  auth path, and the construction-time check enforces it.
- **Errors are relabeled, not reclassified.** Status codes still map
  through the same `S3_NOT_FOUND_CODES` / `S3_UNAUTH_CODES` /
  `S3_CONFLICT_CODES` sets in [`../s3/index.ts`](../s3/index.ts); only
  the unknown-error fallback changes to `"Tencent Cloud error"`.

## Testing approach

Unit tests at [`../../test/tencent.test.ts`](../../test/tencent.test.ts)
cover:

- Endpoint derivation from `region` (`ap-guangzhou`, `na-siliconvalley`),
  explicit `endpoint` and `forcePathStyle` overrides reaching the inner
  `S3Client` config.
- Missing-region and missing-credential errors at construction;
  `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` env-var fallbacks.
- `url()` presign default (asserts on `X-Amz-Signature=`,
  `X-Amz-Expires=3600`, and the `cos.<region>.myqcloud.com` host) and
  the `publicBaseUrl` short-circuit.
- Operation delegation via `aws-sdk-client-mock`'s `mockClient(S3Client)`
  — proves `upload` and `exists` reach the underlying client.
- `mapS3Error` returns `"Tencent Cloud error"` for `Provider` when
  invoked with the Tencent messages table.

Add fixtures here rather than to `s3.test.ts` whenever a behavior
depends on tencent-specific config (endpoint host, relabel, env-var
name, AppId-suffix bucket); shared S3 semantics belong in
[`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- Named exports only — `tencent`, `TencentAdapter`,
  `TencentAdapterOptions`. No default exports.
- Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts); operation
  errors are the inner S3 adapter's job — don't try-catch and rethrow
  in this shim.
- Pick up environment variables via [`readEnv`](../internal/env.ts) —
  direct `process.env` access breaks Cloudflare Workers without
  `nodejs_compat`.
- Forward optional knobs with `...(opts.x !== undefined && { x: opts.x })`
  so unset values fall through to AWS-SDK defaults instead of being
  passed as explicit `undefined`.
- Spread the inner adapter and override only `name` — preserves any
  future `Adapter`-interface additions that `s3()` picks up. Top-level
  regex literals only (the current file has none).

## Releases

Ships with the rest of the monorepo from
[`../../package.json`](../../package.json). Behavioral changes (new
options, default changes, error-shape changes) bump the `files-sdk`
version and add an entry to [`../../CHANGELOG.md`](../../CHANGELOG.md);
pure docs / test-only additions don't. The `tencent` subpath is already
declared in `exports` — no further wiring needed.

## Where to look next

- Unified contract: [`../index.ts`](../index.ts).
- Inner S3 adapter: [`../s3/index.ts`](../s3/index.ts) +
  [`../s3/AGENTS.md`](../s3/AGENTS.md).
- Shared helpers: [`../internal/core.ts`](../internal/core.ts);
  `FilesError`: [`../internal/errors.ts`](../internal/errors.ts); env
  reader: [`../internal/env.ts`](../internal/env.ts).
- Provider catalog (search `slug: "tencent"`):
  [`../providers/index.ts`](../providers/index.ts).
- User docs:
  [`../../../../apps/web/content/docs/adapters/tencent.mdx`](../../../../apps/web/content/docs/adapters/tencent.mdx).
- Package README: [`../../README.md`](../../README.md); SKILL:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md);
  tests: [`../../test/tencent.test.ts`](../../test/tencent.test.ts).
