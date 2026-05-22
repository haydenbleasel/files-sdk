# AGENTS.md — `files-sdk/akamai`

Guidance for coding agents working on the Akamai adapter. The unified
`Files` contract every adapter implements lives in
[`../index.ts`](../index.ts) — read it first so the wording here
(`upload`, `download`, `url`, `signedUploadUrl`, …) maps onto the
shared method shapes. The user-facing intro is in
[README.md](../../README.md); the agent-oriented integration guide is
in [SKILL.md](../../../../skills/files-sdk/SKILL.md).

`akamai` is the adapter for Akamai Cloud Object Storage — the
S3-compatible service that used to ship as Linode Object Storage before
the Akamai acquisition. It is a thin wrapper around
[`s3()`](../s3/index.ts) that hands the inner adapter a region-derived
endpoint, a relabelled error message, and otherwise lets it do the work.

## Overview

What the adapter actually owns:

- Defaulting the endpoint to `https://${region}.linodeobjects.com`.
  The `linodeobjects.com` domain is unchanged from the Linode era —
  only the product branding moved to Akamai, so the "wrong-looking"
  hostname is correct.
- Treating region/cluster codes (`us-iad-1`, `nl-ams-1`, `fr-par-1`,
  `gb-lon-1`, `jp-osa-1`, plus the older `us-east-1` /
  `eu-central-1` / `ap-south-1` clusters) as the single source of
  truth for both the endpoint host and the SigV4 signing region.
- Reading credentials from `AKAMAI_ACCESS_KEY_ID` /
  `AKAMAI_SECRET_ACCESS_KEY` (not the AWS chain — that would silently
  pick up the wrong account on a dev laptop).
- Relabelling the fallback `Provider`-code error message to
  `"Akamai error"` so users don't see `"S3 error"` from a stack they
  never imported S3 into.

Everything else — the S3 commands, presigned GET URLs, presigned POST
forms, stream sizing, the `NotFound`/`Unauthorized`/`Conflict`/
`Provider` mapping — is inherited verbatim from the S3 adapter.

## Directory layout

```
packages/files-sdk/src/akamai/
├── index.ts        # AkamaiAdapterOptions + akamai() factory
├── AGENTS.md       # this file
└── CLAUDE.md       # @AGENTS.md pointer
```

Tests live at
[`../../test/akamai.test.ts`](../../test/akamai.test.ts); the
user-facing doc page is
[`../../../../apps/web/content/docs/adapters/akamai.mdx`](../../../../apps/web/content/docs/adapters/akamai.mdx).

## Build, test, typecheck

```bash
bun test test/akamai.test.ts
bun test
bun run build
bun run types
```

Run from `packages/files-sdk/`. First is the iteration loop; the rest are what CI runs.

## Public surface

Exports from [`index.ts`](index.ts):

- `akamai(opts: AkamaiAdapterOptions): AkamaiAdapter` — the factory.
  Returns an `Adapter<S3Client>` whose `name` is `"akamai"` and whose
  `raw` is the underlying `@aws-sdk/client-s3` `S3Client`. Every other
  method is forwarded from the inner `s3()` adapter.
- `AkamaiAdapterOptions` — the constructor options. Rendered into
  [`akamai.mdx`](../../../../apps/web/content/docs/adapters/akamai.mdx)
  via `<AutoTypeTable>`, so keep the JSDoc useful — it is the docs.
- `AkamaiAdapter` — `Adapter<S3Client>` re-exported as a named alias.

The catalog entry that drives the docs landing and CLI lives in
[`../providers/index.ts`](../providers/index.ts) under
`slug: "akamai"`. Update it when env vars, peer deps, or the one-line
description change.

## Authentication / configuration

Required:

- `bucket` — Akamai bucket name. Scopes every operation.
- `region` — Akamai cluster code (e.g. `"us-iad-1"`). Drives the
  endpoint host **and** the SigV4 region. No env fallback — missing
  `region` throws `FilesError("Provider", …)` at construction.
- `accessKeyId` + `secretAccessKey` — option-first, env-fallback to
  `AKAMAI_ACCESS_KEY_ID` / `AKAMAI_SECRET_ACCESS_KEY` via
  [`readEnv`](../internal/env.ts) (safe on Workers without
  `nodejs_compat`). If both option and env are absent, the factory
  throws.

Optional:

- `endpoint` — override the region-derived host (staging, regional
  CNAME).
- `forcePathStyle` — defaults to the AWS SDK default (`false`).
  Virtual-hosted is canonical for Akamai; leave it alone unless
  tooling requires path-style.
- `publicBaseUrl` — CDN/public origin for `url(key)`. When set,
  unsigned `${publicBaseUrl}/${key}` is returned instead of a
  presigned GET. The natural value for a public-ACL bucket is
  `https://${bucket}.${region}.linodeobjects.com`.
- `defaultUrlExpiresIn` — default presigned-GET expiry in seconds.
  Defaults to 3600 via `DEFAULT_URL_EXPIRES_IN` in
  [`../internal/core.ts`](../internal/core.ts).

## Operation map

Every method on the returned adapter is forwarded from
[`s3()`](../s3/index.ts). The wrapper only:

1. Builds `endpoint` from `region` when absent.
2. Threads `defaultProviderMessage: "Akamai error"` into the inner
   adapter so [`mapS3Error`](../s3/index.ts) emits that label
   instead of `"S3 error"` for thrown values with no message.
3. Overrides `name` from `"s3"` to `"akamai"` for telemetry and
   adapter-routing.

For per-method semantics — `upload` body normalization, the
`download` buffer-vs-stream branch, `head`'s lazy GET on the returned
`StoredFile`, `deleteMany`'s 1000-key chunking, `signedUploadUrl`'s
POST-with-`content-length-range` vs PUT precedence, and the
`existsByProbe` `HeadObject` fast path — read
[`../s3/AGENTS.md`](../s3/AGENTS.md).

## URL behavior

`url(key, opts?)` defers to the inner S3 adapter and inherits its
[`resolveUrlStrategy`](../internal/core.ts) precedence:

- `publicBaseUrl` set, no `responseContentDisposition` → unsigned
  `${publicBaseUrl}/${key}`, no expiry.
- Otherwise → presigned `GetObject` with
  `expiresIn ?? defaultUrlExpiresIn ?? 3600` seconds.

`responseContentDisposition` always forces signing, even when
`publicBaseUrl` is configured. A permanent CDN URL has no signature to
bind the override to, and dropping it silently would be a stored-XSS
regression on user-uploaded HTML/SVG.

`signedUploadUrl` follows the same S3 rules: passing `maxSize` returns
a presigned `POST` form (with `content-length-range`), omitting it
returns a presigned `PUT` with no server-side size limit. Always pass
`maxSize` for browser uploads.

## Provider quirks worth remembering

- **Linode-era hostnames are correct.** Endpoints are
  `https://${region}.linodeobjects.com`; the marketing rename did not
  move the domain. Don't rewrite hosts to anything Akamai-branded.
- **Region is the endpoint.** Unlike AWS, the region string isn't just
  metadata — it is the literal subdomain. Pass the exact cluster code
  from the Akamai console.
- **No `AKAMAI_REGION` / `AKAMAI_BUCKET` / `AKAMAI_ENDPOINT` env
  fallbacks.** Only credentials are env-driven; bucket, region, and
  the optional endpoint are constructor-only.
- **Access keys are scoped per cluster** in the Akamai Cloud Manager
  under Object Storage → Access Keys.
- **Errors carry the `"Akamai error"` label** when the underlying SDK
  error has no message — see the relabel test for the exact wiring.

## Testing approach

Unit tests in [`../../test/akamai.test.ts`](../../test/akamai.test.ts)
cover endpoint derivation, the virtual-hosted default, region/endpoint
overrides, explicit `forcePathStyle: true`, missing-region and
missing-credentials throwing at construction, the
`AKAMAI_ACCESS_KEY_ID` / `AKAMAI_SECRET_ACCESS_KEY` env fallback,
`url()` returning a presigned GET by default and the `publicBaseUrl`
short-circuit, delegation to the inner S3 client via
`aws-sdk-client-mock` for `upload` and `exists`, and the `mapS3Error`
relabel that turns the default `"S3 error"` Provider fallback into
`"Akamai error"`.

When adding behavior, extend these tests instead of fabricating new mock setup.

## Coding conventions

- Match the existing factory shape: option-first, env-fallback,
  explicit `FilesError("Provider", …)` for misconfiguration at
  construction.
- Conditional-spread option forwarding (`...(opts.x !== undefined && {
  x: opts.x })`) so the inner `s3()` adapter sees only the keys the
  caller actually set — matters for booleans like `forcePathStyle`
  where `undefined` and `false` mean different things to the SDK.
- Don't reach for `process.env` directly — go through
  [`readEnv`](../internal/env.ts) so the adapter stays usable on
  Cloudflare Workers without `nodejs_compat`.
- Keep the wrapper thin. Behavior shared with the rest of the S3
  family (R2 HTTP, MinIO, DigitalOcean Spaces, Storj, Hetzner,
  Backblaze B2, Wasabi, Tigris, …) belongs in
  [`../s3/index.ts`](../s3/index.ts) or
  [`../internal/core.ts`](../internal/core.ts), not here.
- No emojis in source, tests, or docs.

## Releases

Ships with the monorepo; see [README.md](../../README.md). Adapter
changes need a changeset noting the behavioral delta. Docs-only
changes (this file, MDX edits) don't.

## Where to look next

- User-facing docs:
  [`../../../../apps/web/content/docs/adapters/akamai.mdx`](../../../../apps/web/content/docs/adapters/akamai.mdx)
- Inner adapter wrapped here: [`../s3/index.ts`](../s3/index.ts) (and
  its AGENTS.md once added)
- Unified contract: [`../index.ts`](../index.ts)
- Shared helpers (URL strategy, body normalization, error mapper
  factory): [`../internal/core.ts`](../internal/core.ts)
- Error type: [`../internal/errors.ts`](../internal/errors.ts)
- Env-fallback helper: [`../internal/env.ts`](../internal/env.ts)
- Catalog entry: [`../providers/index.ts`](../providers/index.ts)
  (search `slug: "akamai"`)
- Tests: [`../../test/akamai.test.ts`](../../test/akamai.test.ts)
