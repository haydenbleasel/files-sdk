# AGENTS.md — `files-sdk/ibm-cos`

Guidance for coding agents working on the `ibm-cos` adapter. The unified
`Adapter<Raw>` contract — call shapes, `FilesError`, `UrlOptions`,
`SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file only documents IBM Cloud Object
Storage-specific behavior. `ibmCos()` is a thin wrapper around
[`s3()`](../s3/index.ts) for [IBM Cloud Object Storage](https://www.ibm.com/cloud/object-storage)'s
S3-compatible API, so the operation map, error mapping, and presign
mechanics live in the S3 adapter — see [`../s3/AGENTS.md`](../s3/AGENTS.md)
for primitive-level details. Cross-references: [`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A thin shim that calls `s3()` with an IBM COS endpoint, IBM HMAC
credentials, and a `defaultProviderMessage` of
`"IBM Cloud Object Storage error"` so users importing
`files-sdk/ibm-cos` don't see `"S3 error"`. No per-method code: every
operation is forwarded by spread, and the only IBM-specific logic
happens at construction — endpoint derivation from the region code,
credential env-var pair, error-message relabel, and the
`name: "ibm-cos"` override. The returned adapter's `raw` is the
underlying `@aws-sdk/client-s3` `S3Client`, so anything the AWS SDK
can do against IBM COS (multipart, lifecycle rules, immutable object
storage / WORM) is one property access away.

## Directory layout

```text
packages/files-sdk/src/ibm-cos/
├── index.ts                   # ibmCos() factory + IbmCosAdapterOptions
├── AGENTS.md                  # this file
└── CLAUDE.md                  # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/ibm-cos.test.ts`](../../test/ibm-cos.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/ibm-cos.mdx`](../../../../apps/web/content/docs/adapters/ibm-cos.mdx);
provider catalog entry in [`../providers/index.ts`](../providers/index.ts)
(search `slug: "ibm-cos"`); inner S3 adapter at [`../s3/`](../s3/).

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/ibm-cos.test.ts   # this adapter's tests only
bun test                         # full SDK suite
bun run build                    # tsup -> dist/, including dist/ibm-cos/
bun run types                    # tsgo --noEmit (typecheck only)
```

The `ibm-cos` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep that
in sync if the file layout ever changes.

## Public surface

Exports from [`./index.ts`](./index.ts):

- `ibmCos(opts: IbmCosAdapterOptions): IbmCosAdapter` — primary factory.
  The adapter's `name` is `"ibm-cos"` (set after spreading the inner
  adapter, so it overrides the S3 adapter's `"s3"`).
- `IbmCosAdapter` — type alias for `Adapter<S3Client>`. `raw` is the
  underlying AWS SDK client.
- `IbmCosAdapterOptions` — config interface. JSDoc on every field is
  the source of truth; the docs MDX renders it via `<AutoTypeTable>`,
  so edits to the JSDoc are public-API changes.

## Authentication / configuration

Required (no env fallback for either):

- `bucket` — string.
- `region` — IBM COS region code (`us-south`, `us-east`, `eu-de`,
  `eu-gb`, `eu-es`, `jp-tok`, `jp-osa`, `au-syd`, `br-sao`, `ca-tor`,
  …). Missing region throws `FilesError("Provider", …)` at
  construction. Doubles as the SigV4 region.
- Credentials — `accessKeyId` + `secretAccessKey` HMAC pair, passed in
  or sourced from `IBM_COS_ACCESS_KEY_ID` / `IBM_COS_SECRET_ACCESS_KEY`
  via [`readEnv`](../internal/env.ts). Missing both throws
  `FilesError("Provider", …)`. **Not an IBM Cloud IAM API key** — see
  *Provider quirks*.

Optional:

- `endpoint` — overrides the derived
  `https://s3.${region}.cloud-object-storage.appdomain.cloud`. Use for
  the public / direct / private variants (see *Provider quirks*).
- `forcePathStyle` — defaults to `false`. Virtual-hosted is canonical
  for IBM COS; only flip this for proxies that demand path-style.
- `publicBaseUrl` — origin used by `url()` when set; skips signing.
  Natural value is
  `https://${bucket}.s3.${region}.cloud-object-storage.appdomain.cloud`
  for public-read buckets, or a custom CNAME.
- `defaultUrlExpiresIn` — default presigned-URL expiry in seconds.
  Falls back to `DEFAULT_URL_EXPIRES_IN` (3600) in
  [`../internal/core.ts`](../internal/core.ts) when unset.

## Operation map

`ibmCos()` calls `s3()` and spreads the returned adapter, overriding
only `name`. `upload`, `download`, `head`, `exists`, `delete`,
`deleteMany`, `copy`, `list`, `url`, and `signedUploadUrl` are
inherited unchanged from [`../s3/index.ts`](../s3/index.ts) —
including `deleteMany`'s 1000-key chunking, `signedUploadUrl`'s
PUT-vs-presigned-POST split on `maxSize`, and `exists`' 404-as-`false`
classification. Provider errors flow through `mapS3Error` with the IBM
COS fallback table; `Provider`-coded messages read
`"IBM Cloud Object Storage error"` while preserving any server-side
message on the wire.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules:

- Default: presigned `GetObject` URL, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn` seconds.
- With `publicBaseUrl`: returns `${publicBaseUrl}/${key}` unsigned via
  `joinPublicUrl` from [`../internal/core.ts`](../internal/core.ts)
  (URL-encodes path segments).
- With `opts.responseContentDisposition`: always signs, even when
  `publicBaseUrl` is set — a permanent CDN URL has no signature to
  bind the override to, and silently dropping it would be a stored-XSS
  regression on user-uploaded HTML/SVG. See `resolveUrlStrategy` in
  [`../internal/core.ts`](../internal/core.ts).

IBM COS has no built-in CDN, so `publicBaseUrl` is usually unset.

## Provider quirks worth remembering

- **HMAC credentials only.** IBM Cloud IAM API keys cannot sign S3
  requests; pasting one into `accessKeyId` produces opaque
  `SignatureDoesNotMatch` from the wire with no construction-time
  hint. Generate the HMAC pair by ticking *Advanced options → Include
  HMAC Credential* when creating the IBM COS service credential — the
  resulting object exposes `cos_hmac_keys.access_key_id` /
  `cos_hmac_keys.secret_access_key`, which are the values this adapter
  expects.
- **Endpoint variants route by `Host` header.** Three siblings under
  `*.cloud-object-storage.appdomain.cloud` differ only in hostname:
  public (`s3.${region}.…`, the factory default), direct
  (`s3.direct.${region}.…`, in-region IBM Cloud only), and private
  (`s3.private.${region}.…`, legacy private-network). Pass the variant
  through `opts.endpoint` when running inside the same IBM Cloud
  region — it skips egress fees and keeps traffic on the IBM backbone.
- **Region naming is IBM's, not AWS's.** `us-south`, `eu-de`,
  `jp-tok` look AWS-shaped, but reusing an AWS region string
  (`us-east-1`) silently signs against a non-existent endpoint. The
  factory wires `opts.region` into both the endpoint and the SigV4
  region to keep them in sync.
- **No env fallback for `region` or `bucket`.** IBM Cloud has no
  canonical CLI env-var convention for these. Don't invent
  `IBM_COS_REGION` reads unless IBM publishes one — wire through
  `readEnv` the same way as the credential fallbacks if that day comes.
- **Virtual-hosted style is canonical.** IBM COS expects
  `<bucket>.s3.<region>.cloud-object-storage.appdomain.cloud`. The
  adapter forwards `forcePathStyle` only when the caller sets it
  explicitly, so the AWS SDK's `false` default carries through; the
  test suite pins it to `false` so a drive-by AWS-SDK default change
  would fail loudly.
- **Errors say "IBM Cloud Object Storage error".**
  `defaultProviderMessage` (an `@internal` knob on `S3AdapterOptions`)
  is set so unknown failures don't read "S3 error". The final test in
  [`../../test/ibm-cos.test.ts`](../../test/ibm-cos.test.ts) pins this
  via `mapS3Error` directly — preserve that coverage when refactoring
  the inner mapper.

## Testing approach

Tests in [`../../test/ibm-cos.test.ts`](../../test/ibm-cos.test.ts)
follow the same pattern as `s3.test.ts`: `aws-sdk-client-mock` against
the inner `S3Client`. Coverage includes endpoint derivation for
`us-south` and `eu-de` plus the explicit `endpoint` override;
`forcePathStyle` default and override; construction-time validation
for missing `region` and missing credentials; `IBM_COS_*` env-var
fallback with save/restore around ambient values; `url()` defaults
and the `publicBaseUrl` short-circuit; `upload` / `exists` delegation
through `mockClient`; and the relabelled `mapS3Error` fallback
asserting `"IBM Cloud Object Storage error"` wins.

Add fixtures here rather than to `s3.test.ts` whenever a behavior
depends on IBM COS-specific config (endpoint host, relabel, env-var
name); shared S3 semantics belong in
[`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- Named exports only — `ibmCos`, `IbmCosAdapter`, `IbmCosAdapterOptions`.
- Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts); operation
  errors are the inner S3 adapter's responsibility — don't try-catch
  and rethrow in this shim.
- Read env vars via [`readEnv`](../internal/env.ts); direct
  `process.env` access throws on Cloudflare Workers without
  `nodejs_compat`.
- Forward optional knobs with
  `...(opts.x !== undefined && { x: opts.x })` so unset values fall
  through to AWS-SDK defaults rather than as explicit `undefined`.
- Spread the inner adapter, then override only `name` — preserves
  future `Adapter` additions that `s3()` picks up. Top-level regex
  literals only.

## Releases

Ships with the rest of the monorepo from
[`../../package.json`](../../package.json). Behavioral changes (new
options, default changes, endpoint derivation tweaks, env-var renames)
bump the `files-sdk` version and add an entry to
[`../../CHANGELOG.md`](../../CHANGELOG.md); docs / test-only additions
don't. When an inner `s3()` change affects this wrapper, call it out
in the changeset so users watching only `files-sdk/ibm-cos` notice.

## Where to look next

- Unified contract: [`../index.ts`](../index.ts).
- Inner S3 adapter: [`../s3/index.ts`](../s3/index.ts) +
  [`../s3/AGENTS.md`](../s3/AGENTS.md).
- Shared helpers (URL strategy, body normalization, error-mapper
  factory): [`../internal/core.ts`](../internal/core.ts).
- `FilesError`: [`../internal/errors.ts`](../internal/errors.ts). Env
  reader: [`../internal/env.ts`](../internal/env.ts). Provider
  catalog (search `slug: "ibm-cos"`):
  [`../providers/index.ts`](../providers/index.ts).
- User-facing docs:
  [`../../../../apps/web/content/docs/adapters/ibm-cos.mdx`](../../../../apps/web/content/docs/adapters/ibm-cos.mdx).
  Tests: [`../../test/ibm-cos.test.ts`](../../test/ibm-cos.test.ts).
- Package README: [`../../README.md`](../../README.md). SKILL:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
