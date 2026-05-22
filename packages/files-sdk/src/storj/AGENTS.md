# AGENTS.md — `files-sdk/storj`

Guidance for coding agents working inside the `files-sdk/storj` subpath.
The unified `Adapter<Raw>` contract lives in
[`../index.ts`](../index.ts) — this file documents only the
storj-specific deviations. The adapter is a thin wrapper around the
`s3()` factory pointed at Storj's S3-compatible Gateway-MT, so most
runtime behavior is inherited from [`../s3/`](../s3/). Cross-reference
the [README](../../README.md) and the
[`files-sdk` skill](../../../../skills/files-sdk/SKILL.md) for
package-wide conventions.

## Overview

`files-sdk/storj` exposes a single `storj()` factory: configure it with
a bucket and Storj S3-gateway credentials, and get back an
`Adapter<S3Client>` that talks to Storj DCS as if it were S3. Three
things change versus a raw `s3({ ... })` call:

- The endpoint defaults to `https://gateway.storjshare.io` (Gateway MT —
  Storj's hosted multi-tenant gateway). Override with a self-hosted
  Gateway ST URL if you run your own.
- `forcePathStyle` defaults to `true` (the gateway routes path-style)
  and the SigV4 signing region defaults to `us-east-1` (the gateway
  ignores region for routing, but SigV4 requires _some_ region).
- The inner s3 adapter's unknown-error fallback is relabeled to
  `"Storj error"` via `defaultProviderMessage`, so callers don't see
  `"S3 error"` from a Storj endpoint.

Everything else — body normalization, URL semantics, presigned
uploads, `deleteMany` chunking, error classification — is the s3
adapter's behavior. Read [`../s3/index.ts`](../s3/index.ts) when
chasing a protocol-level question.

## Directory layout

```
packages/files-sdk/src/storj/
└── index.ts         # storj() factory + StorjAdapterOptions
```

Tests live one level up at
[`../../test/storj.test.ts`](../../test/storj.test.ts) — the package
keeps all adapter tests in a shared `test/` directory rather than
colocating.

## Build, test, typecheck

```bash
bun test test/storj.test.ts   # focused storj suite
bun test                      # full suite, run from packages/files-sdk
bun run build                 # tsup ESM bundle → dist/
bun run types                 # tsgo --noEmit
```

`build` and `types` cover the whole package; there's no per-adapter
script. The `exports` map already lists `./storj`, so a fresh build
picks up changes here automatically.

## Public surface

[`./index.ts`](./index.ts) exports three names:

- `storj(opts: StorjAdapterOptions): StorjAdapter` — the factory.
  Throws `FilesError("Provider", "storj adapter: missing credentials…")`
  at construction time when neither option nor env var supplies the
  S3-gateway key pair.
- `StorjAdapterOptions` — the option type. JSDoc on each field is
  rendered into the docs site by `<AutoTypeTable>` in
  [`storj.mdx`](../../../../apps/web/content/docs/adapters/storj.mdx),
  so keep those comments user-facing.
- `StorjAdapter` — type alias for `Adapter<S3Client>`. The native
  client is reachable via `files.raw` (typed as `S3Client`) for any
  Storj/S3 feature the unified surface doesn't expose.

The returned adapter sets `name: "storj"` so it's distinguishable from
the underlying `s3()` instance in logs and telemetry.

## Authentication / configuration

| Option                | Required | Default                            | Notes                                                                                   |
| --------------------- | -------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| `bucket`              | yes      | —                                  | Storj bucket name. Scopes every operation.                                              |
| `accessKeyId`         | yes\*    | `STORJ_ACCESS_KEY_ID`              | Gateway-issued S3-style key, _not_ a Storj access grant.                                |
| `secretAccessKey`     | yes\*    | `STORJ_SECRET_ACCESS_KEY`          | Gateway-issued secret.                                                                  |
| `endpoint`            | no       | `https://gateway.storjshare.io`    | Gateway MT (hosted). Pass a Gateway ST URL when self-hosting.                           |
| `region`              | no       | `us-east-1`                        | Used for SigV4 signing only — the gateway ignores it for routing.                       |
| `forcePathStyle`      | no       | `true`                             | Gateway routes path-style. Flip off only if you've fronted it with subdomain routing.   |
| `publicBaseUrl`       | no       | —                                  | Storj Linksharing origin for unsigned reads (see [URL behavior](#url-behavior)).        |
| `defaultUrlExpiresIn` | no       | `3600`                             | Fallback expiry, in seconds, for presigned `url()` results when `publicBaseUrl` unset.  |

\* Pass explicitly or set the matching env var. The factory reads env
via [`readEnv`](../internal/env.ts) so it stays safe on runtimes
without a `process` global; if both are missing, construction throws
rather than letting the inner s3 client raise on the first request.
Options are spread conditionally into the inner `s3({ ... })` call so
an undefined value never clobbers the s3 adapter's own default. The
provider-catalog row in [`../providers/index.ts`](../providers/index.ts)
declares the same env contract via the shared `s3Compatible(...)`
helper.

## Operation map

`storj()` returns the inner s3 adapter verbatim, overriding only `name`
(`return { ...inner, name: "storj" }`). Every method (`upload`,
`download`, `head`, `exists`, `delete`, `deleteMany`, `copy`, `list`,
`url`, `signedUploadUrl`) is the s3 implementation talking to the
gateway. Inherited behavior worth calling out:

- `deleteMany` uses S3's native `DeleteObjects` and chunks at 1000 keys
  per request — the gateway accepts the same batch limit.
- `exists()` distinguishes `NotFound` from auth / transport failures the
  same way the s3 adapter does; only `NotFound` returns `false`.
- `signedUploadUrl({ maxSize })` returns a presigned POST form with a
  `content-length-range` policy; without `maxSize` it falls back to a
  presigned PUT with no size limit.
- `copy()` issues a `CopyObject` through the gateway — server-side, no
  read-then-write roundtrip.

If you need storj-specific behavior, prefer wrapping the returned
adapter at this layer rather than forking the s3 implementation.

## URL behavior

`url(key, opts?)` follows the s3 adapter's two-state strategy
(`resolveUrlStrategy` in [`../internal/core.ts`](../internal/core.ts)):

- **No `publicBaseUrl`** → presigned `GetObject` against the gateway,
  signed with the gateway's SigV4 (Storj has no native URL signer),
  expiring after `opts.expiresIn ?? defaultUrlExpiresIn ?? 3600` seconds.
- **`publicBaseUrl` set** → unsigned concat: `${publicBaseUrl}/${key}`.
  For Storj, the canonical value is a Linksharing prefix like
  `https://link.storjshare.io/raw/<accessGrant>/<bucket>` — generate
  one with `uplink share --url <bucket>/<prefix>`. Linksharing URLs
  are permanent and don't carry signatures.
- **`responseContentDisposition` set** → forces the signing path even
  when `publicBaseUrl` is configured, since a permanent Linksharing
  URL has no signature to bind the override to.

Callers are responsible for URL-encoding key segments — `joinPublicUrl`
in `../internal/core.ts` handles encoding for both paths.

## Provider quirks worth remembering

- **Access keys ≠ access grants.** What Storj calls an "access grant"
  is the satellite-issued macaroon used by `uplink`. The S3 gateway
  expects a derived S3-style `accessKeyId` / `secretAccessKey` pair
  registered with the gateway, which translates server-side. Don't
  paste a grant into either field.
- **Region is a SigV4 ritual.** `us-east-1` exists only to satisfy the
  signer — the gateway ignores it. Override only if another tool needs
  a matching value.
- **Linksharing is per-access-grant.** `uplink share --url` mints a
  prefix tied to whatever scope (`bucket`, `bucket/prefix/`,
  read-only, expiring) you granted. Treat the URL as sensitive — anyone
  with it can read everything that grant covers.
- **Errors are relabeled, not reclassified.** Status codes still map
  through the same `S3_NOT_FOUND_CODES` / `S3_UNAUTH_CODES` /
  `S3_CONFLICT_CODES` sets in [`../s3/index.ts`](../s3/index.ts); only
  the unknown-error fallback message changes to `"Storj error"`.

## Testing approach

[`../../test/storj.test.ts`](../../test/storj.test.ts) covers the
adapter's narrow surface:

- Default-config plumbing — Gateway-MT endpoint, `forcePathStyle: true`,
  `us-east-1` region — read off the inner `S3Client`'s resolved config.
- `region` and `endpoint` overrides flow through to the inner client.
- Missing credentials throw at factory time with a `/credentials/`
  message.
- `url()` returns a presigned GET (with `X-Amz-Signature=…` and
  `X-Amz-Expires=3600`) by default, and switches to Linksharing-style
  concat when `publicBaseUrl` is set.
- `Files` integration via `aws-sdk-client-mock` — `upload` and `exists`
  go through `PutObjectCommand` and `HeadObjectCommand` like raw s3.
- `mapS3Error` is exercised directly with the storj message table to
  confirm the `Provider` fallback says `"Storj error"`.

When adding tests, follow the same pattern: stub `S3Client` with
`mockClient` rather than reaching for a live gateway.

## Coding conventions

- Named exports only (`storj`, `StorjAdapter`, `StorjAdapterOptions`).
- All env reads go through [`readEnv`](../internal/env.ts) — don't
  touch `process.env` directly.
- Spread options into the inner `s3()` call conditionally
  (`...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl })`)
  so leaving an option `undefined` preserves the s3 adapter's default.
- Construction-time errors throw `FilesError("Provider", …)` with a
  message that names the adapter (`"storj adapter: …"`), matching the
  pattern `s3()` uses for its missing-region check.
- Keep the factory boring: it's a config translator, not a behavior
  layer. If a storj-only quirk surfaces, prefer a flag on the inner
  s3 adapter over branching inside `storj()`.

## Releases

This package ships on the repo-wide Changesets schedule. Behavioural
changes need a changeset (`bun changeset`, pick `files-sdk`) describing
the user-visible effect. Adapter additions are minor bumps;
storj-specific bug fixes are patches. AGENTS.md, README, and docs-only
edits don't need a changeset.

## Where to look next

- User-facing docs: [`../../../../apps/web/content/docs/adapters/storj.mdx`](../../../../apps/web/content/docs/adapters/storj.mdx)
- Underlying primitive: [`../s3/index.ts`](../s3/index.ts) — `s3()`,
  `S3AdapterOptions`, `mapS3Error`, default error code sets.
- Adapter contract: [`../index.ts`](../index.ts) — `Adapter<Raw>`,
  `UploadOptions`, `UrlOptions`, `SignUploadOptions`.
- Shared helpers used via s3: [`../internal/core.ts`](../internal/core.ts)
  (`resolveUrlStrategy`, `joinPublicUrl`, `normalizeBody`).
- Error class: [`../internal/errors.ts`](../internal/errors.ts).
- Provider catalog row: [`../providers/index.ts`](../providers/index.ts)
  — search for `slug: "storj"`.
- Tests: [`../../test/storj.test.ts`](../../test/storj.test.ts).
