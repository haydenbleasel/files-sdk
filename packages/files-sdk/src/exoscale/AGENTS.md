# AGENTS.md — `files-sdk/exoscale`

Guidance for coding agents working on the `exoscale` adapter. The unified
`Adapter<Raw>` contract — call shapes, `FilesError`, `UrlOptions`,
`SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file only documents exoscale-specific
behavior. `exoscale()` is a thin wrapper around [`s3()`](../s3/index.ts)
for Exoscale Object Storage (SOS — Simple Object Storage)'s
S3-compatible API, so operation map, error mapping, and presign
mechanics all live in the S3 adapter — see
[`../s3/AGENTS.md`](../s3/AGENTS.md). Cross-references:
[`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A thin shim that calls `s3()` with an Exoscale SOS endpoint, Exoscale
API-key credentials, and a `defaultProviderMessage` of `"Exoscale error"`
so callers don't see `"S3 error"` from an Exoscale-typed adapter. No
per-method code: every operation is forwarded by spread. The only
exoscale-specific knobs are endpoint derivation from the zone code, the
credential env-var pair, and the error relabel. The returned `raw` is
`@aws-sdk/client-s3`'s `S3Client`, so any AWS SDK feature SOS supports
(multipart, lifecycle rules, versioning) is one property access away.

## Directory layout

```text
packages/files-sdk/src/exoscale/
├── index.ts                   # exoscale() factory + ExoscaleAdapterOptions
├── AGENTS.md                  # this file
└── CLAUDE.md                  # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/exoscale.test.ts`](../../test/exoscale.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/exoscale.mdx`](../../../../apps/web/content/docs/adapters/exoscale.mdx).

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/exoscale.test.ts   # adapter unit tests only
bun test                          # full SDK suite
bun run build                     # tsup → dist/, including dist/exoscale/
bun run types                     # tsgo --noEmit (typecheck only)
```

The `exoscale` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep it in
sync if the file layout changes.

## Public surface

Exports from [`index.ts`](./index.ts):

- `exoscale(opts: ExoscaleAdapterOptions): ExoscaleAdapter` — factory.
- `ExoscaleAdapter` — alias for `Adapter<S3Client>`; `raw` is the AWS
  SDK client.
- `ExoscaleAdapterOptions` — config interface; JSDoc on every field is
  the source of truth (the docs MDX pulls it via `AutoTypeTable`).

Adapter `name` is `"exoscale"` (set after spreading the inner adapter,
overriding `s3()`'s `"s3"`).

## Authentication / configuration

Required:

- `bucket` — string. **No env fallback**; pass it explicitly.
- `region` — Exoscale zone code (`ch-gva-2`, `ch-dk-2`, `de-fra-1`,
  `de-muc-1`, `at-vie-1` / `at-vie-2`, `bg-sof-1` — see the JSDoc for
  the canonical list). Exoscale calls them **zones**, but they fill
  the SigV4 region slot and drive endpoint derivation. **No env
  fallback** — missing region throws `FilesError("Provider", …)` at
  construction with a message that explicitly names the zone-vs-region
  terminology mismatch.
- Credentials — `accessKeyId` + `secretAccessKey`, passed in or sourced
  from `EXOSCALE_API_KEY` / `EXOSCALE_API_SECRET`. Missing both throws
  `FilesError("Provider", …)`.

Optional:

- `endpoint` — overrides the derived `https://sos-${region}.exo.io`
  (use for VPC endpoints, custom CNAMEs, or test doubles).
- `forcePathStyle` — defaults to `false`; flip only for proxies that
  demand path-style.
- `publicBaseUrl` — origin used by `url()` when set; skips signing.
  Natural values are `https://sos-${region}.exo.io/${bucket}`
  (path-style), `https://${bucket}.sos-${region}.exo.io`
  (virtual-hosted), or a custom CNAME fronting the bucket.
- `defaultUrlExpiresIn` — default presigned-URL expiry (seconds);
  defaults to `3600` via `DEFAULT_URL_EXPIRES_IN` in
  [`../internal/core.ts`](../internal/core.ts).

No `EXOSCALE_REGION` or `EXOSCALE_BUCKET` env-var fallback. The provider
catalog entry in [`../providers/index.ts`](../providers/index.ts) (search
`slug: "exoscale"`) declares the same two credential env vars and treats
`bucket` / `region` as explicit config. Env lookups go through
[`readEnv`](../internal/env.ts) so the adapter is safe to import on
runtimes without `process`.

## Operation map

`exoscale()` calls `s3()` and spreads the returned adapter, overriding
only `name`. Every operation (`upload`, `download`, `head`, `exists`,
`delete`, `deleteMany`, `copy`, `list`, `url`, `signedUploadUrl`) lives
in [`../s3/index.ts`](../s3/index.ts) and is inherited unchanged —
including `deleteMany`'s 1000-key chunking, `signedUploadUrl`'s
PUT-vs-presigned-POST split on `maxSize`, and `exists`' 404-as-`false`
classification. Provider errors flow through `mapS3Error` with the
Exoscale fallback table — `Provider` messages read `"Exoscale error"`
while preserving any server-side message on the wire.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules:

- Default: presigned `GetObject` URL, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn` seconds.
- With `publicBaseUrl`: returns `${publicBaseUrl}/${key}` unsigned, via
  `joinPublicUrl` in [`../internal/core.ts`](../internal/core.ts)
  (URL-encodes path segments).
- With `opts.responseContentDisposition`: always signs, even when
  `publicBaseUrl` is set — a permanent CDN URL has no signature to bind
  the override to, and silently dropping it is a stored-XSS regression
  on user-uploaded HTML/SVG. See `resolveUrlStrategy` for the rationale.

SOS has no built-in CDN, so most callers leave `publicBaseUrl` unset and
let reads flow through a presigned URL.

## Provider quirks worth remembering

- **Exoscale calls them "zones", not regions.** Pass the zone code
  (`ch-gva-2`, `de-fra-1`, …) as `region`. The string fills both the
  SigV4 region slot and the endpoint subdomain — pick the wrong one
  and signatures fail before the request reaches the bucket. The
  construction-time error message restates this so users debugging a
  `missing region` throw don't go looking for a zone-shaped option.
- **Endpoint shape is `sos-<zone>.exo.io`** — not `s3.<zone>.…` like
  AWS-style providers, and not `<zone>.exo.io`. Override `endpoint`
  only for VPC hosts or custom CNAMEs.
- **Buckets are zone-scoped.** Pick at create time; the Exoscale Portal
  has no cross-zone replication primitive.
- **Virtual-hosted is canonical.** SOS routes by `Host` header. Set
  `forcePathStyle: true` only for proxies that demand path-style.
- **API keys, not IAM roles.** Generate in the Exoscale Portal under
  *IAM → API Keys*. Static `key` / `secret` pairs are the only auth
  mode the S3-compatible API exposes — no instance-metadata equivalent
  for Exoscale Compute VMs at SOS.

## Testing approach

Unit tests at [`../../test/exoscale.test.ts`](../../test/exoscale.test.ts) cover:

- Endpoint derivation from `region` (`ch-gva-2`, `de-fra-1`) —
  `client.config.endpoint()` hostname is `sos-<zone>.exo.io`,
  `forcePathStyle` defaults to `false`.
- Explicit `endpoint` and `forcePathStyle: true` overrides reaching the
  inner `S3Client` config.
- Missing-region and missing-credential errors at construction.
- `EXOSCALE_API_KEY` / `EXOSCALE_API_SECRET` env-var fallbacks (with
  save/restore around `process.env` so tests stay order-independent).
- `url()` presign default (`X-Amz-Signature`, `X-Amz-Expires=3600`,
  `sos-ch-gva-2.exo.io` host) and `publicBaseUrl` short-circuit.
- Operation delegation via `aws-sdk-client-mock`'s `mockClient(S3Client)`
  — `upload` and `exists` reach the underlying client, including the
  404-as-`false` branch on `HeadObjectCommand`.
- Error relabeling: `mapS3Error` with the Exoscale messages table
  returns `"Exoscale error"` for `Provider`.

Add exoscale-specific fixtures here (endpoint host, relabel, env-var
name); shared S3 semantics belong in
[`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- Named exports only — `exoscale`, `ExoscaleAdapter`,
  `ExoscaleAdapterOptions`.
- Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts); operation
  errors are the inner S3 adapter's responsibility — don't try-catch
  and rethrow in this shim.
- Read env vars via [`readEnv`](../internal/env.ts); direct
  `process.env` access breaks Cloudflare Workers without `nodejs_compat`.
- Forward optional knobs with `...(opts.x !== undefined && { x: opts.x })`
  so unset values fall through to AWS-SDK defaults rather than as
  explicit `undefined`.
- Spread the inner adapter, then override only `name` — preserves any
  future additions to `Adapter` that `s3()` picks up automatically.
- Keep `ExoscaleAdapterOptions` JSDoc accurate — the docs MDX
  `AutoTypeTable` reads this file, so an undocumented field ships
  undocumented.
- Top-level regex literals only.

## Releases

Ships with the rest of the monorepo from
[`../../package.json`](../../package.json). Behavioral changes (new
options, default changes, error-shape changes) bump `files-sdk` and add
an entry to [`../../CHANGELOG.md`](../../CHANGELOG.md); docs / test-only
additions don't. The `exoscale` subpath is already declared in
`exports` — no further wiring needed for new options.

## Where to look next

- Unified contract: [`../index.ts`](../index.ts).
- Inner S3 adapter: [`../s3/index.ts`](../s3/index.ts) +
  [`../s3/AGENTS.md`](../s3/AGENTS.md).
- Shared helpers: [`../internal/core.ts`](../internal/core.ts);
  [`FilesError`](../internal/errors.ts);
  [`readEnv`](../internal/env.ts).
- Provider catalog (search `slug: "exoscale"`):
  [`../providers/index.ts`](../providers/index.ts).
- User docs:
  [`../../../../apps/web/content/docs/adapters/exoscale.mdx`](../../../../apps/web/content/docs/adapters/exoscale.mdx);
  [README](../../README.md);
  [SKILL](../../../../skills/files-sdk/SKILL.md);
  [tests](../../test/exoscale.test.ts).
