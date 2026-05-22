# AGENTS.md — `files-sdk/backblaze-b2`

Guidance for coding agents working on the `backblaze-b2` adapter. The unified
`Adapter<Raw>` contract every adapter implements lives in
[../index.ts](../index.ts); this file documents only what is specific to
Backblaze B2. The adapter targets B2's **S3-compatible API** (not the legacy
native B2 API at `api.backblazeb2.com/b2api/v3/…`) and is a thin wrapper around
[`s3()`](../s3/index.ts). For the unified surface and high-level mental model
see [../../README.md](../../README.md) and
[../../../../skills/files-sdk/SKILL.md](../../../../skills/files-sdk/SKILL.md).

## Overview

`backblaze-b2` constructs an internal `s3()` adapter, points it at a B2 cluster
endpoint, relabels the unknown-error fallback message, and re-exports it with
`name: "backblaze-b2"`. Every operation (`upload`, `download`, `head`,
`exists`, `delete`, `deleteMany`, `copy`, `list`, `url`, `signedUploadUrl`)
flows through the inner S3 client. The B2-specific work is:

- Deriving the endpoint host from a cluster code (e.g. `us-west-002`).
- Auto-loading credentials from `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY`.
- Keeping virtual-hosted-style addressing on, which B2 expects.
- Relabeling the generic `Provider`-code fallback to `"Backblaze B2 error"` so
  callers don't see `"S3 error"`.

If you reach for S3 internals (presigners, `mapS3Error`, `S3AdapterOptions`),
edit [../s3/index.ts](../s3/index.ts) and let the change flow through; do not
fork S3 logic into this file.

## Directory layout

```text
packages/files-sdk/src/backblaze-b2/
├── AGENTS.md   # this file
├── CLAUDE.md   # @AGENTS.md indirection
└── index.ts    # backblazeB2() factory + BackblazeB2AdapterOptions
```

Tests: [../../test/backblaze-b2.test.ts](../../test/backblaze-b2.test.ts).
User docs:
[../../../../apps/web/content/docs/adapters/backblaze-b2.mdx](../../../../apps/web/content/docs/adapters/backblaze-b2.mdx).
Provider catalog: [../providers/index.ts](../providers/index.ts) under
`slug: "backblaze-b2"`.

## Build, test, typecheck

```bash
bun test test/backblaze-b2.test.ts
bun test
bun run build
bun run types
```

The first is the fast inner loop. Run the full suite before pushing — changes
to [../s3/index.ts](../s3/index.ts) ripple here. `bun run build` (tsup)
confirms the `./backblaze-b2` subpath export in
[../../package.json](../../package.json) still resolves; `bun run types` runs
`tsgo --noEmit`.

## Public surface

Two exports:

- `backblazeB2(opts: BackblazeB2AdapterOptions): BackblazeB2Adapter` — factory
  returning `Adapter<S3Client>` with `name: "backblaze-b2"`.
- `BackblazeB2AdapterOptions` — constructor options.

`files.raw` is the underlying `@aws-sdk/client-s3` `S3Client` for escape-hatch
access to B2 features outside the unified API:

```ts
import { backblazeB2 } from "files-sdk/backblaze-b2";
```

## Authentication / configuration

Required: `bucket`, `region`, and `accessKeyId` + `secretAccessKey` (or the env
vars below). `region` is the B2 cluster code (`"us-west-000"`, `"us-west-001"`,
`"us-west-002"`, `"us-east-004"`, `"us-east-005"`, `"eu-central-003"`, …) and
has **no env-var fallback**. It drives both the endpoint host
(`https://s3.<region>.backblazeb2.com`) and the SigV4 region; the bucket's
cluster shows in the B2 console next to the endpoint, and the wrong code
returns a `301`. Application keys come from **Account → Application Keys** —
prefer bucket-scoped keys with the minimum capabilities over the master key.

Optional: `endpoint` overrides the derived host (private link, proxy);
`forcePathStyle` defaults to `false` (virtual-hosted is canonical for B2 — only
flip when a proxy demands path-style); `publicBaseUrl` is the origin for
unsigned `url()` reads (see [URL behavior](#url-behavior));
`defaultUrlExpiresIn` is the default `expiresIn` (seconds) for presigned
`url()`, defaulting to `3600` and honored only when `publicBaseUrl` is unset.

Env-var fallbacks (via [../internal/env.ts](../internal/env.ts)):

| Option            | Env var                 |
| ----------------- | ----------------------- |
| `accessKeyId`     | `B2_APPLICATION_KEY_ID` |
| `secretAccessKey` | `B2_APPLICATION_KEY`    |

The factory throws `FilesError("Provider", …)` (from
[../internal/errors.ts](../internal/errors.ts)) when `region` is missing or
when neither explicit credentials nor both env vars are set. Those messages
are part of the public contract — grep before renaming.

## Operation map

Every operation forwards to the inner `s3()` adapter unchanged:

| Files SDK method  | S3 wire call (via `s3()`)                                   |
| ----------------- | ----------------------------------------------------------- |
| `upload`          | `PutObjectCommand` (+ follow-up `HeadObject` for streams)   |
| `download`        | `GetObjectCommand`                                          |
| `head`            | `HeadObjectCommand`                                         |
| `exists`          | `HeadObjectCommand` via `existsByProbe`                     |
| `delete`          | `DeleteObjectCommand`                                       |
| `deleteMany`      | `DeleteObjectsCommand` (chunked at 1000 keys/request)       |
| `copy`            | `CopyObjectCommand` (`CopySource` URL-encoded)              |
| `list`            | `ListObjectsV2Command`                                      |
| `url`             | `getSignedUrl(GetObjectCommand)` or `publicBaseUrl` concat  |
| `signedUploadUrl` | `createPresignedPost` if `maxSize`, else signed `PutObject` |

For per-method details and error classification, see
[../s3/index.ts](../s3/index.ts). For nuance beyond "it does what S3 does,"
update that file and add a regression test in
[../../test/backblaze-b2.test.ts](../../test/backblaze-b2.test.ts).

## URL behavior

`url(key, opts?)` follows the signing-adapter rules in
[../internal/core.ts](../internal/core.ts) `resolveUrlStrategy`:

- **`publicBaseUrl` unset:** SigV4-presigned `GetObject` URL against the
  cluster endpoint, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn ?? 3600` seconds.
- **`publicBaseUrl` set:** `${publicBaseUrl}/${key}` unsigned and permanent.
  For public-read buckets the natural value is the **B2 Friendly URL** prefix
  `https://f<NNN>.backblazeb2.com/file/<bucket>` (the `f<NNN>` host varies per
  cluster; look it up under the bucket's "Endpoint" in the B2 console). A
  Cloudflare-fronted custom domain also works.
- **`responseContentDisposition` set:** always forces signing, even with
  `publicBaseUrl` configured. A permanent CDN URL has no signature to bind the
  override to; dropping it silently would be a stored-XSS regression on
  user-uploaded HTML/SVG. This invariant lives in `resolveUrlStrategy`, not
  here — don't reimplement it.

Keys passed through `joinPublicUrl` are URL-encoded by segment; presigned URLs
are encoded by the AWS SDK.

## Provider quirks worth remembering

- **Cluster code matters.** A bucket lives in exactly one cluster. The wrong
  `region` returns a `301` surfaced as a generic `Provider`-code `FilesError`
  reading "Backblaze B2 error" — not a pointer back to the cluster mistake.
  If a user reports mysterious 301s, ask which cluster their bucket is in.
- **Friendly URLs are the only public-read URL B2 exposes**
  (`https://f<NNN>.backblazeb2.com/file/<bucket>/<key>`); path-style on
  `s3.<region>.backblazeb2.com` does not bypass auth. Keep
  `forcePathStyle: false` unless the network path forces otherwise.
- **No native object-lock or list-versions** in the unified API. Reach for
  `files.raw` for B2 features outside it.
- **Errors are labeled `"Backblaze B2 error"`** via `defaultProviderMessage`
  on the inner `s3()` call. Tests assert this string — do not change without
  updating the test and adding a changeset.

## Testing approach

Tests in [../../test/backblaze-b2.test.ts](../../test/backblaze-b2.test.ts)
cover three layers:

1. **Config plumbing.** Region → derived endpoint, explicit endpoint override,
   `forcePathStyle: true` pass-through, missing-region and missing-credentials
   throws, env-var credential fallback. These read `client.config.region()`,
   `client.config.endpoint?.()`, and `client.config.credentials()` directly
   off the inner `S3Client`.
2. **Delegation.** `upload` and `exists` exercised through a `Files` wrapper
   with `aws-sdk-client-mock` (`mockClient(S3Client)`) and the relevant
   `*Command` resolutions stubbed. Guard against accidental method-renaming
   when `s3()` changes.
3. **Error relabeling.** A direct call into `mapS3Error` confirms the
   `Provider`-code fallback is `"Backblaze B2 error"`.

When adding behavior, extend an existing test rather than spawning a new file.
Mock the SDK and reset between assertions; never hit real B2.

## Coding conventions

- Named exports only.
- The factory is a pure function: no module-level mutable state, no I/O at
  import. Env reads happen inside the factory via `readEnv`
  ([../internal/env.ts](../internal/env.ts)) so Cloudflare Workers (no
  `process`) can still import the module.
- Construction-time validation throws `FilesError("Provider", …)` with a
  message starting with the adapter slug ("backblaze-b2 adapter: …") so
  sibling S3-compatible adapters stay distinguishable.
- Keep the option set a strict subset of `S3AdapterOptions`; thread any new
  knob through `s3()` rather than splitting the implementation.
- Type-only imports from `@aws-sdk/client-s3` — it is an **optional** peer dep
  (see [../../package.json](../../package.json)); a runtime
  `import { S3Client }` here would break consumers who install `files-sdk`
  without it. The runtime client is constructed inside `s3()`.

## Releases

The package ships as `files-sdk` on a single version line. Behavioral changes
— `defaultProviderMessage` string, error message text, env-var names, option
renames — need a Changesets entry against `files-sdk`. AGENTS.md / CLAUDE.md
and comment-only edits don't.

## Where to look next

- Unified contract: [../index.ts](../index.ts).
- Inner adapter: [../s3/index.ts](../s3/index.ts) — every operation here
  ultimately runs through it.
- Shared helpers: [../internal/core.ts](../internal/core.ts),
  [../internal/errors.ts](../internal/errors.ts),
  [../internal/env.ts](../internal/env.ts).
- Provider catalog: [../providers/index.ts](../providers/index.ts)
  (`slug: "backblaze-b2"`).
- Tests: [../../test/backblaze-b2.test.ts](../../test/backblaze-b2.test.ts).
- User docs:
  [../../../../apps/web/content/docs/adapters/backblaze-b2.mdx](../../../../apps/web/content/docs/adapters/backblaze-b2.mdx).
- Package overview: [../../README.md](../../README.md) and
  [../../../../skills/files-sdk/SKILL.md](../../../../skills/files-sdk/SKILL.md).
