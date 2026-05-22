# AGENTS.md — `files-sdk/filebase`

Guidance for coding agents working inside the `files-sdk/filebase`
subpath. The unified `Adapter<Raw>` contract lives in
[`../index.ts`](../index.ts); this file only documents filebase-specific
deviations. `filebase()` is a thin wrapper around
[`s3()`](../s3/index.ts) pointed at [Filebase](https://filebase.com)'s
S3-compatible gateway, which fronts decentralized storage networks
(IPFS, Sia, Storj) with the network chosen *per bucket* in the Filebase
console. See [`../s3/AGENTS.md`](../s3/AGENTS.md) for primitive-level
details on the operation map, error mapping, and presign mechanics.
Cross-references: [`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

`filebase()` is a config translator: every call is forwarded to
`s3({ ... })` with the Filebase endpoint, Filebase credentials, and a
`defaultProviderMessage` of `"Filebase error"` so callers don't see
`"S3 error"` from a Filebase-typed adapter. No per-method code lives
here; every operation is inherited by spread. The only filebase-specific
knobs are the default endpoint (`https://s3.filebase.com`), the
credential env-var pair, and the error-message relabel. The returned
adapter's `raw` is the underlying `@aws-sdk/client-s3` `S3Client`, so
anything the AWS SDK can do against the gateway is one property access
away.

What makes Filebase unusual: the bucket's storage network is chosen in
the dashboard at create time, not per-request. IPFS-backed buckets
populate `x-amz-meta-cid` on `HeadObject` / `GetObject` responses, so
the s3 adapter's pass-through of `result.Metadata` surfaces the content
address as `storedFile.metadata?.cid`. Sia and Storj buckets behave like
opaque S3 with no extra headers.

## Directory layout

```
packages/files-sdk/src/filebase/
├── index.ts        # filebase() factory + FilebaseAdapterOptions
├── AGENTS.md       # this file
└── CLAUDE.md       # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/filebase.test.ts`](../../test/filebase.test.ts);
docs at [`filebase.mdx`](../../../../apps/web/content/docs/adapters/filebase.mdx).
The `filebase` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep it in
sync if the file layout changes.

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/filebase.test.ts   # adapter unit tests only
bun test                          # full SDK suite
bun run build                     # tsup → dist/, including dist/filebase/
bun run types                     # tsgo --noEmit (typecheck only)
```

## Public surface

Exports from [`./index.ts`](./index.ts):

- `filebase(opts: FilebaseAdapterOptions): FilebaseAdapter` — primary
  factory. Throws `FilesError("Provider", "filebase adapter: missing
  credentials…")` when neither option nor env var supplies the key pair.
- `FilebaseAdapter` — type alias for `Adapter<S3Client>`. `raw` is the
  underlying AWS SDK client.
- `FilebaseAdapterOptions` — config interface. JSDoc on every field
  feeds the docs site via `<AutoTypeTable>`; keep those comments
  user-facing.

The returned adapter sets `name: "filebase"` (overriding the inner s3
adapter's `"s3"`) so it's distinguishable in logs and telemetry.

## Authentication / configuration

Required: `bucket` (string, no env fallback), plus `accessKeyId` +
`secretAccessKey` passed in or sourced from `FILEBASE_ACCESS_KEY_ID` /
`FILEBASE_SECRET_ACCESS_KEY`. Missing either credential throws
`FilesError("Provider", …)` at construction.

Optional:

- `endpoint` — overrides `https://s3.filebase.com`. Filebase runs a
  single global gateway, so this is rarely set in production; use it
  for local proxies or test doubles.
- `region` — SigV4 region, defaults to `us-east-1`. Filebase ignores it
  for routing but SigV4 still requires *some* value.
- `forcePathStyle` — defaults to `false`. The gateway supports
  virtual-hosted style on `<bucket>.s3.filebase.com`; flip on only for
  a proxy that demands path-style.
- `publicBaseUrl` — origin used by `url()` when set; skips signing. For
  IPFS-backed buckets the natural value is a CID gateway like
  `https://ipfs.filebase.io/ipfs/<CID>`; Sia and Storj buckets expose
  their own gateway URLs in the dashboard.
- `defaultUrlExpiresIn` — default presigned-URL expiry, seconds.
  Defaults to `3600` via `DEFAULT_URL_EXPIRES_IN` in
  [`../internal/core.ts`](../internal/core.ts).

There is no `FILEBASE_BUCKET` or `FILEBASE_REGION` env-var fallback. The
provider catalog entry in
[`../providers/index.ts`](../providers/index.ts) (search
`slug: "filebase"`) declares the same credential env vars via the shared
`s3Compatible(...)` helper. Env lookups go through
[`readEnv`](../internal/env.ts) so the adapter is safe to import on
runtimes without `process` (Cloudflare Workers without `nodejs_compat`).

## Operation map

`filebase()` calls `s3()` with the resolved config and spreads the
returned adapter, overriding only `name`. Every method — `upload`,
`download`, `head`, `exists`, `delete`, `deleteMany`, `copy`, `list`,
`url`, `signedUploadUrl` — lives in [`../s3/index.ts`](../s3/index.ts)
and is inherited unchanged, including `deleteMany`'s 1000-key chunking,
`signedUploadUrl`'s PUT-vs-presigned-POST split on `maxSize`, and
`exists`' 404-as-`false` classification. Errors flow through
`mapS3Error` with the Filebase fallback table — `Provider`-coded
messages read `"Filebase error"`. `UploadResult` doesn't carry
metadata, so reach for a follow-up `head()` if you need the IPFS CID
at write time.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules:

- **Default**: presigned `GetObject` URL against the gateway, expiring
  after `opts.expiresIn ?? defaultUrlExpiresIn ?? 3600` seconds.
- **With `publicBaseUrl`**: returns `${publicBaseUrl}/${key}` unsigned
  via `joinPublicUrl` from [`../internal/core.ts`](../internal/core.ts)
  (URL-encodes path segments). IPFS gateway URLs serve the
  CID-addressed object regardless of authentication.
- **With `opts.responseContentDisposition`**: always signs, even when
  `publicBaseUrl` is set — a permanent gateway URL has no signature to
  bind the override to, and silently dropping it would be a stored-XSS
  regression on user-uploaded HTML/SVG. See `resolveUrlStrategy` in
  [`../internal/core.ts`](../internal/core.ts).

The natural Filebase setup points `publicBaseUrl` at the per-network
gateway from the dashboard; otherwise every read flows through a
presigned URL against `s3.filebase.com`.

## Provider quirks worth remembering

- **Network is per-bucket, not per-request.** Pick IPFS, Sia, or Storj
  at bucket-creation time in the Filebase console. The S3 API surface
  is identical across all three; the network only changes durability,
  cost, and whether you get a CID back.
- **IPFS buckets surface a CID** as `x-amz-meta-cid` on `HeadObject` /
  `GetObject`; read it off `storedFile.metadata?.cid`. Sia and Storj
  buckets don't populate it.
- **Single global gateway.** `s3.filebase.com` is the only production
  endpoint; `endpoint` exists for proxies and tests rather than regional
  selection. Region is a SigV4 ritual — the gateway ignores it.
- **Access keys** are generated in the Filebase console under *Access
  Keys*; each key is bucket-scoped. No IAM-role equivalent — static
  credentials are the only auth mode the S3-compatible API exposes.
- **No native CDN, but every network has a gateway.** Public reads
  typically flow through the network's gateway (e.g. IPFS) rather than
  back through `s3.filebase.com`; `publicBaseUrl` lets `url()` skip the
  SigV4 round-trip entirely.
- **Errors are relabeled, not reclassified.** HTTP status codes still
  map through the same `S3_NOT_FOUND_CODES` / `S3_UNAUTH_CODES` /
  `S3_CONFLICT_CODES` sets in [`../s3/index.ts`](../s3/index.ts); only
  the unknown-error fallback message changes.

## Testing approach

Unit tests at
[`../../test/filebase.test.ts`](../../test/filebase.test.ts) cover the
narrow surface: default-config plumbing (endpoint `s3.filebase.com`,
`forcePathStyle: false`, `us-east-1`) read off the inner `S3Client`'s
resolved config; explicit `endpoint` / `region` / `forcePathStyle`
overrides reaching the inner client; missing-credential error at
construction (`/credentials/`); env-var fallback via
`FILEBASE_ACCESS_KEY_ID` / `FILEBASE_SECRET_ACCESS_KEY`; `url()`
returning a presigned GET (`X-Amz-Signature=`, `X-Amz-Expires=3600`,
`s3.filebase.com` host) by default and short-circuiting to
`${publicBaseUrl}/${key}` concat when configured; `Files` integration
via `aws-sdk-client-mock` proving `upload` / `exists` reach
`PutObjectCommand` / `HeadObjectCommand`; and `mapS3Error` invoked with
the Filebase table returning `"Filebase error"` for `Provider`.

Add fixtures here rather than to `s3.test.ts` whenever a behavior
depends on filebase-specific config (endpoint host, relabel, env-var
name, CID round-trip); shared S3 semantics belong in
[`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- Named exports only — `filebase`, `FilebaseAdapter`,
  `FilebaseAdapterOptions`.
- Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts); operation
  errors are the inner S3 adapter's responsibility — don't try-catch
  and rethrow in this shim.
- Read env via [`readEnv`](../internal/env.ts); direct `process.env`
  breaks Cloudflare Workers without `nodejs_compat`.
- Forward optional knobs with `...(opts.x !== undefined && { x: opts.x })`
  so unset values fall through to AWS-SDK defaults rather than being
  passed as explicit `undefined`. Spread the inner adapter, then
  override only `name` — preserves any future additions to `Adapter`
  that `s3()` picks up automatically.
- Top-level regex literals only. The current file has none; keep it
  that way unless adding a real parser.

## Releases

Ships with the monorepo from
[`../../package.json`](../../package.json). Behavioral changes (new
options, default changes, error-shape changes) bump `files-sdk` and add
a [`CHANGELOG.md`](../../CHANGELOG.md) entry; docs / test-only edits
don't. The `filebase` subpath is already declared in `exports`.

## Where to look next

- Unified `Adapter` contract: [`../index.ts`](../index.ts); inner S3
  adapter: [`../s3/index.ts`](../s3/index.ts) +
  [`../s3/AGENTS.md`](../s3/AGENTS.md).
- Shared helpers: [`../internal/core.ts`](../internal/core.ts) (URL
  strategy, body normalization, error-mapper factory);
  [`FilesError`](../internal/errors.ts); [`readEnv`](../internal/env.ts).
- Provider catalog (search `slug: "filebase"`):
  [`../providers/index.ts`](../providers/index.ts).
- User-facing docs:
  [`filebase.mdx`](../../../../apps/web/content/docs/adapters/filebase.mdx);
  package [`README.md`](../../README.md);
  [`SKILL.md`](../../../../skills/files-sdk/SKILL.md);
  tests: [`../../test/filebase.test.ts`](../../test/filebase.test.ts).
