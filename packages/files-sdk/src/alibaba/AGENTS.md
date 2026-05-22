# AGENTS.md — `files-sdk/alibaba`

Guidance for coding agents working on the `alibaba` adapter. The
unified `Adapter<Raw>` contract — call shapes, `FilesError`,
`UrlOptions`, `SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file documents only the
alibaba-specific deviations. `alibaba()` wraps [`s3()`](../s3/index.ts)
for [Alibaba Cloud OSS](https://www.alibabacloud.com/product/oss)'s
S3-compatible API, so operation semantics, error mapping, and presign
mechanics live in [`../s3/AGENTS.md`](../s3/AGENTS.md) — read it for
the primitives. Cross-refs: [`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A thin shim. `alibaba()` calls `s3()` with an OSS endpoint, Alibaba
credentials, and a `defaultProviderMessage` of `"Alibaba Cloud error"`
so callers never see `"S3 error"` from an Alibaba-typed adapter. No
per-method code lives here — every operation is forwarded by spread.
The only alibaba-specific knobs are endpoint derivation from the
region, the credential env-var pair, and the error-message relabel.
`raw` is the underlying `@aws-sdk/client-s3` `S3Client`, so any OSS
feature the AWS SDK can drive (multipart, lifecycle, SSE headers,
image processing) is one property access away.

## Directory layout

```text
packages/files-sdk/src/alibaba/
├── index.ts         # alibaba() factory + AlibabaAdapterOptions
├── AGENTS.md        # this file
└── CLAUDE.md        # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/alibaba.test.ts`](../../test/alibaba.test.ts);
user docs at
[`../../../../apps/web/content/docs/adapters/alibaba.mdx`](../../../../apps/web/content/docs/adapters/alibaba.mdx).

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/alibaba.test.ts   # adapter unit tests only
bun test                        # full SDK suite
bun run build                   # tsup → dist/, incl. dist/alibaba/
bun run types                   # tsgo --noEmit
```

The `alibaba` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep it
in sync if the file layout changes.

## Public surface

Exports from [`index.ts`](./index.ts):

- `alibaba(opts: AlibabaAdapterOptions): AlibabaAdapter` — primary
  factory. The adapter's `name` is `"alibaba"`, overriding `"s3"`.
- `AlibabaAdapter` — type alias for `Adapter<S3Client>`; `raw` is the
  underlying AWS SDK client.
- `AlibabaAdapterOptions` — config interface. JSDoc on every field is
  the source of truth; the docs MDX renders it via `AutoTypeTable`.

## Authentication / configuration

Required:

- `bucket` — string. **No env fallback**; pass it explicitly.
- `region` — OSS region code (`cn-hangzhou`, `cn-shanghai`,
  `cn-beijing`, `ap-southeast-1`, `us-east-1`, `eu-central-1`, …).
  **No env fallback** — missing region throws
  `FilesError("Provider", …)` at construction. Pass the **bare** code
  (`"cn-hangzhou"`), not the `oss-`-prefixed DNS form: the same value
  doubles as the SigV4 region, and `"oss-cn-hangzhou"` produces
  signatures OSS rejects.
- Credentials — `accessKeyId` + `secretAccessKey`, passed in or
  sourced from `ALIBABA_ACCESS_KEY_ID` / `ALIBABA_ACCESS_KEY_SECRET`.
  Missing either throws `FilesError("Provider", …)`. Generate the
  AccessKey pair in the Alibaba Cloud console under *RAM → Users* —
  the S3-compatible surface has no IAM-role equivalent.

Optional:

- `endpoint` — overrides the derived
  `https://oss-${region}.aliyuncs.com`. Use for VPC-internal endpoints
  (`oss-${region}-internal.aliyuncs.com`), acceleration endpoints, or
  test doubles.
- `forcePathStyle` — defaults to `false`. Virtual-hosted is canonical
  for OSS; flip only for proxies that demand path-style.
- `publicBaseUrl` — origin used by `url()` when set; skips signing.
  Natural value is `https://${bucket}.oss-${region}.aliyuncs.com`, or
  a custom domain CNAME'd to the bucket.
- `defaultUrlExpiresIn` — default presigned-URL expiry in seconds.
  Falls back to `DEFAULT_URL_EXPIRES_IN` (3600) from
  [`../internal/core.ts`](../internal/core.ts).

No `ALIBABA_REGION` / `ALIBABA_BUCKET` / `ALIBABA_ENDPOINT` env
fallback — the provider catalog at
[`../providers/index.ts`](../providers/index.ts) declares only the two
credential env vars. Env lookups go through
[`readEnv`](../internal/env.ts) so the adapter stays safe on runtimes
without `process` (Cloudflare Workers without `nodejs_compat`).

## Operation map

`alibaba()` calls `s3()` with the resolved config and spreads the
returned adapter, overriding only `name`. `upload`, `download`,
`head`, `exists`, `delete`, `deleteMany`, `copy`, `list`, `url`, and
`signedUploadUrl` all live in [`../s3/index.ts`](../s3/index.ts) and
are inherited unchanged — `deleteMany`'s 1000-key chunking,
`signedUploadUrl`'s PUT-vs-presigned-POST split on `maxSize`,
`exists` 404-as-`false`, and the stream-upload follow-up `head()` for
authoritative size / `lastModified` all carry over. Errors flow
through `mapS3Error` with the Alibaba fallback table — `Provider`
messages read `"Alibaba Cloud error"`, and the server-side message
wins when present.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules:

- Default: presigned `GetObject`, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn` seconds, against the
  configured (or derived) OSS endpoint with the bucket subdomain
  prepended.
- With `publicBaseUrl`: returns `${publicBaseUrl}/${key}` unsigned via
  `joinPublicUrl` (URL-encodes path segments).
- With `opts.responseContentDisposition`: always signs, even when
  `publicBaseUrl` is set — a permanent URL has no signature in which
  to bind the override, and silently dropping it would be a stored-XSS
  regression on user-uploaded HTML/SVG. See `resolveUrlStrategy` in
  [`../internal/core.ts`](../internal/core.ts).

## Provider quirks worth remembering

- **Region is part of the hostname *and* the signature.** Buckets
  live in exactly one region; the endpoint host
  (`oss-<region>.aliyuncs.com`) and the SigV4 region must both match
  where the bucket was created. A mismatch surfaces as a `301`/`400`
  from OSS with a frequently-empty body — re-check the bucket's
  region first when signatures suddenly stop working.
- **Public vs internal endpoints.** Intra-region ECS/VPC traffic
  should use `oss-<region>-internal.aliyuncs.com` (free, lower
  latency, unreachable from outside). The adapter does not auto-
  switch — set `endpoint` explicitly when running in Alibaba Cloud.
- **Region naming overlaps with AWS; endpoints don't.** A bucket in
  `us-east-1` lives at `oss-us-east-1.aliyuncs.com`, not on the AWS
  origin. Treat the region string as opaque OSS shorthand.
- **Env-var spelling is `_ACCESS_KEY_SECRET`**, not the
  `_SECRET_ACCESS_KEY` suffix the AWS-derived adapters use. The
  adapter follows Alibaba's own naming so users can paste from
  Alibaba docs — don't "fix" without a coordinated breaking change.
- **Custom domains need both halves**: bound to the bucket in the OSS
  console *and* a matching DNS CNAME, before `publicBaseUrl` resolves.
- **OSS-only features** (storage-class transitions, image processing,
  symlinks, PUT callbacks) live on the AWS SDK client — reach for
  `files.raw`; none ride on the unified surface.

## Testing approach

Unit tests at
[`../../test/alibaba.test.ts`](../../test/alibaba.test.ts) cover:

- Endpoint derivation from `region` (`cn-hangzhou`, `ap-southeast-1`),
  default `forcePathStyle: false`, and explicit `endpoint` /
  `forcePathStyle` overrides reaching the inner `S3Client` config.
- Missing-region and missing-credential errors at construction.
- `ALIBABA_ACCESS_KEY_ID` / `ALIBABA_ACCESS_KEY_SECRET` env-var
  fallbacks (with save/restore around `process.env` mutation).
- `url()` presign default (`X-Amz-Signature`, `X-Amz-Expires=3600`,
  OSS hostname) and the `publicBaseUrl` short-circuit.
- Operation delegation via `aws-sdk-client-mock` — `upload` reaches
  the underlying client; `exists` returns `false` on a synthetic 404.
- Error relabeling: `mapS3Error` with the Alibaba messages table
  returns `"Alibaba Cloud error"` for `Provider`.

Add fixtures here when behavior depends on alibaba-specific config;
shared S3 semantics belong in
[`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- Named exports only — `alibaba`, `AlibabaAdapter`,
  `AlibabaAdapterOptions`.
- Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts); operation
  errors are the inner S3 adapter's responsibility — don't try-catch
  here.
- Read env via [`readEnv`](../internal/env.ts); direct `process.env`
  breaks Cloudflare Workers without `nodejs_compat`.
- Forward optional knobs with
  `...(opts.x !== undefined && { x: opts.x })` so unset values fall
  through to AWS-SDK defaults; `publicBaseUrl` is gated on truthiness
  — an empty string is never a valid base URL.
- Spread the inner adapter, then override only `name` — preserves any
  future `Adapter` additions `s3()` picks up automatically.
- Top-level regex literals only.

## Releases

Ships with the monorepo from
[`../../package.json`](../../package.json). Behavioral changes bump
the `files-sdk` version and need a
[`../../CHANGELOG.md`](../../CHANGELOG.md) entry; docs / test-only
additions don't. The `alibaba` subpath is already in `exports` —
layout changes inside this directory don't ripple to consumers unless
`index.ts` moves.

## Where to look next

- Unified contract: [`../index.ts`](../index.ts).
- Inner S3 adapter: [`../s3/index.ts`](../s3/index.ts) +
  [`../s3/AGENTS.md`](../s3/AGENTS.md).
- Shared helpers: [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts).
- Provider catalog (`slug: "alibaba"`):
  [`../providers/index.ts`](../providers/index.ts).
- User docs:
  [`../../../../apps/web/content/docs/adapters/alibaba.mdx`](../../../../apps/web/content/docs/adapters/alibaba.mdx).
- README: [`../../README.md`](../../README.md). SKILL:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
- Tests: [`../../test/alibaba.test.ts`](../../test/alibaba.test.ts).
