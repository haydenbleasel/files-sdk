# AGENTS.md — `files-sdk/digitalocean-spaces`

Guidance for coding agents working inside the `digitalocean-spaces`
adapter. This file is scoped to DigitalOcean Spaces only — the unified
`Adapter<Raw>` contract lives in [`../index.ts`](../index.ts), and the
package-wide overview and integration skill are in
[`../../README.md`](../../README.md) and
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
The adapter is a thin wrapper around [`../s3/index.ts`](../s3/index.ts)
with DigitalOcean-friendly defaults — region-derived endpoint,
virtual-hosted addressing, and a Spaces-CDN-aware `publicBaseUrl`.
Redirect S3-primitive questions to `../s3/`.

## Overview

`digitaloceanSpaces(opts)` returns an `Adapter<S3Client>`. It builds an
`S3Client` via the shared `s3()` factory with three Spaces-specific
overrides:

- Endpoint defaults to `https://${region}.digitaloceanspaces.com` when
  the caller doesn't pass one.
- Credential env fallback reads `DO_SPACES_KEY` / `DO_SPACES_SECRET`
  instead of the AWS chain.
- Provider-error label is rewritten from `"S3 error"` to
  `"Spaces error"` so users don't see surprise "S3 error" strings.

Everything else — error mapping, signing, presigned POST forms, bulk
delete chunking, the `publicBaseUrl` short-circuit — is inherited
unchanged from `s3()`. The wrapper is ~100 lines because that is all
it needs to be.

## Directory layout

```
packages/files-sdk/src/digitalocean-spaces/
└── index.ts        # digitaloceanSpaces() factory + options type
```

Tests live at
[`../../test/digitalocean-spaces.test.ts`](../../test/digitalocean-spaces.test.ts),
user-facing docs at
[`../../../../apps/web/content/docs/adapters/digitalocean-spaces.mdx`](../../../../apps/web/content/docs/adapters/digitalocean-spaces.mdx),
and the provider-catalog entry (env vars, peer deps, description) in
[`../providers/index.ts`](../providers/index.ts) under
`slug: "digitalocean-spaces"`.

## Build, test, typecheck

Run from the package root (`packages/files-sdk`):

```bash
bun test test/digitalocean-spaces.test.ts   # focused
bun test                                    # whole suite
bun run build                               # tsup ESM bundle → dist/
bun run types                               # tsgo --noEmit
```

The package uses `tsgo` (typescript-go) — not `tsc`. The `build`
script bumps `--max-old-space-size`, so prefer the package script over
invoking `tsup` directly. Tests use Bun's `bun:test` and
`aws-sdk-client-mock` to stub the S3 client.

## Public surface

One factory and its option type, both from `index.ts`:

```ts
export const digitaloceanSpaces: (
  opts: DigitalOceanSpacesAdapterOptions,
) => DigitalOceanSpacesAdapter; // = Adapter<S3Client>
```

`DigitalOceanSpacesAdapterOptions` carries `bucket` and `region`
(required), plus optional `endpoint`, `accessKeyId`, `secretAccessKey`,
`forcePathStyle`, `publicBaseUrl`, and `defaultUrlExpiresIn`. The
returned adapter sets `name: "digitalocean-spaces"` (overriding the
inner `s3` adapter's `"s3"`). `raw` is the underlying `S3Client` —
reach for it for behaviour the unified API doesn't model (CORS,
lifecycle, bucket policy, …).

## Authentication / configuration

`bucket` and `region` are required and have **no env-var fallback**.
The factory throws `FilesError("Provider", …)` at construction when
`region` is empty — intentionally early, before any request hits the
network.

Credentials come from one of:

| Source                                        | Order                |
| --------------------------------------------- | -------------------- |
| `accessKeyId` / `secretAccessKey` options     | explicit values win  |
| `DO_SPACES_KEY` / `DO_SPACES_SECRET` env vars | fallback             |

Missing credentials throw with a message naming both. The env pair is
`DO_SPACES_KEY` / `DO_SPACES_SECRET` (matching the DigitalOcean
dashboard) — not the AWS-style `DO_SPACES_ACCESS_KEY_ID` /
`DO_SPACES_SECRET_ACCESS_KEY`. The provider catalog mirrors this via
the shared `s3Compatible(...)` helper. DigitalOcean publishes no
`DO_REGION` convention, so region is always explicit; `bucket` is
likewise explicit because Spaces routes by Host header.

## Operation map

Every method on the returned adapter is the inner `s3()` implementation
unchanged — see [`../s3/index.ts`](../s3/index.ts) for details.

| Method                         | Backed by                                                         |
| ------------------------------ | ----------------------------------------------------------------- |
| `upload` / `download`          | `PutObjectCommand` / `GetObjectCommand`                           |
| `head` / `exists`              | `HeadObjectCommand` (the latter via `existsByProbe`)              |
| `delete` / `deleteMany`        | `DeleteObjectCommand` / `DeleteObjectsCommand` (1000-key batches) |
| `copy` / `list`                | `CopyObjectCommand` / `ListObjectsV2Command`                      |
| `url`                          | `getSignedUrl` over `GetObjectCommand`, or `joinPublicUrl` when `publicBaseUrl` is set |
| `signedUploadUrl`              | `createPresignedPost` (with `maxSize`), else `getSignedUrl` over `PutObjectCommand` |

If you need to extend behaviour, change the wrapper — not the inner
`s3()`. The S3 adapter is shared by ~15 wrappers (MinIO, Wasabi,
Backblaze B2, Storj, Hetzner, Akamai, Tigris, …) and breaking changes
ripple.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules documented
in `../index.ts` and the SKILL: presigned `GetObject` by default,
`publicBaseUrl` as the unsigned short-circuit,
`responseContentDisposition` forcing the signing path even when
`publicBaseUrl` is set. Default expiry is 3600 s from
`DEFAULT_URL_EXPIRES_IN`; override via `defaultUrlExpiresIn` or per-call
`url(key, { expiresIn })`. Two DigitalOcean-specific notes:

- **CDN host.** Spaces ships an opt-in CDN at
  `https://${bucket}.${region}.cdn.digitaloceanspaces.com`. Pass it as
  `publicBaseUrl` to return that permanent URL from `url()`; otherwise
  `url()` signs against the origin (`${region}.digitaloceanspaces.com`).
- **Custom CNAME.** When a Space is fronted by a custom domain (the
  CDN is attached to the CNAME), set `publicBaseUrl` to that domain.
  `joinPublicUrl` URL-encodes path segments — pass raw keys.

## Provider quirks worth remembering

- **Virtual-hosted addressing is canonical.** Spaces routes by Host
  header — the bucket subdomain is prepended onto
  `${region}.digitaloceanspaces.com`. The AWS SDK default
  (`forcePathStyle: false`) is what we want, so the wrapper only
  forwards `forcePathStyle` when the caller sets it explicitly.
- **Wire-compatible with S3, not feature-parity.** Versioning, Object
  Lock, S3 Select, and several replication primitives are absent — a
  caller reaching through `raw` to send one of those commands fails at
  the wire.
- **Error label.** `defaultProviderMessage: "Spaces error"` is threaded
  into `mapS3Error` so unknown errors get a `FilesError` with
  `message: "Spaces error"` rather than `"S3 error"`. Known
  classifications (`NotFound`, `Unauthorized`, `Conflict`) still
  surface the upstream message when present.

## Testing approach

[`../../test/digitalocean-spaces.test.ts`](../../test/digitalocean-spaces.test.ts)
covers the four pieces of behaviour specific to this wrapper:

1. **Endpoint derivation.** Region drives the default host; explicit
   `endpoint` overrides; `forcePathStyle` defaults to `false`.
2. **Credential resolution.** Explicit options win; `DO_SPACES_KEY` /
   `DO_SPACES_SECRET` are the fallbacks; missing region or credentials
   throw at construction.
3. **URL strategy.** Default `url()` signs against the region host
   (`X-Amz-Signature=` and `nyc3.digitaloceanspaces.com` in the result);
   `publicBaseUrl` short-circuits to a plain concatenation.
4. **Error relabelling.** `mapS3Error` is called directly with the
   Spaces message table to confirm the provider fallback is
   `"Spaces error"`.

Delegation tests (`upload`, `exists`) use `aws-sdk-client-mock` to catch
wrapper-level regressions (e.g. dropping `defaultProviderMessage` or
`endpoint`). Don't re-test the inner `s3()` adapter — that is covered
by [`../../test/s3.test.ts`](../../test/s3.test.ts).

## Coding conventions

- One named export per file; no default exports. Factory and option
  type live together in `index.ts`.
- **Forward options conditionally** with
  `...(opts.foo !== undefined && { foo: opts.foo })` so unset fields
  stay absent in the inner config — the AWS SDK distinguishes
  `undefined` from "key missing" for some fields.
- Throw `FilesError` from
  [`../internal/errors.ts`](../internal/errors.ts) for construction-time
  validation. Runtime errors go through the inner `s3()` adapter's
  mapper — don't add a second wrapping layer.
- No `process.env` access outside
  [`../internal/env.ts`](../internal/env.ts) — `readEnv` tolerates
  runtimes where `process` is undefined (Cloudflare Workers without
  `nodejs_compat`). Keep the factory body flat.

## Releases

The adapter ships with the rest of `files-sdk` from
[`../../package.json`](../../package.json) on the package's normal
release cadence. Behavioural changes need a release note; option
additions and docs-only edits do not. When adding an option: extend
`DigitalOceanSpacesAdapterOptions` with JSDoc naming any env fallback
and default, thread it into `s3({...})` using the
`...(opt !== undefined && { opt })` pattern, mirror user-visible env
vars in [`../providers/index.ts`](../providers/index.ts), and add a
wrapper-level test.

## Where to look next

- Source: [`./index.ts`](./index.ts)
- Tests: [`../../test/digitalocean-spaces.test.ts`](../../test/digitalocean-spaces.test.ts)
- Inner S3 adapter (almost all behaviour lives here): [`../s3/index.ts`](../s3/index.ts)
- Unified `Adapter<Raw>` contract: [`../index.ts`](../index.ts)
- Shared helpers (`joinPublicUrl`, `resolveUrlStrategy`, `makeErrorMapper`, `existsByProbe`): [`../internal/core.ts`](../internal/core.ts)
- `FilesError` / `FilesErrorCode`: [`../internal/errors.ts`](../internal/errors.ts)
- Provider-catalog entry: [`../providers/index.ts`](../providers/index.ts)
- User-facing docs: [`../../../../apps/web/content/docs/adapters/digitalocean-spaces.mdx`](../../../../apps/web/content/docs/adapters/digitalocean-spaces.mdx)
- Package README: [`../../README.md`](../../README.md)
- Integration skill: [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md)
