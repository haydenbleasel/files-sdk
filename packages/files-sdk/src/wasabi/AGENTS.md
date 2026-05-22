# AGENTS.md — `files-sdk/wasabi`

Guidance for coding agents working on the `wasabi` adapter. The unified
`Adapter` contract — call shapes, `FilesError`, `UrlOptions`,
`SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file only documents wasabi-specific
behavior. `wasabi()` is a thin wrapper around [`s3()`](../s3/index.ts)
for [Wasabi Hot Cloud Storage](https://wasabi.com)'s S3-compatible API,
so the operation map, error mapping, and presign mechanics live in the
S3 adapter — see [`../s3/AGENTS.md`](../s3/AGENTS.md) for primitive-level
details. Cross-references: [`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A thin shim that calls `s3()` with a Wasabi endpoint, Wasabi credentials,
and a `defaultProviderMessage` of `"Wasabi error"` so callers don't see
`"S3 error"` from a Wasabi-typed adapter. No per-method code here: every
operation is forwarded by spread. The only wasabi-specific knobs are
endpoint derivation from the region code, the credential env-var pair,
and the error-message relabel. The returned adapter's `raw` is the
underlying `@aws-sdk/client-s3` `S3Client` — anything the AWS SDK can do
against Wasabi (multipart, object lock, lifecycle rules) is one property
access away.

## Directory layout

```
packages/files-sdk/src/wasabi/
├── index.ts                   # wasabi() factory + WasabiAdapterOptions
├── AGENTS.md                  # this file
└── CLAUDE.md                  # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/wasabi.test.ts`](../../test/wasabi.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/wasabi.mdx`](../../../../apps/web/content/docs/adapters/wasabi.mdx).

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/wasabi.test.ts   # adapter unit tests only
bun test                        # full SDK suite
bun run build                   # tsup → dist/, including dist/wasabi/
bun run types                   # tsgo --noEmit (typecheck only)
```

The `wasabi` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep that
entry in sync if the file layout changes.

## Public surface

Exports from [`index.ts`](./index.ts):

- `wasabi(opts: WasabiAdapterOptions): WasabiAdapter` — primary factory.
- `WasabiAdapter` — type alias for `Adapter<S3Client>`. `raw` is the
  underlying AWS SDK client.
- `WasabiAdapterOptions` — config interface (JSDoc on every field is
  the source of truth; the docs MDX pulls it via `AutoTypeTable`).

The adapter's `name` is `"wasabi"` (set after spreading the inner
adapter, so it overrides the S3 adapter's `"s3"`).

## Authentication / configuration

Required:

- `bucket` — string. **No env fallback**; pass it explicitly.
- `region` — Wasabi region code (`us-east-1`, `eu-central-1`,
  `ap-northeast-1`, … — see the JSDoc on `WasabiAdapterOptions.region`
  for the full list). Names mirror AWS but the endpoints are Wasabi's
  own. **No env fallback** — missing region throws
  `FilesError("Provider", …)` at construction.
- Credentials — `accessKeyId` + `secretAccessKey`, passed in or sourced
  from `WASABI_ACCESS_KEY_ID` / `WASABI_SECRET_ACCESS_KEY`. Missing both
  throws `FilesError("Provider", …)`.

Optional:

- `endpoint` — overrides the derived `https://s3.${region}.wasabisys.com`.
  Use for VPC endpoints, region-private DNS, or test doubles.
- `forcePathStyle` — defaults to `false`. Virtual-hosted is canonical
  for Wasabi; only flip this for proxies that demand path-style.
- `publicBaseUrl` — origin used by `url()` when set; skips signing.
  Natural value when used is
  `https://${bucket}.s3.${region}.wasabisys.com` for public-read
  buckets, or a custom CNAME fronting the bucket.
- `defaultUrlExpiresIn` — default presigned-URL expiry in seconds.
  Defaults to `3600` via `DEFAULT_URL_EXPIRES_IN` in
  [`../internal/core.ts`](../internal/core.ts).

There is no `WASABI_REGION` or `WASABI_BUCKET` env-var fallback. The
provider catalog entry in [`../providers/index.ts`](../providers/index.ts)
(search `slug: "wasabi"`) declares the same two credential env vars and
treats `bucket` / `region` as explicit config. Env lookups go through
[`readEnv`](../internal/env.ts) so the adapter is safe to import on
runtimes without `process` (Cloudflare Workers without `nodejs_compat`).

## Operation map

`wasabi()` calls `s3()` with the resolved config and spreads the
returned adapter, overriding only `name`. The implementations of
`upload`, `download`, `head`, `exists`, `delete`, `deleteMany`, `copy`,
`list`, `url`, and `signedUploadUrl` all live in
[`../s3/index.ts`](../s3/index.ts) and are inherited unchanged —
including `deleteMany`'s 1000-key chunking, `signedUploadUrl`'s
PUT-vs-presigned-POST split on `maxSize`, and `exists`' 404-as-`false`
classification. Provider errors flow through `mapS3Error` with the
Wasabi fallback table — `Provider`-coded messages read `"Wasabi error"`
instead of `"S3 error"` while preserving any server-side message on the
wire.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules:

- Default: presigned `GetObject` URL, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn` seconds.
- With `publicBaseUrl`: returns `${publicBaseUrl}/${key}` unsigned, via
  `joinPublicUrl` from [`../internal/core.ts`](../internal/core.ts)
  (URL-encodes path segments).
- With `opts.responseContentDisposition`: always signs, even when
  `publicBaseUrl` is set — a permanent CDN URL has no signature in which
  to bind the override, and silently dropping it would be a stored-XSS
  regression on user-uploaded HTML/SVG. See `resolveUrlStrategy` in
  [`../internal/core.ts`](../internal/core.ts) for the rationale.

Wasabi has no built-in CDN, so the common configuration leaves
`publicBaseUrl` unset and lets every read flow through a presigned URL.

## Provider quirks worth remembering

- **Region names mirror AWS, endpoints don't.** A bucket in `us-east-1`
  lives at `s3.us-east-1.wasabisys.com`, not the AWS origin. The region
  also doubles as the SigV4 region — pick the wrong one and signatures
  fail before the request reaches the bucket.
- **Buckets are single-region.** Pick at create time; there is no
  cross-region replication primitive in the Wasabi console.
- **No native CDN.** `publicBaseUrl` is rare for Wasabi — set it only
  when you've put a CDN (Cloudflare, Bunny, …) in front of the bucket
  manually.
- **90-day minimum storage duration (billing only).** Objects deleted
  before 90 days are still billed for the remainder. Wasabi billing
  rule, not SDK behavior — `delete()` still removes the object
  immediately. Worth surfacing to users planning high-churn workloads.
- **No egress fees** in normal use. Doesn't change the API surface but
  shifts the cost math against S3/R2 for read-heavy workloads.
- **Access keys** are generated in the Wasabi console under *Access
  Keys*. No IAM-role equivalent — static credentials are the only
  auth mode the S3-compatible API exposes.

## Testing approach

Unit tests at [`../../test/wasabi.test.ts`](../../test/wasabi.test.ts)
cover:

- Endpoint derivation from `region` (`us-east-1`, `eu-central-1`).
- Explicit `endpoint` and `forcePathStyle` overrides reaching the inner
  `S3Client` config.
- Missing-region and missing-credential errors at construction.
- `WASABI_ACCESS_KEY_ID` / `WASABI_SECRET_ACCESS_KEY` env-var fallbacks.
- `url()` presign default and `publicBaseUrl` short-circuit.
- Operation delegation via `aws-sdk-client-mock`'s `mockClient(S3Client)`
  — proves `upload` and `exists` reach the underlying client.
- Error relabeling: `mapS3Error` invoked with the Wasabi messages table
  returns `"Wasabi error"` for `Provider`.

Add fixtures here rather than to `s3.test.ts` whenever a behavior depends
on the wasabi-specific config (endpoint host, relabel, env-var name);
shared S3 semantics belong in
[`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- Named exports only — `wasabi`, `WasabiAdapter`, `WasabiAdapterOptions`.
- Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts); operation errors
  are the inner S3 adapter's responsibility — don't try-catch and
  rethrow in this shim.
- Pick up environment variables via [`readEnv`](../internal/env.ts).
  Direct `process.env` access breaks Cloudflare Workers without
  `nodejs_compat`.
- Forward optional knobs with `...(opts.x !== undefined && { x: opts.x })`
  so unset values fall through to AWS-SDK defaults rather than being
  passed as explicit `undefined`.
- Spread the inner adapter, then override only `name` — preserves any
  future additions to the `Adapter` interface that `s3()` picks up
  automatically.
- Top-level regex literals only. The current file has none; keep it
  that way unless adding a real parser.

## Releases

Ships with the rest of the monorepo from
[`../../package.json`](../../package.json). Behavioral changes (new
options, default changes, error-shape changes) bump the `files-sdk`
version and add an entry to [`../../CHANGELOG.md`](../../CHANGELOG.md);
pure docs / test-only additions don't. The `wasabi` subpath is already
declared in `exports` — no further wiring needed for new options.

## Where to look next

- Unified contract & `Adapter` interface: [`../index.ts`](../index.ts).
- Inner S3 adapter: [`../s3/index.ts`](../s3/index.ts) +
  [`../s3/AGENTS.md`](../s3/AGENTS.md).
- Shared helpers (URL strategy, body normalization, error-mapper
  factory): [`../internal/core.ts`](../internal/core.ts).
- `FilesError` and codes: [`../internal/errors.ts`](../internal/errors.ts).
- Env-var reader: [`../internal/env.ts`](../internal/env.ts).
- Provider catalog entry (search `slug: "wasabi"`):
  [`../providers/index.ts`](../providers/index.ts).
- User-facing docs:
  [`../../../../apps/web/content/docs/adapters/wasabi.mdx`](../../../../apps/web/content/docs/adapters/wasabi.mdx).
- Package README: [`../../README.md`](../../README.md).
- SKILL doc:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
- Tests: [`../../test/wasabi.test.ts`](../../test/wasabi.test.ts).
