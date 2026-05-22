# AGENTS.md — `files-sdk/azure`

Guidance for coding agents working on the `azure` adapter. The unified
`Adapter<Raw>` contract — methods, body shapes, `FilesError`,
`UrlOptions`, `SignUploadOptions` — lives in
[`../index.ts`](../index.ts); this file only documents azure-specific
deviations. Native adapter built on `@azure/storage-blob` plus
`@azure/core-auth` (`TokenCredential` type) and `@azure/identity`
(pre-built credentials). Cross-references:
[`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md),
[user-facing docs](../../../../apps/web/content/docs/adapters/azure.mdx).

## Overview

`azure(opts)` returns `Adapter<BlobServiceClient> & { readonly bucket: string }`.
Operations dispatch directly against the Azure SDK — no inner adapter
forwarding.

- **Container is the bucket; blob is the object.** Azure's "container"
  surfaces as `adapter.bucket` for cross-adapter consistency
  (s3/r2/gcs/minio).
- **Four credential modes** — connection string, shared account key,
  `TokenCredential` (Azure AD / Managed Identity), SAS token; plus
  anonymous (account name only) for public-read containers. Mutually
  exclusive per the provider catalog
  ([`../providers/index.ts`](../providers/index.ts) → `slug: "azure"`).
- **SAS URLs everywhere `url()` signs.** Presigning hands
  `generateBlobSASQueryParameters` (shared key) or
  `BlobClient.generateUserDelegationSasUrl` (token credential) a
  permissions string, expiry, and optional content-disposition.
- **Token credentials sign via User Delegation Keys** —
  `BlobServiceClient.getUserDelegationKey` mints account-scoped signing
  material the adapter caches across SAS URLs (see
  [URL behavior](#url-behavior)). Support landed via
  [`../../../../.changeset/azure-token-credentials.md`](../../../../.changeset/azure-token-credentials.md);
  follow the same pattern for future auth additions.

## Directory layout

```text
packages/files-sdk/src/azure/
├── index.ts        # azure() factory + mapAzureError + types
├── AGENTS.md       # this file
└── CLAUDE.md       # @AGENTS.md — Claude Code re-export
```

Tests at [`../../test/azure.test.ts`](../../test/azure.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/azure.mdx`](../../../../apps/web/content/docs/adapters/azure.mdx);
the `azure` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map.

## Build, test, typecheck

Run from `packages/files-sdk/`:

```bash
bun test test/azure.test.ts   # adapter-only suite
bun test                       # full SDK test suite
bun run build                  # tsup ESM bundle → dist/azure/index.{js,d.ts}
bun run types                  # tsgo --noEmit
```

Tests use `bun test` with `mock.module("@azure/storage-blob", …)` to
stub `BlobServiceClient`, `StorageSharedKeyCredential`, and
`generateBlobSASQueryParameters` — no real network or Azurite needed.
Read the mock-module setup at the top of the test file before touching
the SDK boundary.

## Public surface

Exports from [`./index.ts`](./index.ts):

- `azure(opts: AzureAdapterOptions): AzureAdapter` — primary factory;
  the adapter's `name` is `"azure"`.
- `AzureAdapter` — `Adapter<BlobServiceClient> & { readonly bucket: string }`;
  `.raw` is the underlying `BlobServiceClient`.
- `AzureAdapterOptions` — config interface. JSDoc on every field is the
  source of truth; the docs MDX pulls it via `AutoTypeTable`.
- `mapAzureError(err): FilesError` — exported for direct testing.

Optional peer deps (in [`../../package.json`](../../package.json)):
`@azure/storage-blob` (runtime), `@azure/core-auth` (`TokenCredential`,
type-only), and `@azure/identity` (`DefaultAzureCredential`,
`ManagedIdentityCredential`, `ClientSecretCredential`, … — the adapter
never imports it; callers pass `credential` from their own import).

## Authentication / configuration

Credential modes, picked by precedence:

1. **Connection string** — `opts.connectionString` or
   `AZURE_STORAGE_CONNECTION_STRING`. `parseConnectionString` recovers
   `AccountName`, `AccountKey`, `BlobEndpoint`; the recovered key feeds
   a `StorageSharedKeyCredential` so `url()` and `signedUploadUrl()`
   keep working without a second credential.
2. **Account key** — `opts.accountKey` (or `AZURE_STORAGE_ACCOUNT_KEY`
   / `AZURE_STORAGE_KEY`) plus `opts.accountName` (or
   `AZURE_STORAGE_ACCOUNT_NAME` / `AZURE_STORAGE_ACCOUNT`). Builds
   `StorageSharedKeyCredential(accountName, accountKey)` →
   `BlobServiceClient(endpoint, sharedKey)`.
3. **Token credential** — `opts.credential` plus `accountName`. SDK
   calls authenticate against Azure AD; signed URLs use User Delegation
   SAS via `getUserDelegationKey` + `generateUserDelegationSasUrl`. Set
   `useUserDelegationSas: false` to keep token-authenticated I/O but
   disable SAS signing.
4. **SAS token** — `opts.sasToken` (or `AZURE_STORAGE_SAS_TOKEN`) plus
   `accountName`. Appended to the endpoint. Reads/writes/listing work
   as the SAS allows; `url()` and `signedUploadUrl()` throw — the SAS
   is the credential, not a re-signable key. **Anonymous** (account
   name only) shares the caveat and only works for public-read
   containers.

Required: `opts.container` (missing throws `FilesError("Provider",
"missing container")`). Optional:

- `endpoint` — defaults to `https://${accountName}.blob.core.windows.net`.
  Override for Azurite (`http://127.0.0.1:10000/devstoreaccount1`) or
  sovereign clouds (`*.blob.core.usgovcloudapi.net`,
  `*.blob.core.chinacloudapi.cn`).
- `publicBaseUrl` — switches `url()` to `${publicBaseUrl}/${key}`
  unsigned, for `Blob` / `Container` access levels or a CDN
  (`*.azureedge.net`, Front Door) in front.
- `defaultUrlExpiresIn` — default SAS read-URL expiry, seconds.
  Defaults to `DEFAULT_URL_EXPIRES_IN` (3600) from
  [`../internal/core.ts`](../internal/core.ts).

Env reads go through [`readEnv`](../internal/env.ts) so the adapter is
import-safe on Cloudflare Workers without `nodejs_compat`. The catalog
entry (`slug: "azure"`) in
[`../providers/index.ts`](../providers/index.ts) is the canonical env
spec — keep it aligned with the JSDoc fallbacks.

## Operation map

Errors funnel through `mapAzureError`, which prefers
`RestError.details.errorCode` over the top-level `code` (which is
sometimes an SDK class name). Code sets:
`BlobNotFound`/`ContainerNotFound`/`ResourceNotFound` → `NotFound`;
`AuthenticationFailed`/`AuthorizationFailure`/`AuthorizationPermissionMismatch`/`InvalidAuthenticationInfo`/`InsufficientAccountPermissions`
→ `Unauthorized`;
`BlobAlreadyExists`/`ContainerAlreadyExists`/`ConditionNotMet`/`LeaseIdMismatchWithBlobOperation`/`LeaseAlreadyPresent`
→ `Conflict`.

| Method            | Underlying SDK call                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `upload`          | `BlockBlobClient.uploadData` (buffered) or `BlockBlobClient.uploadStream` (`ReadableStream`)         |
| `download`        | `BlobClient.download` (stream) or `BlobClient.downloadToBuffer` (buffered, parallel range requests)  |
| `head`            | `BlobClient.getProperties` + lazy `downloadToBuffer` factory for `text()` / `blob()` etc.            |
| `exists`          | `BlobClient.exists`; a thrown `NotFound` is caught and reported as `false`                           |
| `delete`          | `BlobClient.deleteIfExists` — idempotent (matches s3; divergent from gcs)                            |
| `copy`            | `BlobClient.syncCopyFromURL`, source signed by `buildCopySource` (see quirks)                        |
| `list`            | `ContainerClient.listBlobsFlat().byPage()`; cursor round-trips `continuationToken`                   |
| `url`             | `publicBaseUrl` join or SAS via `buildSasUrl` — see [URL behavior](#url-behavior)                    |
| `signedUploadUrl` | SAS with `cw` (create + write); PUT with `x-ms-blob-type: BlockBlob`                                 |

Body normalization runs through [`normalizeBody`](../internal/core.ts).
Stream bodies bridge to Node `Readable` via `Readable.fromWeb`;
buffered bodies become `Buffer` via a zero-copy
`Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)` so a `DataView`
at an offset doesn't over-read. Stream uploads do a follow-up
`getProperties` for an authoritative `UploadResult.size`. ETags are
unwrapped via `stripEtag`; `AbortSignal` flows through
`abortOpts(signal)` (the SDK's `AbortSignalLike` is satisfied by a web
`AbortSignal`). `signedUploadUrl` rejects `maxSize` — Azure SAS has no
`content-length-range`; enforce caps at the gateway.

## URL behavior

`url(key, opts?)` follows the two-state strategy from
[`resolveUrlStrategy`](../internal/core.ts):

- **`publicBaseUrl` set, no `responseContentDisposition`** →
  `${publicBaseUrl}/${encoded key}`, unsigned.
- **Otherwise** → SAS via `buildSasUrl`: shared-key mode uses
  `generateBlobSASQueryParameters`; token-credential mode uses
  `BlobClient.generateUserDelegationSasUrl` with a cached
  `UserDelegationKey`. Permissions `r`, expiry
  `opts.expiresIn ?? defaultUrlExpiresIn` seconds, HTTPS;
  `responseContentDisposition` flows into
  `BlobSASSignatureValues.contentDisposition`.
- **`responseContentDisposition` always forces signing**, even with
  `publicBaseUrl` set — a permanent CDN URL has no signature to bind
  the override to, and silently dropping it would regress stored-XSS
  protections on user-uploaded HTML/SVG.

`url()` and `signedUploadUrl()` throw `FilesError("Provider", …)` in
**SAS-only**, **anonymous**, and **token-credential mode with
`useUserDelegationSas: false`** — the message lists recovery paths.

**User Delegation Key rotation.** Token-credential signing caches one
`UserDelegationKey` per signer as
`signer.cachedKey: { key, expiresOn }`. Reused while
`expiresOn > sasExpiresOn + 5 min` (`USER_DELEGATION_KEY_SLACK_MS`); on
refetch, requested expiry is `requiredUntil + 1 h`
(`USER_DELEGATION_KEY_TTL_MS`), capped at `startsOn + 7 d`
(`USER_DELEGATION_KEY_MAX_MS`; Azure rejects keys older than 7 days).
Default-expiry `url()` calls share the cache — back-to-back `url("a")`
+ `url("b")` does one `getUserDelegationKey` round-trip and two
`generateUserDelegationSasUrl` calls; a dedicated test pins this, so
preserve it when changing the cache window. The principal needs blob
data access **plus** permission to call
`…/generateUserDelegationKey/action` (the *Storage Blob Delegator*
role at account scope fits).

## Provider quirks worth remembering

- **Metadata keys force lowercase on the wire.** Azure returns keys
  lowercase, so `{ Author: "me" }` round-trips as `{ author: "me" }`.
  Azure also restricts keys to C# identifier characters (no dashes, no
  non-ASCII); the adapter doesn't normalize, so lowercase at the
  caller if you compare across writes.
- **`syncCopyFromURL` caps at 256 MB source.** Larger blobs need
  `adapter.raw.getContainerClient(c).getBlobClient(to).beginCopyFromURL(sourceUrl)`
  via the escape hatch.
- **`delete()` is idempotent** (`deleteIfExists`); matches s3,
  diverges from gcs.
- **HTTP headers live in `blobHTTPHeaders`.** `Cache-Control` →
  `blobCacheControl`, `Content-Type` → `blobContentType`.
- **Copy source URLs need their own signature.** `syncCopyFromURL` has
  the destination fetch the source over HTTPS, so `buildCopySource`
  mints a 5-minute SAS (`COPY_SOURCE_SAS_SECONDS = 300`) in shared-key
  and token-credential modes, appends the existing SAS in SAS-only
  mode, and uses the bare URL in anonymous mode.
- **`x-ms-blob-type: BlockBlob` is required on the upload PUT** —
  without it Azure returns `400 InvalidHeaderValue`. `signedUploadUrl`
  emits the header.
- **Env-var aliases.** Both `AZURE_STORAGE_ACCOUNT_NAME` /
  `AZURE_STORAGE_ACCOUNT` and `AZURE_STORAGE_ACCOUNT_KEY` /
  `AZURE_STORAGE_KEY` work (the Azure CLI uses both); first populated
  wins.
- **Sovereign clouds and Azurite go through `endpoint`** — no separate
  flag. Azurite has a baked-in account segment (`…/devstoreaccount1`);
  pass it literally.
- **`exists()` swallows thrown 404s** — some configurations throw 404
  rather than returning `false`; the adapter normalizes both.

## Testing approach

[`../../test/azure.test.ts`](../../test/azure.test.ts) is one
`describe("azure adapter")` block with a sub-block per surface
(`construction`, `upload`, `download`, `head`, `exists`, `delete`,
`copy`, `list`, `url`, `signedUploadUrl`, `error mapping`,
`signal forwarding`). Coverage worth preserving:

- Every credential mode picks the right primitive
  (`fromConnectionString` vs `new BlobServiceClient(endpoint, …)`).
- `upload` body shapes (`Uint8Array`, `ArrayBuffer`, `ArrayBufferView`
  at offset, `Blob`, `ReadableStream` with stream-size follow-up);
  `download` buffered + lazy stream + empty-stream fallback.
- `exists` native true/false plus thrown 404 → `false`, 403 →
  `Unauthorized`; `copy` in all four credential modes.
- `url`: `publicBaseUrl` short-circuit, signed default, `expiresIn`
  honored, `responseContentDisposition` forces signing, no-signer
  modes throw, token mode reuses the cached UDK across default and
  explicit expiries. `signedUploadUrl`: PUT shape, `Content-Type`
  propagation, `maxSize` rejection, no-signer throw.
- `mapAzureError` covers every code class, HTTP status bucket, and
  `FilesError` pass-through; every op forwards `AbortSignal`.

Extend an existing sub-block rather than adding a new top-level
`describe` — keeps the `beforeEach` mock reset working.

## Coding conventions

- Named exports only — `azure`, `mapAzureError`, `AzureAdapter`,
  `AzureAdapterOptions`. No default exports.
- Construction errors use
  [`FilesError("Provider", …)`](../internal/errors.ts) with messages
  that list recovery paths. Operation errors funnel through
  `mapAzureError`; don't `instanceof RestError` directly — the mapper's
  `extract` already knows the SDK's shape.
- Read env via [`readEnv`](../internal/env.ts), never `process.env`.
- Propagate optional fields with `...(value && { key: value })` so
  unset values fall through to SDK defaults rather than explicit
  `undefined`.
- Top-level constants only (`COPY_SOURCE_SAS_SECONDS`,
  `USER_DELEGATION_KEY_TTL_MS`, the `AZURE_*_CODES` sets); keep
  SAS-builder branching inside `buildSasUrl` so callers stay agnostic
  about shared-key vs UDK.

## Releases

Ships from [`../../package.json`](../../package.json). Behavioral
changes (new options, default changes, error-shape changes, new
credential modes) need a changeset — `bun changeset`, pick `files-sdk`.
Follow the
[token-credentials changeset](../../../../.changeset/azure-token-credentials.md)
pattern for auth additions: changeset + MDX update + a `describe`
exercising both SDK-call and SAS-signing paths. Docs-only edits don't.

## Where to look next

- Unified `Adapter` contract: [`../index.ts`](../index.ts); shared
  helpers (URL strategy, body normalization, error-mapper factory,
  `DEFAULT_URL_EXPIRES_IN`):
  [`../internal/core.ts`](../internal/core.ts); `FilesError`:
  [`../internal/errors.ts`](../internal/errors.ts); env reader:
  [`../internal/env.ts`](../internal/env.ts); provider catalog:
  [`../providers/index.ts`](../providers/index.ts) (`slug: "azure"`).
- Tests: [`../../test/azure.test.ts`](../../test/azure.test.ts);
  user-facing docs:
  [`../../../../apps/web/content/docs/adapters/azure.mdx`](../../../../apps/web/content/docs/adapters/azure.mdx);
  package [README](../../README.md); SKILL:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md);
  changeset:
  [`../../../../.changeset/azure-token-credentials.md`](../../../../.changeset/azure-token-credentials.md).
