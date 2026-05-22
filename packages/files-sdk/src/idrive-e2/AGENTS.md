# AGENTS.md — `files-sdk/idrive-e2`

Guidance for coding agents working inside the `idrive-e2` adapter. The
unified `Adapter<Raw>` contract — call shapes, `FilesError`,
`UrlOptions`, `SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file only documents the
idrive-e2-specific behavior. `idriveE2()` is a thin wrapper around
[`s3()`](../s3/index.ts) for [iDrive e2](https://www.idrive.com/e2/)'s
S3-compatible API, so the operation map, error mapping, and presign
mechanics live in the S3 adapter — see
[`../s3/AGENTS.md`](../s3/AGENTS.md) for primitive-level details.
Cross-references: [`../../README.md`](../../README.md),
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A thin shim that calls `s3()` with the caller-supplied iDrive e2
endpoint, iDrive credentials, a SigV4 region (defaulted to
`"us-east-1"`), and a `defaultProviderMessage` of `"iDrive e2 error"`
so users don't see `"S3 error"` from an iDrive-typed adapter. No
per-method code: every operation is forwarded by spread. The only
idrive-e2-specific knobs are the required endpoint, the credential
env-var pair, the relabelled error, and construction-time validation.
The returned adapter's `raw` is the underlying `S3Client` — anything
the AWS SDK can do against iDrive e2 (multipart, lifecycle, object
versioning where exposed) is one property access away.

## Directory layout

```text
packages/files-sdk/src/idrive-e2/
├── index.ts                # idriveE2() factory + IdriveE2AdapterOptions
├── AGENTS.md               # this file
└── CLAUDE.md               # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/idrive-e2.test.ts`](../../test/idrive-e2.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/idrive-e2.mdx`](../../../../apps/web/content/docs/adapters/idrive-e2.mdx).
Provider catalog entry in
[`../providers/index.ts`](../providers/index.ts) under
`slug: "idrive-e2"`.

## Build, test, typecheck

From `packages/files-sdk`:

```bash
bun test test/idrive-e2.test.ts   # adapter unit tests only
bun test                           # full SDK suite
bun run build                      # tsup → dist/, including dist/idrive-e2/
bun run types                      # tsgo --noEmit (typecheck only)
```

The `idrive-e2` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep it
in sync if the file layout changes.

## Public surface

Exports from [`./index.ts`](./index.ts):

- `idriveE2(opts: IdriveE2AdapterOptions): IdriveE2Adapter` — factory.
- `IdriveE2Adapter` — alias for `Adapter<S3Client>`. `raw` is the
  underlying AWS SDK client.
- `IdriveE2AdapterOptions` — config interface (JSDoc on every field is
  the source of truth; the docs MDX pulls it via `AutoTypeTable`).

The adapter's `name` is `"idrive-e2"` (set after spreading the inner
adapter, so it overrides `"s3"`).

## Authentication / configuration

Required: `bucket` (no env fallback); `endpoint` (no derivation, no
env fallback — see *Provider quirks*); and credentials
(`accessKeyId` + `secretAccessKey`, passed in or sourced from
`IDRIVE_E2_ACCESS_KEY_ID` / `IDRIVE_E2_SECRET_ACCESS_KEY` via
[`readEnv`](../internal/env.ts)). Missing endpoint or credentials
throw `FilesError("Provider", …)` at construction.

Optional: `region` (defaults to `"us-east-1"` — iDrive ignores it for
routing, but SigV4 still needs *some* value); `forcePathStyle`
(defaults to `false`; virtual-hosted on the bucket subdomain is
canonical); `publicBaseUrl` (skips signing — typically a custom CNAME
or reverse proxy since iDrive ships no CDN); `defaultUrlExpiresIn`
(presigned-URL expiry in seconds, defaulting to `3600` via
`DEFAULT_URL_EXPIRES_IN` in
[`../internal/core.ts`](../internal/core.ts)).

Static credentials only — the AWS credential chain is **not**
consulted (iDrive doesn't participate in IMDS or SSO; silently
picking up ambient AWS credentials would be a footgun). Env lookups
go through `readEnv` so the adapter imports cleanly on runtimes
without `process` (Cloudflare Workers without `nodejs_compat`).

## Operation map

`idriveE2()` calls `s3()` with the resolved config and spreads the
returned adapter, overriding only `name`. Every method (`upload`,
`download`, `head`, `exists`, `delete`, `deleteMany`, `copy`, `list`,
`url`, `signedUploadUrl`) is inherited unchanged from
[`../s3/index.ts`](../s3/index.ts) — including `deleteMany`'s
1000-key chunking, `signedUploadUrl`'s PUT-vs-presigned-POST split on
`maxSize`, and `exists`' 404-as-`false` classification. Provider
errors flow through `mapS3Error` with the iDrive fallback table —
`Provider`-coded messages read `"iDrive e2 error"` instead of
`"S3 error"` while preserving any server-side message.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules:

- Default: presigned `GetObject` URL signed against the configured
  endpoint host, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn` seconds.
- With `publicBaseUrl`: returns `${publicBaseUrl}/${key}` unsigned,
  via `joinPublicUrl` from
  [`../internal/core.ts`](../internal/core.ts) (URL-encodes path
  segments).
- With `opts.responseContentDisposition`: always signs, even when
  `publicBaseUrl` is set — a permanent CDN URL has no signature in
  which to bind the override, and silently dropping it would be a
  stored-XSS regression on user-uploaded HTML/SVG. See
  `resolveUrlStrategy` in
  [`../internal/core.ts`](../internal/core.ts).

## Provider quirks worth remembering

- **Endpoint is required and not derivable.** Other S3-compatible
  wrappers here build the host from a region code; iDrive e2
  hostnames are cluster-private (`q9z7.va.idrivee2-NN.com`-shaped —
  cluster id, location code, service shard) and only the dashboard
  (*Access Keys → Endpoint*) knows the exact host. The factory
  throws if `endpoint` is missing rather than signing against a host
  that won't resolve.
- **Region is a SigV4 sentinel, not a routing value.** Defaults to
  `"us-east-1"`; iDrive ignores it for dispatch but SigV4 still
  embeds it in the signature. Revisit only if iDrive starts
  validating it server-side.
- **No env fallback for `region`, `bucket`, or `endpoint`.** No
  iDrive CLI convention exists; inventing `IDRIVE_E2_REGION` /
  `_BUCKET` / `_ENDPOINT` risks colliding with a future official one.
- **Virtual-hosted addressing is canonical.** iDrive e2 routes by
  Host header to the bucket subdomain; the test suite pins
  `forcePathStyle === false` by default so a drive-by AWS-SDK default
  change would fail loudly. No native CDN, so set `publicBaseUrl`
  only when a CDN or reverse proxy has been wired up manually.
- **Errors say `"iDrive e2 error"`.** `defaultProviderMessage` (an
  `@internal` knob on `S3AdapterOptions`) is set so unknown errors
  don't read `"S3 error"`. The final test in `idrive-e2.test.ts`
  exercises `mapS3Error` with this fallback table directly —
  preserve that coverage when refactoring the inner mapper.
- **Access keys** are generated in the iDrive dashboard under
  *Access Keys*; static credentials are the only auth mode.

## Testing approach

Unit tests at
[`../../test/idrive-e2.test.ts`](../../test/idrive-e2.test.ts) cover:
endpoint + protocol round-trip through the inner `S3Client` config
(`q9z7.va.idrivee2-12.com` as the canonical sample host); default
SigV4 region `"us-east-1"` and explicit override; default
`forcePathStyle: false` and explicit override; missing-endpoint and
missing-credential construction errors; `IDRIVE_E2_ACCESS_KEY_ID` /
`IDRIVE_E2_SECRET_ACCESS_KEY` env-var fallbacks (save/restore around
ambient values); `url()` presign default (endpoint host and
`X-Amz-Signature=` in the result) and `publicBaseUrl` short-circuit;
operation delegation via `aws-sdk-client-mock`'s `mockClient(S3Client)`
for `upload` and both `exists` paths (success + 404); and error
relabeling — `mapS3Error` with the iDrive messages table returns
`"iDrive e2 error"` for the `Provider` code.

Add fixtures here when behavior depends on idrive-e2-specific config;
shared S3 semantics belong in [`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- Named exports only — `idriveE2`, `IdriveE2Adapter`,
  `IdriveE2AdapterOptions`.
- Construction-time errors use
  [`FilesError("Provider", …)`](../internal/errors.ts) naming the env
  vars and dashboard; operation errors are the inner S3 adapter's
  responsibility.
- Read env vars via [`readEnv`](../internal/env.ts); direct
  `process.env` access breaks Cloudflare Workers without
  `nodejs_compat`.
- Forward optional knobs with
  `...(opts.x !== undefined && { x: opts.x })` so unset values fall
  through to AWS-SDK defaults instead of being passed as `undefined`.
- Spread the inner adapter, then override only `name` — preserves
  future additions to the `Adapter` interface that `s3()` picks up.
- Top-level regex literals only; brand casing is `"iDrive e2"` in
  user-facing strings and `"idrive-e2"` (kebab) in the slug, adapter
  `name`, subpath, and filenames.

## Releases

Ships with the rest of the monorepo from
[`../../package.json`](../../package.json). Behavioral changes (new
options, default changes, error-shape changes) bump `files-sdk` and
add an entry to [`../../CHANGELOG.md`](../../CHANGELOG.md); docs and
test-only additions don't. The `idrive-e2` subpath is already in
`exports` — no further wiring for new options.

## Where to look next

- Unified `Adapter` contract: [`../index.ts`](../index.ts); inner S3
  adapter: [`../s3/index.ts`](../s3/index.ts) +
  [`../s3/AGENTS.md`](../s3/AGENTS.md).
- Shared helpers (URL strategy, body normalization, error mapper):
  [`../internal/core.ts`](../internal/core.ts); `FilesError`:
  [`../internal/errors.ts`](../internal/errors.ts); env reader:
  [`../internal/env.ts`](../internal/env.ts).
- Provider catalog (search `slug: "idrive-e2"`):
  [`../providers/index.ts`](../providers/index.ts).
- User-facing docs:
  [`../../../../apps/web/content/docs/adapters/idrive-e2.mdx`](../../../../apps/web/content/docs/adapters/idrive-e2.mdx);
  README: [`../../README.md`](../../README.md); SKILL:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md);
  tests: [`../../test/idrive-e2.test.ts`](../../test/idrive-e2.test.ts).
