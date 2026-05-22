# AGENTS.md — `files-sdk/oracle-cloud`

Guidance for coding agents working in the `files-sdk/oracle-cloud`
subpath. The unified `Adapter<Raw>` contract lives in
[`../index.ts`](../index.ts); this file documents only the
oracle-cloud-specific deviations. `oracleCloud()` wraps
[`s3()`](../s3/index.ts) for [Oracle Cloud Infrastructure (OCI) Object
Storage](https://www.oracle.com/cloud/storage/object-storage/)'s S3
compatibility layer, so operation, error, and presign mechanics live
in the S3 adapter — see [`../s3/AGENTS.md`](../s3/AGENTS.md) for
primitive-level details. Cross-references:
[`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A thin shim that calls `s3()` with an OCI-derived endpoint, OCI HMAC
credentials, `forcePathStyle: true`, and a `defaultProviderMessage`
of `"Oracle Cloud error"`. No per-method code lives here. The
oracle-cloud deviations are endpoint derivation from
`<namespace>.<region>`, the credential env-var pair, the path-style
default (TLS reasons — see
[Provider quirks](#provider-quirks-worth-remembering)), and the
error-message relabel. The returned adapter's `raw` is the underlying
`@aws-sdk/client-s3` `S3Client` — anything the AWS SDK can do against
OCI's S3-compatible API is one property access away.

## Directory layout

```text
packages/files-sdk/src/oracle-cloud/
├── index.ts                   # oracleCloud() factory + OracleCloudAdapterOptions
├── AGENTS.md                  # this file
└── CLAUDE.md                  # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/oracle-cloud.test.ts`](../../test/oracle-cloud.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/oracle-cloud.mdx`](../../../../apps/web/content/docs/adapters/oracle-cloud.mdx).

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/oracle-cloud.test.ts   # focused oracle-cloud suite
bun test                              # full SDK suite
bun run build                         # tsup → dist/oracle-cloud/
bun run types                         # tsgo --noEmit
```

The `oracle-cloud` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep
it in sync if the file layout changes.

## Public surface

[`index.ts`](./index.ts) exports the
`oracleCloud(opts: OracleCloudAdapterOptions): OracleCloudAdapter`
factory, the `OracleCloudAdapter` alias for `Adapter<S3Client>`
(`raw` is the underlying AWS SDK client), and the
`OracleCloudAdapterOptions` config interface. JSDoc on every option
field is the source of truth — the docs MDX pulls it via
`<AutoTypeTable>`. The adapter's `name` is `"oracle-cloud"` (set
after spreading, so it overrides the inner `"s3"`).

## Authentication / configuration

| Option                | Required | Default                                                              | Notes                                                                                          |
| --------------------- | -------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `bucket`              | yes      | —                                                                    | OCI bucket name. Tenancy-scoped, **not globally unique** — see quirks.                         |
| `namespace`           | yes      | —                                                                    | Tenancy Object Storage namespace (e.g. `axoki12345`). Drives the endpoint host.                |
| `region`              | yes      | —                                                                    | OCI region identifier (`us-ashburn-1`, `eu-frankfurt-1`, …). Drives host **and** SigV4 region. |
| `accessKeyId`         | yes\*    | `OCI_ACCESS_KEY_ID`                                                  | OCI Customer Secret Key access ID — **not** an API signing key.                                |
| `secretAccessKey`     | yes\*    | `OCI_SECRET_ACCESS_KEY`                                              | Customer Secret Key secret.                                                                    |
| `endpoint`            | no       | `https://${namespace}.compat.objectstorage.${region}.oraclecloud.com` | Override for VPC private endpoints, FastConnect origins, or test doubles.                      |
| `forcePathStyle`      | no       | `true`                                                               | OCI-specific default — see quirks.                                                             |
| `publicBaseUrl`       | no       | —                                                                    | Origin for unsigned `url()` (PAR prefix or WAF / Load Balancer custom domain).                 |
| `defaultUrlExpiresIn` | no       | `3600`                                                               | Fallback expiry for presigned `url()` results when `publicBaseUrl` is unset.                   |

\* Pass explicitly or set the env var. Find the namespace under
**Profile → Tenancy → Object Storage Namespace** (or `oci os ns
get`); generate Customer Secret Keys under **Profile → User Settings
→ Customer Secret Keys**. No `OCI_REGION` / `OCI_NAMESPACE` /
`OCI_BUCKET` env-var fallback — each missing required field throws
`FilesError("Provider", …)` at construction with its own message.
Env lookups go through [`readEnv`](../internal/env.ts) for runtimes
without `process` (Cloudflare Workers without `nodejs_compat`). The
provider catalog row in [`../providers/index.ts`](../providers/index.ts)
(search `slug: "oracle-cloud"`) declares the same env contract via
the shared `s3Compatible(…)` helper.

## Operation map

`oracleCloud()` spreads the inner `s3()` adapter and overrides only
`name`. `upload`, `download`, `head`, `exists`, `delete`,
`deleteMany`, `copy`, `list`, `url`, and `signedUploadUrl` all live
in [`../s3/index.ts`](../s3/index.ts) and are inherited unchanged —
including `deleteMany`'s 1000-key chunking, `signedUploadUrl`'s
PUT-vs-presigned-POST split on `maxSize`, and `exists`'
404-as-`false` classification. Provider errors flow through
`mapS3Error` with the oracle-cloud fallback table — `Provider`-coded
messages read `"Oracle Cloud error"` while preserving any server-side
message on the wire.

## URL behavior

`url(key, opts?)` follows the standard signing-adapter rules
(`resolveUrlStrategy` in [`../internal/core.ts`](../internal/core.ts)):

- **No `publicBaseUrl`** → presigned `GetObject` against the OCI
  S3-compat endpoint, signed with SigV4 in `region`, expiring after
  `opts.expiresIn ?? defaultUrlExpiresIn ?? 3600` seconds.
- **`publicBaseUrl` set** → unsigned `${publicBaseUrl}/${key}` via
  `joinPublicUrl` (URL-encodes segments). Typically a
  Pre-Authenticated Request (PAR) URL prefix or a WAF custom domain.
- **`responseContentDisposition` set** → forces signing even when
  `publicBaseUrl` is configured: a permanent CDN URL has no signature
  to bind the override to, and silently dropping it would be a
  stored-XSS regression on user-uploaded HTML/SVG.

OCI doesn't bundle a managed CDN with Object Storage, so most configs
leave `publicBaseUrl` unset and sign every read.

## Provider quirks worth remembering

- **Customer Secret Keys, not API signing keys.** The S3-compatible
  API requires *Customer Secret Keys* — HMAC keys generated under
  **Profile → User Settings → Customer Secret Keys**. OCI's other
  credential type (API Signing Keys, used by the native OCI APIs)
  **will not authenticate** against the S3 endpoint. The most common
  setup error is pasting an API key fingerprint into `accessKeyId`.
- **Bucket names are tenancy-scoped, not global.** `(namespace,
  bucket)` is the unique pair. Two unrelated tenancies can each own
  `uploads`; the namespace prefix disambiguates. No AWS-style global
  collision risk on creation.
- **Path-style default is deliberate.** OCI's wildcard TLS cert
  covers `*.compat.objectstorage.<region>.oraclecloud.com` but does
  **not** cover the additional bucket subdomain that virtual-hosted
  style would need (`<bucket>.<namespace>.compat.…`). Flipping
  `forcePathStyle` to `false` against the default endpoint typically
  yields a TLS hostname mismatch before any S3 error surfaces.
  Override only when fronted by infrastructure that owns its own cert.
- **Namespace ≠ tenancy OCID.** The namespace is a short
  auto-generated string (e.g. `axoki12345`), not the
  `ocid1.tenancy.oc1.…` identifier. Not interchangeable.
- **Region drives both host and SigV4.** A mismatch fails fast at
  signing rather than silently writing to the wrong region.
- **No public-read ACL.** Buckets are private by default with a
  Private/Public toggle; for granular public access, use a
  Pre-Authenticated Request with `publicBaseUrl`.
- **Errors are relabeled, not reclassified.** Status codes still map
  through the same `S3_NOT_FOUND_CODES` / `S3_UNAUTH_CODES` /
  `S3_CONFLICT_CODES` sets in [`../s3/index.ts`](../s3/index.ts);
  only the unknown-error fallback message changes.

## Testing approach

[`../../test/oracle-cloud.test.ts`](../../test/oracle-cloud.test.ts)
covers the adapter's narrow surface:

- Default-config plumbing — endpoint derived from
  `<namespace>.compat.objectstorage.<region>.oraclecloud.com`,
  `forcePathStyle: true`, region threaded into both inner client and
  endpoint host. `region` override flows through to both; explicit
  `endpoint` wins (hostname + port forwarded); `forcePathStyle: false`
  opt-out is forwarded faithfully.
- Missing-namespace, missing-region, and missing-credentials each
  throw at factory time; `OCI_ACCESS_KEY_ID` / `OCI_SECRET_ACCESS_KEY`
  env-var fallbacks are picked up when options are omitted.
- `url()` returns a presigned GET (`X-Amz-Signature=…`,
  `X-Amz-Expires=3600`, namespace-prefixed host) by default, and
  switches to the unsigned concat form when `publicBaseUrl` is set.
- `Files` integration via `aws-sdk-client-mock` — `upload` and
  `exists` go through `PutObjectCommand` and `HeadObjectCommand`.
  `mapS3Error` is exercised directly with the oracle-cloud table to
  confirm the `Provider` fallback says `"Oracle Cloud error"`.

Add fixtures here when behavior depends on oracle-cloud-specific
config (endpoint host, namespace, relabel, env-var name); shared S3
semantics belong in [`../../test/s3.test.ts`](../../test/s3.test.ts).
Use `mockClient(S3Client)` rather than a live OCI tenancy.

## Coding conventions

- Named exports only — `oracleCloud`, `OracleCloudAdapter`,
  `OracleCloudAdapterOptions`.
- Construction-time errors throw
  [`FilesError("Provider", …)`](../internal/errors.ts) with messages
  that name the adapter (`"oracle-cloud adapter: …"`). Operation
  errors are the inner S3 adapter's responsibility — don't try-catch
  and rethrow in this shim.
- Read env vars via [`readEnv`](../internal/env.ts), not
  `process.env` (breaks Cloudflare Workers without `nodejs_compat`).
- Forward optional knobs conditionally
  (`...(opts.x !== undefined && { x: opts.x })`) so unset values
  fall through to the inner adapter's defaults. `forcePathStyle` is
  the exception: this shim opts in to a non-S3 default via `?? true`.
- Spread the inner adapter, then override only `name` — preserves
  future additions to the `Adapter` interface automatically. Top-level
  regex literals only.

## Releases

Ships with the monorepo on the repo-wide Changesets schedule.
Behavioral changes (new options, default changes, error-shape
changes) bump `files-sdk` and add an entry to
[`../../CHANGELOG.md`](../../CHANGELOG.md) (`bun changeset`, pick
`files-sdk`); pure docs / test-only additions don't. The
`oracle-cloud` subpath is already declared in `exports`.

## Where to look next

- Unified contract: [`../index.ts`](../index.ts).
- Inner S3 adapter: [`../s3/index.ts`](../s3/index.ts) +
  [`../s3/AGENTS.md`](../s3/AGENTS.md) — `s3()`, `S3AdapterOptions`,
  `mapS3Error`, default error code sets.
- Shared helpers: [`../internal/core.ts`](../internal/core.ts) (URL
  strategy, body normalization, error-mapper factory),
  [`../internal/errors.ts`](../internal/errors.ts) (`FilesError`),
  [`../internal/env.ts`](../internal/env.ts) (`readEnv`).
- Provider catalog row (search `slug: "oracle-cloud"`):
  [`../providers/index.ts`](../providers/index.ts).
- User-facing docs: [`oracle-cloud.mdx`](../../../../apps/web/content/docs/adapters/oracle-cloud.mdx);
  README: [`../../README.md`](../../README.md); SKILL:
  [`SKILL.md`](../../../../skills/files-sdk/SKILL.md); tests:
  [`oracle-cloud.test.ts`](../../test/oracle-cloud.test.ts).
