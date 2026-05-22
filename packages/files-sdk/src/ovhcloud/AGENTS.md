# AGENTS.md — `files-sdk/ovhcloud`

Guidance for coding agents working on the `ovhcloud` adapter. The unified
`Adapter<Raw>` contract — call shapes, `FilesError`, `UrlOptions`,
`SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file documents ovhcloud-specific
deviations only. `ovhcloud()` is a thin wrapper around
[`s3()`](../s3/index.ts) for OVHcloud Object Storage's S3-compatible
API. OVHcloud ships two tiers — High Performance S3 (native S3, the
default this adapter targets) and Standard (Swift-backed but exposing
the same S3 front door) — and both flow through the inner adapter
unchanged. See [`../s3/AGENTS.md`](../s3/AGENTS.md) for primitive-level
details; cross-reference [`README.md`](../../README.md) and
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A thin shim that calls `s3()` with an OVHcloud endpoint, OVHcloud
credentials, and a `defaultProviderMessage` of `"OVHcloud error"` so
callers don't see `"S3 error"` from an OVHcloud-typed adapter. No
per-method code here: every operation is forwarded by spread. The only
ovhcloud-specific knobs are endpoint derivation from the region code,
the credential env-var pair, and the error-message relabel. The
returned adapter's `raw` is the underlying `@aws-sdk/client-s3`
`S3Client` — anything the AWS SDK can do against OVHcloud (multipart,
lifecycle, versioning where the tier supports it) is one property
access away.

## Directory layout

```
packages/files-sdk/src/ovhcloud/
├── index.ts                   # ovhcloud() factory + OvhcloudAdapterOptions
├── AGENTS.md                  # this file
└── CLAUDE.md                  # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/ovhcloud.test.ts`](../../test/ovhcloud.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/ovhcloud.mdx`](../../../../apps/web/content/docs/adapters/ovhcloud.mdx).

## Build, test, typecheck

Run from `packages/files-sdk/`. The `ovhcloud` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep it in
sync if the file layout changes.

```bash
bun test test/ovhcloud.test.ts   # adapter unit tests only
bun test                          # full SDK suite
bun run build                     # tsup → dist/, including dist/ovhcloud/
bun run types                     # tsgo --noEmit
```

## Public surface

Exports from [`./index.ts`](./index.ts):

- `ovhcloud(opts: OvhcloudAdapterOptions): OvhcloudAdapter` — primary
  factory.
- `OvhcloudAdapter` — alias for `Adapter<S3Client>`. `raw` is the AWS
  SDK client.
- `OvhcloudAdapterOptions` — config interface. JSDoc on every field is
  the source of truth; the docs MDX pulls it via `<AutoTypeTable>`.

The adapter's `name` is `"ovhcloud"` (set after spreading the inner
adapter, so it overrides the S3 adapter's `"s3"`).

## Authentication / configuration

Required:

- `bucket` — string. **No env fallback**; pass it explicitly.
- `region` — OVHcloud region code: `gra`, `sbg`, `bhs`, `de`, `uk`,
  `waw`, `sgp`, `syd` (full list with city names in the JSDoc on
  `OvhcloudAdapterOptions.region`). Drives the endpoint host **and**
  the SigV4 signing region. **No env fallback** — missing region throws
  `FilesError("Provider", 'ovhcloud adapter: missing region. …')`.
- Credentials — `accessKeyId` + `secretAccessKey`, passed in or sourced
  from `OVH_ACCESS_KEY_ID` / `OVH_SECRET_ACCESS_KEY` via
  [`readEnv`](../internal/env.ts). Missing both throws
  `FilesError("Provider", "ovhcloud adapter: missing credentials. …")`.

Optional:

- `endpoint` — overrides the derived
  `https://s3.${region}.io.cloud.ovh.net` (High Performance S3). Pass
  `https://s3.${region}.cloud.ovh.net` for the Standard (Swift-backed)
  tier; OVHcloud routes by Host header, so the SDK still prepends the
  bucket subdomain for virtual-hosted requests.
- `forcePathStyle` — defaults to `false`. Virtual-hosted is canonical
  for OVHcloud; flip on only for proxies that demand path-style.
- `publicBaseUrl` — origin used by `url()` when set; skips signing.
  Natural value for a public container is
  `https://${bucket}.s3.${region}.io.cloud.ovh.net`, or a custom CNAME.
- `defaultUrlExpiresIn` — default presigned-URL expiry in seconds,
  defaults to `3600` via `DEFAULT_URL_EXPIRES_IN` in
  [`../internal/core.ts`](../internal/core.ts).

There is no `OVH_REGION`, `OVH_BUCKET`, or `OVH_ENDPOINT` fallback. The
catalog entry at [`../providers/index.ts`](../providers/index.ts)
(search `slug: "ovhcloud"`) declares the same two credential env vars
and treats `bucket` / `region` as explicit config. Env lookups go
through [`readEnv`](../internal/env.ts) so the adapter stays safe on
runtimes without `process` (Cloudflare Workers without `nodejs_compat`).

## Operation map

`ovhcloud()` calls `s3()` with the resolved config and spreads the
returned adapter, overriding only `name`. Every method (`upload`,
`download`, `head`, `exists`, `delete`, `deleteMany`, `copy`, `list`,
`url`, `signedUploadUrl`) is the s3 implementation talking to OVHcloud
— including `deleteMany`'s 1000-key chunking, `signedUploadUrl`'s
PUT-vs-presigned-POST split on `maxSize`, and `exists`' 404-as-`false`
classification. Provider errors flow through `mapS3Error` with the
OVHcloud fallback table; `Provider`-coded messages read
`"OVHcloud error"` while preserving any server-side message.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules:

- Default: presigned `GetObject` URL, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn` seconds.
- With `publicBaseUrl`: returns `${publicBaseUrl}/${key}` unsigned, via
  `joinPublicUrl` from [`../internal/core.ts`](../internal/core.ts)
  (URL-encodes path segments).
- With `opts.responseContentDisposition`: always signs, even when
  `publicBaseUrl` is set — a permanent URL has no signature in which to
  bind the override, and silently dropping it would be a stored-XSS
  regression on user-uploaded HTML/SVG. See `resolveUrlStrategy` in
  [`../internal/core.ts`](../internal/core.ts) for the rationale.

OVHcloud has no built-in CDN on Object Storage, so the common setup
leaves `publicBaseUrl` unset and reads flow through presigned URLs; a
platform CDN add-on or third-party CDN is the usual unsigned-origin
escape hatch.

## Provider quirks worth remembering

- **Two tiers, one factory.** `ovhcloud()` defaults to High Performance
  S3 (`s3.${region}.io.cloud.ovh.net`); for Standard (Swift-backed),
  pass `endpoint: "https://s3.${region}.cloud.ovh.net"` explicitly.
  Both speak S3 — the inner adapter doesn't care.
- **Region is the endpoint.** Like Akamai and DigitalOcean Spaces, the
  region string is the literal subdomain — pick the wrong code and the
  request goes to the wrong datacenter. It also doubles as the SigV4
  region; mismatches fail signature validation before reaching storage.
- **S3 users are separate from API users.** Generate the key pair in
  the OVHcloud Control Panel under Public Cloud → Object Storage → S3
  users — distinct from OpenStack/Swift credentials, even on Standard.
- **Buckets are single-region** (no cross-region replication) and
  **containers default to private** — set the bucket policy in the
  Control Panel before treating `publicBaseUrl` as live.
- **No env-var sprawl.** The factory reads only `OVH_ACCESS_KEY_ID`
  and `OVH_SECRET_ACCESS_KEY`; everything else is constructor-only.

## Testing approach

Unit tests at [`../../test/ovhcloud.test.ts`](../../test/ovhcloud.test.ts)
cover endpoint derivation from `region` (`gra`, `de`) with the
virtual-hosted default, explicit `endpoint` and `forcePathStyle: true`
overrides reaching the inner `S3Client` config, missing-region and
missing-credential errors at construction, the `OVH_ACCESS_KEY_ID` /
`OVH_SECRET_ACCESS_KEY` env-var fallbacks, `url()` returning a presigned
GET (`X-Amz-Signature=…`, `X-Amz-Expires=3600`) by default and the
`publicBaseUrl` short-circuit, operation delegation via
`aws-sdk-client-mock`'s `mockClient(S3Client)` (proves `upload` and
`exists` reach the underlying client), and the relabel test that
`mapS3Error` with the OVHcloud messages table returns `"OVHcloud error"`
for `Provider`.

Add fixtures here rather than to `s3.test.ts` whenever a behavior
depends on ovhcloud-specific config (endpoint host, relabel, env-var
name); shared S3 semantics belong in
[`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- Named exports only (`ovhcloud`, `OvhcloudAdapter`,
  `OvhcloudAdapterOptions`). Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts); operation
  errors stay the inner S3 adapter's responsibility — no try-catch
  rethrow in this shim.
- Read env via [`readEnv`](../internal/env.ts); direct `process.env`
  breaks Cloudflare Workers without `nodejs_compat`.
- Forward optional knobs with `...(opts.x !== undefined && { x: opts.x })`
  so unset values fall through to the inner `s3()` defaults rather than
  being passed as explicit `undefined` — matters for booleans like
  `forcePathStyle` where `undefined` and `false` differ to the AWS SDK.
- Spread the inner adapter, then override only `name`, so any future
  additions to the `Adapter` interface that `s3()` picks up flow
  through automatically.
- Top-level regex literals only; no emojis in source, tests, or docs.

## Releases

Ships with the monorepo from
[`../../package.json`](../../package.json). Behavioral changes bump
`files-sdk` and add a [`../../CHANGELOG.md`](../../CHANGELOG.md) entry;
docs / test-only additions don't. The `ovhcloud` subpath is already in
`exports` — no further wiring needed for new options.

## Where to look next

- Unified contract: [`../index.ts`](../index.ts); inner S3 adapter:
  [`../s3/index.ts`](../s3/index.ts) +
  [`../s3/AGENTS.md`](../s3/AGENTS.md).
- Shared helpers (URL strategy, body normalization, error-mapper
  factory): [`../internal/core.ts`](../internal/core.ts);
  `FilesError`: [`../internal/errors.ts`](../internal/errors.ts); env
  reader: [`../internal/env.ts`](../internal/env.ts).
- Provider catalog (search `slug: "ovhcloud"`):
  [`../providers/index.ts`](../providers/index.ts).
- Docs:
  [`../../../../apps/web/content/docs/adapters/ovhcloud.mdx`](../../../../apps/web/content/docs/adapters/ovhcloud.mdx);
  README: [`../../README.md`](../../README.md); SKILL:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
- Tests: [`../../test/ovhcloud.test.ts`](../../test/ovhcloud.test.ts).
