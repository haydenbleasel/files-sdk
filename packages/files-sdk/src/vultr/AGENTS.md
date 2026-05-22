# AGENTS.md — `files-sdk/vultr`

Guidance for coding agents working inside the `vultr` adapter. The
unified `Adapter<Raw>` contract — call shapes, `FilesError`,
`UrlOptions`, `SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file documents only the
vultr-specific deviations. `vultr()` is a thin wrapper around
[`s3()`](../s3/index.ts) for Vultr Object Storage's S3-compatible API,
so the operation map, error mapping, and presign mechanics live in
the S3 adapter — see [`../s3/AGENTS.md`](../s3/AGENTS.md) for
primitive-level details. Cross-references:
[`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

`vultr(opts)` returns an `Adapter<S3Client>`. It builds an `S3Client`
via the shared `s3()` factory with four Vultr-specific overrides:
endpoint defaults to `https://${region}.vultrobjects.com` (Vultr
routes by Host header; the AWS SDK prepends the bucket subdomain);
credential env fallback reads `VULTR_ACCESS_KEY_ID` /
`VULTR_SECRET_ACCESS_KEY`; provider-error label is rewritten from
`"S3 error"` to `"Vultr error"`; and the returned adapter's `name` is
`"vultr"`, overriding `s3()`'s `"s3"`. Everything else — error
mapping, signing, presigned POST forms, bulk delete chunking, the
`publicBaseUrl` short-circuit, `exists()`'s 404-as-`false`
classification — is inherited unchanged.

## Directory layout

```
packages/files-sdk/src/vultr/
├── index.ts        # vultr() factory + VultrAdapterOptions
├── AGENTS.md       # this file
└── CLAUDE.md       # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/vultr.test.ts`](../../test/vultr.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/vultr.mdx`](../../../../apps/web/content/docs/adapters/vultr.mdx);
provider-catalog entry under `slug: "vultr"` in
[`../providers/index.ts`](../providers/index.ts).

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/vultr.test.ts   # focused adapter tests
bun test                       # whole SDK suite
bun run build                  # tsup ESM bundle → dist/vultr/
bun run types                  # tsgo --noEmit (typecheck only)
```

`tsgo` (typescript-go) — not `tsc`. The `vultr` subpath is enumerated
in [`../../package.json`](../../package.json)'s `exports` map — keep
it in sync. Tests use `bun:test` and `aws-sdk-client-mock` to stub
the underlying `S3Client`.

## Public surface

Exports from [`index.ts`](./index.ts):

- `vultr(opts: VultrAdapterOptions): VultrAdapter` — primary factory.
- `VultrAdapter` — type alias for `Adapter<S3Client>`. `raw` is the
  underlying `@aws-sdk/client-s3` client; reach for it for behaviour
  the unified API doesn't model (multipart, lifecycle, bucket policy).
- `VultrAdapterOptions` — config interface; JSDoc on every field is
  the source of truth (docs MDX pulls it via `AutoTypeTable`).

The factory sets `name: "vultr"` after spreading the inner adapter.

## Authentication / configuration

Required:

- `bucket` — string. **No env fallback**; pass explicitly. Vultr
  routes by Host header.
- `region` — Vultr region code (`ewr`, `sjc`, `ams`, `blr`, `del`,
  `sgp`, `lux`). **No env fallback** — missing region throws
  `FilesError("Provider", …)` at construction. Drives the default
  endpoint host and doubles as the SigV4 region.
- Credentials — `accessKeyId` + `secretAccessKey`, passed in or
  sourced from `VULTR_ACCESS_KEY_ID` / `VULTR_SECRET_ACCESS_KEY`.
  Missing both throws `FilesError("Provider", …)`.

Optional: `endpoint` (overrides
`https://${region}.vultrobjects.com`); `forcePathStyle` (defaults to
`false`, virtual-hosted is canonical); `publicBaseUrl` (origin used
by `url()` when set, skipping signing — natural value is
`https://${bucket}.${region}.vultrobjects.com` for public-ACL buckets
or a custom CNAME); `defaultUrlExpiresIn` (presigned-URL expiry,
defaults to `3600` via `DEFAULT_URL_EXPIRES_IN` in
[`../internal/core.ts`](../internal/core.ts)).

There is no `VULTR_REGION` or `VULTR_BUCKET` convention. The
provider-catalog entry under `slug: "vultr"` in
[`../providers/index.ts`](../providers/index.ts) mirrors this. Env
lookups go through [`readEnv`](../internal/env.ts) so the adapter is
safe to import on runtimes without `process` (Cloudflare Workers
without `nodejs_compat`).

## Operation map

`vultr()` calls `s3()` and spreads the returned adapter, overriding
only `name`. Every method (`upload`, `download`, `head`, `exists`,
`delete`, `deleteMany`, `copy`, `list`, `url`, `signedUploadUrl`) is
the inner `s3()` implementation unchanged — including `deleteMany`'s
1000-key chunking, `signedUploadUrl`'s PUT-vs-presigned-POST split on
`maxSize`, and `exists`' 404-as-`false` classification. Provider
errors flow through `mapS3Error` with the Vultr fallback table; the
upstream message survives when present.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules:

- Default: presigned `GetObject` URL, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn` seconds (default `3600`).
- With `publicBaseUrl`: returns `${publicBaseUrl}/${key}` unsigned via
  `joinPublicUrl` from [`../internal/core.ts`](../internal/core.ts)
  (URL-encodes path segments — pass raw keys, not pre-encoded ones).
- With `opts.responseContentDisposition`: always signs, even when
  `publicBaseUrl` is set — a permanent URL has no signature in which
  to bind the override, and silently dropping it would be a stored-XSS
  regression on user-uploaded HTML/SVG. See `resolveUrlStrategy` in
  [`../internal/core.ts`](../internal/core.ts) for the rationale.

Vultr has no built-in CDN, so `publicBaseUrl` is rare — typical
deployments leave it unset and let every read flow through a presigned URL.

## Provider quirks worth remembering

- **Region codes are short and drive everything.** Three lower-case
  letters, no `-1` suffix. The same value drives both the endpoint
  host (`https://${region}.vultrobjects.com`) and the SigV4 region,
  so a wrong region fails signing before reaching the cluster. Don't
  substitute AWS-style names.
- **No native CDN.** `publicBaseUrl` is only useful with public-ACL
  buckets (natural value
  `https://${bucket}.${region}.vultrobjects.com/${key}`) or an
  external CDN (Cloudflare, Bunny, …).
- **Wire-compatible with S3, not feature-parity.** Object Lock and
  versioning are absent — `raw` calls for them fail at the wire.
- **Static credentials only.** Access keys come from the Vultr portal
  under Object Storage → your subscription → Overview. No IAM-role
  equivalent.

## Testing approach

[`../../test/vultr.test.ts`](../../test/vultr.test.ts) covers the
wrapper-specific behaviour:

- **Endpoint derivation.** Region drives the default host
  (`ewr.vultrobjects.com`, `ams.vultrobjects.com`); explicit
  `endpoint` overrides; `forcePathStyle` defaults to `false` and an
  explicit `true` is forwarded.
- **Credential resolution.** Explicit options win;
  `VULTR_ACCESS_KEY_ID` / `VULTR_SECRET_ACCESS_KEY` are the
  fallbacks; missing region or credentials throw at construction.
- **URL strategy.** Default `url()` signs (`X-Amz-Signature=`,
  `X-Amz-Expires=3600`, `ewr.vultrobjects.com`); `publicBaseUrl`
  short-circuits to plain `${base}/${key}`.
- **Delegation.** `upload` and `exists` go through
  `aws-sdk-client-mock`'s `mockClient(S3Client)` to catch wrapper
  regressions (dropping `defaultProviderMessage` or `endpoint`).
- **Error relabelling.** `mapS3Error` with the Vultr messages table
  returns `"Vultr error"` for `Provider`.

Add wrapper-specific fixtures here; shared S3 semantics belong in
[`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- Named exports only — `vultr`, `VultrAdapter`, `VultrAdapterOptions`.
- Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts); runtime errors
  are the inner S3 adapter's responsibility — don't try-catch and
  rethrow in this shim.
- Read environment via [`readEnv`](../internal/env.ts) — direct
  `process.env` breaks Cloudflare Workers without `nodejs_compat`.
- Forward optional knobs with
  `...(opts.x !== undefined && { x: opts.x })` so unset values fall
  through to AWS-SDK defaults rather than explicit `undefined`.
- Spread the inner adapter, then override only `name` — preserves any
  future additions to the `Adapter` interface that `s3()` picks up.

## Releases

Ships with the rest of `files-sdk` from
[`../../package.json`](../../package.json). Behavioural changes bump
the `files-sdk` version and add an entry to
[`../../CHANGELOG.md`](../../CHANGELOG.md); docs / test-only
additions don't. When adding an option: extend `VultrAdapterOptions`
with JSDoc naming any env fallback and default, thread it into
`s3({...})` with `...(opt !== undefined && { opt })`, mirror
user-visible env vars in
[`../providers/index.ts`](../providers/index.ts), and add a
wrapper-level test.

## Where to look next

- Source / tests: [`./index.ts`](./index.ts),
  [`../../test/vultr.test.ts`](../../test/vultr.test.ts)
- Inner S3 adapter (almost all behaviour lives here):
  [`../s3/index.ts`](../s3/index.ts) +
  [`../s3/AGENTS.md`](../s3/AGENTS.md)
- Unified `Adapter<Raw>` contract: [`../index.ts`](../index.ts)
- Shared helpers (`joinPublicUrl`, `resolveUrlStrategy`,
  `makeErrorMapper`, `existsByProbe`):
  [`../internal/core.ts`](../internal/core.ts)
- `FilesError` / `FilesErrorCode`:
  [`../internal/errors.ts`](../internal/errors.ts);
  env-var reader: [`../internal/env.ts`](../internal/env.ts)
- Provider-catalog entry (search `slug: "vultr"`):
  [`../providers/index.ts`](../providers/index.ts)
- User-facing docs:
  [`../../../../apps/web/content/docs/adapters/vultr.mdx`](../../../../apps/web/content/docs/adapters/vultr.mdx)
- Package README: [`../../README.md`](../../README.md); integration
  skill: [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md)
