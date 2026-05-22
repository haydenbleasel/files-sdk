# AGENTS.md — `files-sdk/hetzner`

Guidance for coding agents working inside the Hetzner Object Storage
adapter. Every adapter in files-sdk implements the same `Adapter<Raw>`
contract from [`packages/files-sdk/src/index.ts`](../index.ts); this
file documents only the deviations and pitfalls specific to `hetzner`.
For the unified API, the package-wide [README.md](../../README.md) and
the agent skill at [`skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md)
are the sources of truth — read them first.

`hetzner` is a thin wrapper around [`s3()`](../s3/index.ts) configured
for Hetzner's S3-compatible Object Storage. Upload, download, presigning,
bulk delete, and error classification all come straight from the inner
`s3` adapter; consult [`../s3/AGENTS.md`](../s3/AGENTS.md) for those
primitive-level details. This file covers only the Hetzner-shaped
defaults layered on top: the derived endpoint, the `HCLOUD_*`
credential fallback, the relabelled error message, and the
construction-time validation.

## Overview

Hetzner Object Storage via the S3 HTTP API. Family: **S3 / S3-compatible
wrapper**. Hetzner is wire-compatible with S3 — there is no dedicated
Hetzner SDK. The factory builds the endpoint from a location code
(`fsn1`, `nbg1`, `hel1`), composes static credentials with `HCLOUD_*`
env vars, and calls `s3()` with the right knobs set, so users get
sensible defaults instead of hand-rolling `s3({ endpoint: ... })`. Peer
dependencies (all optional, in [`package.json`](../../package.json)):

- `@aws-sdk/client-s3`
- `@aws-sdk/s3-presigned-post`
- `@aws-sdk/s3-request-presigner`

## Directory layout

```text
packages/files-sdk/src/hetzner/
├── index.ts                # adapter implementation
├── AGENTS.md               # this file
└── CLAUDE.md               # `@AGENTS.md`
```

Sibling files outside this directory:

- Tests: [`packages/files-sdk/test/hetzner.test.ts`](../../test/hetzner.test.ts)
- User docs: [`apps/web/content/docs/adapters/hetzner.mdx`](../../../../apps/web/content/docs/adapters/hetzner.mdx)
- Provider catalog entry: [`packages/files-sdk/src/providers/index.ts`](../providers/index.ts) (search for `slug: "hetzner"`)
- Underlying S3 adapter: [`packages/files-sdk/src/s3/`](../s3/)

## Build, test, typecheck

```bash
# from packages/files-sdk/
bun test test/hetzner.test.ts       # run only this adapter's tests
bun test                            # run the whole test suite
bun run build                       # tsup ESM bundle -> dist/hetzner/index.js
bun run types                       # tsgo --noEmit
```

Same conventions as the rest of the package: **`bun test`** (not
vitest), **`tsgo`** (not `tsc`). The per-subpath bundle is at
`dist/hetzner/index.{js,d.ts}` per the `exports` map in
[`packages/files-sdk/package.json`](../../package.json).

## Public surface

Defined in [`index.ts`](index.ts):

- `hetzner(opts: HetznerAdapterOptions): HetznerAdapter` — factory
  (lines 57-99). Constructs an inner `s3()` and returns it with `name`
  rewritten to `"hetzner"`. No class, no extra methods.
- `HetznerAdapterOptions` interface (lines 8-53) — `bucket`, `region`,
  `endpoint`, `accessKeyId`, `secretAccessKey`, `forcePathStyle`,
  `publicBaseUrl`, `defaultUrlExpiresIn`. Inline JSDoc is what
  `<AutoTypeTable>` renders into [`apps/web/content/docs/adapters/hetzner.mdx`](../../../../apps/web/content/docs/adapters/hetzner.mdx) —
  treat edits there as public-API changes.
- `HetznerAdapter` type alias — `Adapter<S3Client>`. `raw` is the inner
  `@aws-sdk/client-s3` `S3Client`, so the escape hatch works as it does
  on `s3`. Consumers import via the `files-sdk/hetzner` subpath
  declared in [`../../package.json`](../../package.json).

## Authentication / configuration

Static credentials only — unlike vanilla `s3()`, the AWS credential
chain is **not** used (Hetzner doesn't participate in IMDS, SSO, or
shared-profile flows, so silently picking up ambient AWS credentials
would be a footgun). The factory reads `opts.accessKeyId` /
`opts.secretAccessKey`, falling back to `HCLOUD_ACCESS_KEY_ID` /
`HCLOUD_SECRET_ACCESS_KEY` via `readEnv`
([`../internal/env.ts`](../internal/env.ts)). If either resolves to a
falsy value, the factory throws a `FilesError` with code `Provider`
(lines 68-73). `region` and `bucket` are also required and have no env
fallback — missing region throws a separate `FilesError` (lines 62-67)
with a hint to pass `"fsn1"`.

`opts.endpoint`, when supplied, overrides the derived
`https://${region}.your-objectstorage.com`. `opts.forcePathStyle`,
`opts.publicBaseUrl`, and `opts.defaultUrlExpiresIn` flow through to
`s3()` and follow the rules documented there.

## Operation map

The returned adapter is **the inner `s3()` adapter, spread**, with
`name` overridden to `"hetzner"` (lines 95-98). Every method (`upload`,
`download`, `head`, `exists`, `delete`, `deleteMany`, `copy`, `list`,
`url`, `signedUploadUrl`) is the S3 implementation byte-for-byte —
there is no method-level Hetzner code path. For per-operation details
(lazy body accessors, `DeleteObjects` chunking at 1000 keys,
`existsByProbe` classification, presigned-POST vs presigned-PUT on
`maxSize`), see [`../s3/AGENTS.md`](../s3/AGENTS.md); anything you
change there changes Hetzner too.

The only Hetzner-side adjustments happen at construction: endpoint
derivation (lines 75-76), `defaultProviderMessage: "Hetzner error"`
forwarded to `s3()` (line 86) so the inner `mapS3Error` produces
`"Hetzner error"` for unknown failures, and the `name: "hetzner"`
override (line 97).

## URL behavior

Identical to `s3` — same `resolveUrlStrategy` precedence (see
[`../internal/core.ts`](../internal/core.ts)):

- With `publicBaseUrl` and no `responseContentDisposition`, `url()`
  returns `${publicBaseUrl}/${encodedKey}`. Hetzner Object Storage has
  no built-in CDN, so this is typically a custom CNAME or reverse
  proxy; leaving `publicBaseUrl` unset is the common case.
- Otherwise, `url()` returns a presigned `GetObject` URL signed against
  `<region>.your-objectstorage.com`. Per-call `expiresIn` beats
  `opts.defaultUrlExpiresIn`, which beats `DEFAULT_URL_EXPIRES_IN` (3600s).
- `responseContentDisposition` always forces signing even when
  `publicBaseUrl` is set — same security override rule as `s3`.

## Provider quirks worth remembering

- **Endpoint hostname is `<region>.your-objectstorage.com`.** Not
  `objectstorage.hetzner.com`, not `hetzner.cloud`. Hetzner documents
  only the `your-objectstorage.com` form; getting it wrong fails at
  the TLS handshake, not with an S3 error body, which is awkward to
  debug from a stack trace alone.
- **`region` doubles as the SigV4 region.** Hetzner ignores the region
  for request routing (the endpoint encodes the location), but the SDK
  still includes it in the signature. The factory wires `opts.region`
  into both the endpoint and the SigV4 region exactly to keep them in
  sync — don't split them.
- **No env fallback for `region` or `bucket`.** No Hetzner CLI
  convention exists for these (unlike `AWS_REGION` / `AWS_S3_BUCKET`).
  Don't invent `HCLOUD_REGION` / `HCLOUD_BUCKET` reads unless Hetzner
  adopts canonical names — wire them through `readEnv` in
  [`../internal/env.ts`](../internal/env.ts) the same way the credential
  fallbacks are wired if that day comes.
- **Virtual-hosted style is canonical.** Hetzner routes by `Host` header
  and expects `<bucket>.<region>.your-objectstorage.com`. The adapter
  forwards `forcePathStyle` only when the caller sets it explicitly, so
  the AWS SDK's `false` default carries through. The test suite pins
  `forcePathStyle === false` by default so a drive-by AWS-SDK default
  change would fail loudly.
- **Errors say "Hetzner error".** `defaultProviderMessage` (an
  `@internal` knob on `S3AdapterOptions`) is set to `"Hetzner error"`
  so unknown errors don't read "S3 error" to users importing
  `files-sdk/hetzner`. The final test in `hetzner.test.ts` exercises
  `mapS3Error` with this fallback table directly — preserve that
  coverage when refactoring the inner mapper.

## Testing approach

Tests in [`packages/files-sdk/test/hetzner.test.ts`](../../test/hetzner.test.ts)
use the same pattern as `s3.test.ts`: `aws-sdk-client-mock` against the
inner `S3Client`. Coverage includes endpoint derivation for `fsn1` and
`hel1` plus the explicit `endpoint` override; `forcePathStyle` default
and override; construction-time validation for missing `region` and
missing credentials; env-var credential fallback (`HCLOUD_*`, with
save/restore around ambient values); `url()` defaults and the
`publicBaseUrl` branch; `upload` / `exists` delegation through
`mockClient`; and the relabelled `mapS3Error` fallback asserting
`"Hetzner error"` wins.

Add a test for any new behaviour. The adapter is shallow enough that
test coverage is the only durable guard against a future `s3()`
refactor silently regressing the Hetzner-specific defaults.

## Coding conventions

- Named exports only — no default exports.
- Read env vars exclusively through `readEnv` in
  [`../internal/env.ts`](../internal/env.ts). Bare `process.env` reads
  throw `ReferenceError` on Cloudflare Workers without `nodejs_compat`,
  and the shared helper handles that case.
- Construction-time validation throws `FilesError` with code `Provider`
  ([`../internal/errors.ts`](../internal/errors.ts)). Don't invent new
  codes; the unified set covers the cases here.
- Keep this adapter a thin wrapper. If you need behaviour that differs
  from the inner `s3()` call, extend `S3AdapterOptions` in
  [`../s3/index.ts`](../s3/index.ts) with an opt-in toggle and pass it
  through, instead of forking an operation here. The
  `defaultProviderMessage` / `endpoint` knobs are the existing
  precedent.
- Conditional spread (`...(opts.foo !== undefined && { foo: opts.foo })`)
  is the established pattern for forwarding optional fields without
  collapsing them to `undefined` — keep it consistent with existing
  usage here and in `s3/index.ts`.

## Releases

The repo uses Changesets. Behavioural changes here (env-var names,
default expiries, endpoint derivation, the provider message label) need
a changeset (`bunx changeset`, commit under `.changeset/`); docs and
AGENTS.md edits don't. When an inner `s3()` change affects this
wrapper, call it out in the changeset so users watching only the
Hetzner subpath notice.

## Where to look next

- User-facing docs: [`apps/web/content/docs/adapters/hetzner.mdx`](../../../../apps/web/content/docs/adapters/hetzner.mdx)
- Source and tests: [`index.ts`](index.ts), [`packages/files-sdk/test/hetzner.test.ts`](../../test/hetzner.test.ts)
- Inner S3 adapter: [`packages/files-sdk/src/s3/index.ts`](../s3/index.ts) + [`packages/files-sdk/src/s3/AGENTS.md`](../s3/AGENTS.md)
- Provider catalog entry: [`packages/files-sdk/src/providers/index.ts`](../providers/index.ts)
- Unified Adapter contract and shared helpers: [`packages/files-sdk/src/index.ts`](../index.ts), [`packages/files-sdk/src/internal/core.ts`](../internal/core.ts)
- Package SKILL and README: [`skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md), [`packages/files-sdk/README.md`](../../README.md)
