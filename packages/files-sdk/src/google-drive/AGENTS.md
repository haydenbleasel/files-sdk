# AGENTS.md — `files-sdk/google-drive`

Guidance for coding agents working on the `google-drive` adapter. The
unified `Adapter<Raw>` contract — call shapes, `FilesError`,
`UrlOptions`, `SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file documents only the
google-drive-specific deviations. Package
[`README.md`](../../README.md) and the agent skill at
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md) are the sources of
truth for the unified API — read them first.

`google-drive` is a **native** adapter (not an S3-compatible shim),
calling [`@googleapis/drive`](https://www.npmjs.com/package/@googleapis/drive)
v3 with credentials minted through
[`google-auth-library`](https://www.npmjs.com/package/google-auth-library).
The central design decision — projecting Drive's opaque `fileId`
namespace onto the SDK's flat-string-key namespace via a reserved
`appProperties.fsdkKey` slot — shows up in almost every method; read
the [Operation map](#operation-map) before changing anything.

## Overview

Google Drive via the official Drive v3 client. Family: **native /
document store** (alongside `dropbox`, `onedrive`, `box`,
`sharepoint`). Drive is a document manager, not object storage: files
have opaque random `fileId`s, names may collide inside the same
folder, and there is no path namespace. The adapter maps the unified
string key onto a reserved `appProperties.fsdkKey` slot and resolves
keys → ids through `files.list` with a per-instance LRU cache. The
full unified surface — `upload`, `download`, `head`, `exists`,
`delete`, `copy`, `list`, `url`, `signedUploadUrl` — is implemented
natively against `drive_v3.Drive`. `deleteMany` is **not** implemented
— `Files` falls back to fanned-out `delete()` calls.

Peer dependencies (both optional, declared in
[`../../package.json`](../../package.json)): `@googleapis/drive`,
`google-auth-library`.

## Directory layout

```text
packages/files-sdk/src/google-drive/
├── index.ts                # adapter implementation
├── AGENTS.md               # this file
└── CLAUDE.md               # `@AGENTS.md`
```

Tests at [`../../test/google-drive.test.ts`](../../test/google-drive.test.ts);
user docs at [`../../../../apps/web/content/docs/adapters/google-drive.mdx`](../../../../apps/web/content/docs/adapters/google-drive.mdx);
provider catalog (`slug: "google-drive"`) at [`../providers/index.ts`](../providers/index.ts);
subpath export `./google-drive` in [`../../package.json`](../../package.json).

## Build, test, typecheck

Run from `packages/files-sdk/`:

```bash
bun test test/google-drive.test.ts   # this adapter only
bun test                              # full SDK suite
bun run build                         # tsup → dist/google-drive/index.js
bun run types                         # tsgo --noEmit (typecheck only)
```

This package uses **`bun test`** (not vitest) and **`tsgo`** (not
`tsc`).

## Public surface

Defined in [`index.ts`](./index.ts):

- `googleDrive(opts?: GoogleDriveAdapterOptions): GoogleDriveAdapter` —
  primary factory. The adapter's `name` is `"google-drive"`.
- `GoogleDriveAdapterOptions` — config interface; JSDoc on every field
  is the source of truth (the docs MDX pulls it via `AutoTypeTable`).
- `GoogleDriveAdapter` —
  `Adapter<drive_v3.Drive> & { readonly rootFolderId: string }` so
  callers can introspect the resolved root without re-passing it.
- `GoogleDriveClient` — alias for `drive_v3.Drive`, the type of
  `adapter.raw`.
- `mapDriveError(err): FilesError` — exported so callers reaching for
  `adapter.raw` can re-classify stray googleapis errors against the
  same code table the adapter uses.

## Authentication / configuration

Four explicit auth shapes plus env-var fallbacks. Mutually exclusive —
pass exactly one shape. The factory throws
`FilesError("Provider", …)` at construction if no explicit shape and
no env credentials resolve.

- **Service account, inline** — `credentials: { client_email, private_key }`
  mints a `JWT` with scope `https://www.googleapis.com/auth/drive`.
- **Service account, key file** — `keyFilename: "/path/to/sa.json"`
  builds a `GoogleAuth` against that key. Node-only.
- **OAuth refresh token** — `oauth: { clientId, clientSecret, refreshToken }`
  builds an `OAuth2Client` for 3-legged OAuth to an end-user account.
- **Pre-built `client` escape hatch** — `client: drive_v3.Drive`. Use
  when auth is wired elsewhere (workload identity, Application Default
  Credentials, custom token providers). The adapter cannot recover
  the auth handle, so `signedUploadUrl()` refuses; ADC users who need
  signed uploads should wire the service-account or OAuth path.

Env-var fallbacks (consulted only when no explicit auth is passed; via
[`readEnv`](../internal/env.ts) so the adapter is safe to import on
runtimes without `process` — e.g. Cloudflare Workers without
`nodejs_compat`):

- `GOOGLE_DRIVE_CLIENT_EMAIL` + `GOOGLE_DRIVE_PRIVATE_KEY` → `JWT`.
- `GOOGLE_DRIVE_KEY_FILE` → `GoogleAuth` with that key file.
- `GOOGLE_DRIVE_SUBJECT` → domain-wide delegation subject (only honored
  with `credentials` / `keyFilename`; ignored with `oauth` / `client`).
- `GOOGLE_DRIVE_ID` → `driveId`. When set and `rootFolderId` is unset,
  the Shared Drive id doubles as the root.
- `GOOGLE_DRIVE_ROOT_FOLDER_ID` → `rootFolderId`. Overrides the
  `driveId` fallback when both are present.

Other knobs: `driveId` (Shared Drive id; **strongly recommended for
service-account auth** — service accounts have a 15 GB personal
quota, so production workloads should target a Shared Drive with the
service account added as a member); `rootFolderId` (virtual "bucket
root" — files are created with `parents: [rootFolderId]`, defaults to
`driveId` when set, else `"root"`); `publicByDefault` (when `true`,
every `upload()` follows up with
`permissions.create({ role: "reader", type: "anyone" })` and `url()`
returns a public Drive download URL — adapter-wide, instantiate two
`Files` instances for a mix); `fileIdCacheSize` (per-instance LRU
capacity, default `1024`).

## Operation map

Every method wraps provider errors through `mapDriveError`, and every
googleapis call receives the operation's `AbortSignal` via the second
`MethodOptions` arg (`signalOpts(signal)`).

- `upload` — `files.create` with a multipart media body and a
  `requestBody` of `{ name: basename(key), parents: [rootFolderId],
  mimeType, appProperties }`. `appProperties` carries `fsdkKey`,
  `fsdkContentType`, an optional `fsdkCacheControl`, and the caller's
  `metadata` minus reserved keys. Stream bodies are pumped through a
  Node `Readable` (`Readable.fromWeb` for web streams). When
  `publicByDefault: true`, a follow-up `permissions.create` grants
  anyone-reader on the new `fileId`.
- `download` — resolves the `fileId`, then issues parallel `files.get`
  calls for metadata and `alt: "media"` body. Buffer path returns
  bytes; stream path converts the Node stream to a web `ReadableStream`
  via `Readable.toWeb`.
- `head` — `files.get` with `FILE_FIELDS`; the returned `StoredFile`
  installs a lazy body factory that issues `alt: "media"` on first
  access. Not free.
- `exists` — `existsByProbe(files.get, mapDriveError)` from
  [`../internal/core.ts`](../internal/core.ts). `NotFound` → `false`;
  other failures propagate.
- `delete` — resolves the `fileId`, then `files.delete`. **Hard
  delete** — `files.delete` permanently removes the item; the adapter
  does not call `files.update({ trashed: true })` or `files.trash`,
  matching every other adapter's `delete()` semantics. Idempotent: a
  `NotFound` from either step is swallowed and the cache entry evicted.
- `copy` — `files.copy` server-side; the destination `fsdkKey` is set
  on the new file and the new `fileId` is seeded into the cache.
- `list` — `files.list` scoped to
  `'<rootFolderId>' in parents and trashed=false`. Results are
  filtered client-side to files carrying an `fsdkKey` (foreign files
  in the same folder are excluded), and `prefix` is applied
  client-side per page. `cursor` round-trips Drive's `nextPageToken`;
  `limit` → `pageSize`.
- `url` — when `publicByDefault: true` and no
  `responseContentDisposition`, returns
  `https://drive.google.com/uc?export=download&id=${fileId}`.
  Otherwise throws `Provider`.
- `signedUploadUrl` — mints an access token from the stored auth
  handle, POSTs to the Drive resumable endpoint
  (`/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`)
  with `Authorization: Bearer …`, `X-Upload-Content-Type` (when set),
  `X-Upload-Content-Length` (when `maxSize` is set), and a JSON body
  of `{ name, parents, appProperties }`. Returns the session URL from
  the `Location` header as `{ method: "PUT", url, headers? }`. Drive
  has no presigned-POST analogue.

`resolveFileId(key)` is the shared lookup hot path. Checks the LRU,
otherwise issues `files.list` with
`q = "appProperties has { key='fsdkKey' and value='…' } and trashed=false"`
asking for at most 2 hits. Zero matches throw `NotFound`; two-or-more
throw `Conflict` rather than picking one silently.

## URL behavior

- **`url()` requires `publicByDefault: true`** — otherwise throws
  `Provider`. Drive has no signed-URL primitive comparable to S3's
  `GetObject` presign; the closest analogues (`webViewLink`,
  `webContentLink` returned by `files.get`) only work once
  `permissions.create` has run, which is what `publicByDefault` does
  at upload time.
- **`url()` returns a permanent download URL.** Shape:
  `https://drive.google.com/uc?export=download&id=${fileId}`.
  `expiresIn` is silently ignored. For temporary exposure, proxy
  `download()` through your own endpoint.
- **`responseContentDisposition` always throws.** Drive's
  `webContentLink`-style download URL has no Content-Disposition
  override, and silently dropping the override would be a stored-XSS
  regression on user-uploaded HTML/SVG (per
  [`resolveUrlStrategy`](../internal/core.ts) rationale).

## Provider quirks worth remembering

- **Keys are virtual; no path hierarchy.** Drive identifies files by
  opaque random `fileId`s. `docs/a.txt` and `other/a.txt` live as flat
  files inside `rootFolderId`, distinguished only by `fsdkKey`;
  `basename(key)` is the Drive `name`.
- **No folder creation.** A Drive "folder" is a file with mime type
  `application/vnd.google-apps.folder`. The adapter does not create
  folders for slash-separated key segments — every uploaded file is
  parented directly to `rootFolderId`. Build folder hierarchy via
  `adapter.raw.files.create` if you want the segments to render as
  Drive folders in the UI.
- **Reserved `fsdk` metadata prefix.** `fsdkKey`, `fsdkContentType`,
  `fsdkCacheControl` are bookkeeping; caller `metadata` keys starting
  with `fsdk` throw `Provider` at upload time
  (`assertNoReservedMetadata`).
- **`appProperties` is per-application.** Drive scopes it to the OAuth
  client (or service account) that wrote them — switching auth modes
  looks like a wiped bucket.
- **Shared Drive plumbing is unconditional.** When `driveId` is set,
  every call carries the four `supportsAllDrives` /
  `includeItemsFromAllDrives` / `corpora` / `driveId` params. The
  resumable-upload endpoint URL also pins `supportsAllDrives=true`.
- **Multipart-upload boundary.** `files.create` with a `media` body is
  Drive's "multipart" upload path (supported up to ~5 GB per request).
  Larger bodies should go through the resumable-session URL minted by
  `signedUploadUrl()`, or call `adapter.raw.files.create` with
  `media.body` set up for resumable yourself. Smaller bodies sail
  through the multipart path even when streamed.
- **Duplicate `fsdkKey` is a `Conflict`.** If two files share a virtual
  key (out-of-band or via racing clients), `resolveFileId` throws
  `Conflict` rather than picking one silently. Resolve via
  `adapter.raw`.
- **Per-instance cache, not shared.** `fileIdCache` lives on the
  adapter instance; cross-process consumers pay the `files.list`
  round-trip on every cold key.
- **Drive quotas.** Default per-user limits are on the order of
  1000 requests / 100 s (see
  [Drive API limits](https://developers.google.com/drive/api/guides/limits));
  bursts return 403 `userRateLimitExceeded`, which `mapDriveError`
  classifies as `Unauthorized`.
- **`signedUploadUrl` is advisory on size.** Drive does not enforce a
  server-side size policy on resumable sessions. `maxSize` is forwarded
  as `X-Upload-Content-Length` but is **not binding**. `minSize` is
  ignored entirely.
- **Error classification.** `mapDriveError` reads HTTP status from
  `err.code` (number), `err.status`, or `err.response.status`. 404 →
  `NotFound`; 401/403 → `Unauthorized`; 409/412 → `Conflict`; else
  `Provider`. Original error preserved on `.cause`.

## Testing approach

Tests at
[`../../test/google-drive.test.ts`](../../test/google-drive.test.ts)
mock `@googleapis/drive` and `google-auth-library` via `mock.module`
and back the fake `files.*` calls with a `Map<string, FakeFile>`, so
the suite round-trips uploads and reads in-memory. `signedUploadUrl`
is tested by stubbing `globalThis.fetch` and asserting on the
resumable POST. Coverage includes construction-time failures, env-var
fallbacks (the `GOOGLE_DRIVE_ID` → `rootFolderId` fallback and the
`GOOGLE_DRIVE_ROOT_FOLDER_ID` override), `upload` writing the right
`appProperties`, `publicByDefault`'s `permissions.create` follow-up,
every read/list/copy/delete path, the duplicate-key `Conflict`, both
`url` invariants, the `signedUploadUrl` POST (headers, body shape,
returned `Location`), the full status-code classification table
(including `err.response.status` fallback), and signal forwarding for
every method. Add new tests here — Drive's surface is its own.

## Coding conventions

- Named exports only — `googleDrive`, `mapDriveError`,
  `GoogleDriveAdapter`, `GoogleDriveAdapterOptions`,
  `GoogleDriveClient`. No default exports.
- Errors wrap as `FilesError` via `mapDriveError`; pass `FilesError`
  instances through unchanged (the mapper short-circuits on them).
- Body normalization is **local** (`normalizeBody` in this file)
  because Drive's media body wants a Node `Readable`; the shared
  [`normalizeBody`](../internal/core.ts) returns
  `Uint8Array | ReadableStream`. Keep content-type defaulting rules
  in sync if either ever changes.
- Use [`createStoredFile`](../internal/stored-file.ts) for every
  `StoredFile` returned. Don't hand-roll body accessors — the
  `factory` / `kind: "lazy"` path is what `head()`'s body-on-demand
  contract depends on.
- Forward `operationOpts.signal` via `signalOpts(signal)` — the second
  arg of every `drive_v3.Drive` method. Tests assert on this for
  every operation.
- Drive's `q` syntax requires single-quote escaping with backslashes.
  Use `escapeQueryValue` for any user-derived value spliced into a
  `q` string.
- Reserved `appProperties` keys live as `KEY_PROP` /
  `CONTENT_TYPE_PROP` / `CACHE_CONTROL_PROP` module constants. Don't
  inline the strings.
- No `process.env` outside [`readEnv`](../internal/env.ts). Top-level
  regex literals only (the current file has none).

## Releases

Ships with the rest of the monorepo via Changesets. Behavioral changes
(new options, default changes, error-shape changes, new auth modes)
need a changeset (`bunx changeset` from the repo root, pick
`files-sdk`); docs / test-only edits don't. The `google-drive`
subpath is already declared in
[`../../package.json`](../../package.json)'s `exports` map. Update
[`../../CHANGELOG.md`](../../CHANGELOG.md) when shipping behavioral
changes.

## Where to look next

- Source: [`./index.ts`](./index.ts); tests:
  [`../../test/google-drive.test.ts`](../../test/google-drive.test.ts).
- User docs:
  [`../../../../apps/web/content/docs/adapters/google-drive.mdx`](../../../../apps/web/content/docs/adapters/google-drive.mdx);
  provider catalog (`slug: "google-drive"`):
  [`../providers/index.ts`](../providers/index.ts).
- Unified `Adapter` contract: [`../index.ts`](../index.ts).
- Shared helpers: [`../internal/core.ts`](../internal/core.ts);
  errors [`../internal/errors.ts`](../internal/errors.ts); env
  [`../internal/env.ts`](../internal/env.ts); stored-file
  [`../internal/stored-file.ts`](../internal/stored-file.ts).
- Package [`README`](../../README.md); SKILL
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
- Drive API limits:
  [https://developers.google.com/drive/api/guides/limits](https://developers.google.com/drive/api/guides/limits).
