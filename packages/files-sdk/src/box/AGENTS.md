# AGENTS.md — `files-sdk/box`

Guidance for coding agents working on the `box` adapter. The unified
`Adapter` contract — call shapes, `FilesError`, `UrlOptions`,
`SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file only documents box-specific
behavior. `box()` is a native adapter over
[`box-typescript-sdk-gen`](https://github.com/box/box-typescript-sdk-gen)
for [Box](https://www.box.com) cloud content. Box files are addressed by
stable IDs, not paths, so the adapter maps virtual slash-separated keys
onto a folder tree rooted at `rootFolderId`. Cross-references:
[`README.md`](../../README.md),
[`SKILL.md`](../../../../skills/files-sdk/SKILL.md).

## Overview

A full native implementation (~1000 lines) that wires the unified API to
Box's REST surface via the generated SDK. Virtual keys like `docs/a.txt`
are split into path segments, walked under `rootFolderId` (default `"0"` —
the account root folder), and resolved to Box file/folder IDs with
per-instance caches. Upload auto-creates missing intermediate folders;
read/delete/copy resolve existing paths only. Five auth shapes plus a
pre-built `client` escape hatch cover developer scripts, user OAuth apps,
Client Credentials Grant (enterprise or app-user), and JWT server auth —
token refresh and exchange are delegated to the SDK's `Authentication`
classes. The returned adapter's `raw` is the underlying `BoxClient`; anything
the SDK exposes (metadata templates, retention, workflows) is one property
access away. `BoxAdapter` also exposes `rootFolderId` for callers that need
the configured anchor.

## Directory layout

```
packages/files-sdk/src/box/
├── index.ts                   # box() factory + BoxAdapterOptions
├── AGENTS.md                  # this file
└── CLAUDE.md                  # @AGENTS.md — Claude-Code re-export
```

Tests at [`../../test/box.test.ts`](../../test/box.test.ts);
user-facing docs at
[`../../../../apps/web/content/docs/adapters/box.mdx`](../../../../apps/web/content/docs/adapters/box.mdx).

## Build, test, typecheck

Run from `packages/files-sdk`:

```bash
bun test test/box.test.ts   # adapter unit tests only
bun test                     # full SDK suite
bun run build                # tsup → dist/, including dist/box/
bun run types                # tsgo --noEmit (typecheck only)
```

The `box` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep that
entry in sync if the file layout changes. Peer dependency:
`box-typescript-sdk-gen`.

## Public surface

Exports from [`index.ts`](./index.ts):

- `box(opts?: BoxAdapterOptions): BoxAdapter` — primary factory.
- `BoxAdapter` — `Adapter<BoxClient>` plus `readonly rootFolderId: string`.
  `raw` is the underlying `BoxClient`.
- `BoxAdapterOptions`, `BoxOAuthOptions`, `BoxCcgOptions`, `BoxJwtOptions`
  — config interfaces (JSDoc on every field is the source of truth; the
  docs MDX pulls it via `AutoTypeTable`).
- `mapBoxError(err: unknown): FilesError` — exported for tests and
  callers that invoke `raw` directly.
- `BoxClient` — re-exported type alias from `box-typescript-sdk-gen`.

The adapter's `name` is `"box"`.

## Authentication / configuration

Pass **exactly one** auth method (or `client`). More than one throws
`FilesError("Provider", …)` at construction.

| Mode | Option | Notes |
| ---- | ------ | ----- |
| Escape hatch | `client?: BoxClient` | Caller wires auth, `NetworkSession`, proxies, downscoped tokens. |
| Developer token | `developerToken?: string` | Short-lived console token. Env fallback: `BOX_DEVELOPER_TOKEN` via [`readEnv`](../internal/env.ts). |
| OAuth (user app) | `oauth?: BoxOAuthOptions` | `clientId`, `clientSecret`, `refreshToken`. Seeds SDK token storage on first API call; SDK refreshes access tokens. |
| CCG (server) | `ccg?: BoxCcgOptions` | `clientId`, `clientSecret`, plus **`enterpriseId` or `userId`** (required). `enterpriseId` → service account; `userId` → managed/app user. |
| JWT (server) | `jwt?: BoxJwtOptions` | `configJsonString` or `configFilePath` → `JwtConfig` from Box developer console JSON. |

Production auth (OAuth, CCG, JWT) is configured via constructor options,
not env vars — only `BOX_DEVELOPER_TOKEN` has an env fallback. The
provider catalog entry in [`../providers/index.ts`](../providers/index.ts)
(search `slug: "box"`) documents the same.

Optional knobs:

- `rootFolderId` — logical bucket root (default `"0"`). Virtual keys live
  under this folder; it must already exist. Intermediate subfolders are
  auto-created on `upload()` only.
- `publicByDefault` — when `true`, `upload()` calls `addShareLinkToFile`
  (`access: "open"`) and `url()` returns the shared link's
  `download_url` (or `url`). Default `false`.
- `publicBaseUrl` — when set, `url(key)` returns
  `${publicBaseUrl}/${key}` via [`joinPublicUrl`](../internal/core.ts)
  and skips signing and shared-link resolution. No API calls.
- `defaultUrlExpiresIn` — accepted for API symmetry on `url()`; Box's
  `getDownloadFileUrl` does not take an expiry parameter (TTL is
  server-controlled). Defaults to `DEFAULT_URL_EXPIRES_IN` (3600) from
  [`../internal/core.ts`](../internal/core.ts).

## Operation map

All methods call `authHandle.ensureReady()` first (OAuth seeds the refresh
token lazily). Errors pass through `mapBoxError`.

| Method | Implementation |
| ------ | -------------- |
| `upload(key, body, opts?)` | `splitKey` → `resolveFolderId({ create: true })` → `resolveExistingFileForUpload` → `uploadFile` / `uploadFileVersion` (≤ 50 MB) or `chunkedUploads.uploadBigFile` (> 50 MB). Bodies normalized to `Buffer` then `Readable`. Rejects non-empty `metadata` and `cacheControl`. Optional `ensureSharedLink` when `publicByDefault`. |
| `download(key, opts?)` | Resolve file ID → `getFileById` for metadata → `getDownloadFileUrl` → `fetch` (forwards `signal`). Default buffer; `opts.as: "stream"` returns a `ReadableStream`. |
| `head(key)` | `getFileById` metadata + lazy body factory (`lazyDownload`). |
| `exists(key)` | [`existsByProbe`](../internal/core.ts) around `resolveFileId` + lightweight `getFileById`. |
| `delete(key)` | Idempotent: missing key is a no-op. Resolves ID, `deleteFileById`, drops cache entry. Swallows `NotFound` from delete (out-of-band removal). |
| `copy(from, to)` | `copyFile` with destination folder resolved (`create: true`). |
| `list(opts?)` | Paginated `getFolderItems` on **`rootFolderId` only** — immediate file children, no subfolder recursion. `prefix` filtered client-side on `name`. Cursor is numeric offset string. Subfolders and web links skipped. |
| `url(key, opts?)` | `publicBaseUrl` short-circuit, else shared link (`publicByDefault`) or `getDownloadFileUrl`. Rejects `responseContentDisposition`. |
| `signedUploadUrl` | **Throws** — Box multipart upload shape does not fit the SDK's PUT/POST-form contract. |

`deleteMany` is **not** implemented; `Files.deleteMany()` fans out to
`delete()` with bounded concurrency via
[`deleteManyWithFallback`](../internal/core.ts).

## URL behavior

Three paths, in precedence order:

1. **`publicBaseUrl` set** — `${publicBaseUrl}/${key}` unsigned. Path
   segments URL-encoded by `joinPublicUrl`. No Box API call; file need not
   exist.
2. **`publicByDefault: true`** — `addShareLinkToFile` (`access: "open"`)
   on upload; `url()` returns `download_url` ?? `url` from the shared
   link. Idempotent on conflict (re-fetches existing link). Enterprise
   plans may block open links (`access_denied_insufficient_permissions`).
3. **Default** — `getDownloadFileUrl(fileId)`. Short-lived; `expiresIn`
   is accepted for API symmetry but not passed to Box.

`responseContentDisposition` always throws — Box download URLs and shared
links have no Content-Disposition override.

## Provider quirks worth remembering

- **IDs vs paths.** Box's API is ID-centric. The adapter hides this with
  virtual keys and caches (`folderIdCache`, `fileIdCache`). On `NotFound`,
  cache entries are dropped so out-of-band moves/deletes are picked up on
  the next call. Keys are **not** Box file IDs — do not pass `"12345"` as a
  key unless a file is literally named that at the resolved folder.
- **`rootFolderId` is not created for you.** Point it at an existing folder
  (e.g. a dedicated "SDK Storage" folder). `"0"` is the user's root — on
  enterprise accounts this is the service account's root, on personal
  accounts the personal root.
- **CCG `enterpriseId` vs `userId`.** Enterprise installs authenticate as
  the service account (`enterpriseId`). App-user / managed-user flows use
  `userId`. At least one is required.
- **OAuth refresh seeding.** The adapter stores `{ accessToken: "", refreshToken }`
  before the first call; the SDK's interceptor exchanges on 401. Tests
  reach `_authHandle` (non-enumerable) — do not document as public API.
- **50 MB upload threshold.** `SIMPLE_UPLOAD_LIMIT_BYTES` — above that,
  `chunkedUploads.uploadBigFile`. Stream bodies are fully buffered first
  because the SDK expects a Node `Readable`.
- **`list()` is shallow.** Only files directly under `rootFolderId`; keys
  in the result are **bare filenames** (`a.txt`), not full virtual paths.
  Deep enumeration requires `raw.folders.getFolderItems` and manual
  recursion.
- **Content types are inferred.** Box does not persist caller-supplied
  `contentType` on file content. `head()` / `list()` infer MIME from the
  filename extension (`TYPE_BY_EXT` table).
- **`signedUploadUrl` unsupported.** Box requires multipart POST with an
  `attributes` JSON part plus file bytes — incompatible with the SDK's
  PUT-with-headers or POST-form `SignedUpload` shapes. Use server-side
  `upload()` or Box UI Elements for browser flows.
- **Folder walk races.** `createFolder` conflicts (`item_name_in_use`) trigger
  a re-resolve — another writer may have created the folder between find
  and create.
- **Pagination in `findChildByName`.** Folder listings paginate at 1000;
  large folders need multiple `getFolderItems` calls during path resolution.

## Testing approach

Unit tests at [`../../test/box.test.ts`](../../test/box.test.ts) use a
fully mocked `BoxClient` (in-memory `Map` store) — no live Box API calls.
Coverage includes:

- Auth validation (missing auth, multiple auth, CCG without
  `enterpriseId`/`userId`, env `BOX_DEVELOPER_TOKEN`, OAuth/JWT/CCG
  construction paths).
- Upload (root default, nested folder auto-create, overwrite via
  `uploadFileVersion`, chunked > 50 MB, body shapes, metadata/cacheControl
  rejection, `publicByDefault` shared links).
- Download (buffer + stream, `signal` forwarding, fetch error paths).
- `head` lazy download, `exists`, idempotent `delete`, `copy` with nested
  destination, shallow `list` with prefix and cursor pagination.
- `url()` (signed default, shared link, `publicBaseUrl`, disposition throw).
- `signedUploadUrl` throw, `rootFolderId` scoping, `mapBoxError`
  classification table, folder/file cache behavior, path-segment conflicts,
  createFolder race recovery, OAuth `ensureReady` seeding.

Add box-specific fixtures here rather than elsewhere. When mocking, match
the duck-typed `BoxApiError` shape (`responseInfo.statusCode` /
`responseInfo.code`) that `mapBoxError` expects.

## Coding conventions

- Named exports only — `box`, `BoxAdapter`, `BoxAdapterOptions`,
  `mapBoxError`, type aliases.
- Construction-time validation throws
  [`FilesError("Provider", …)`](../internal/errors.ts); operation errors
  are caught and rethrown via `mapBoxError`.
- Environment variables via [`readEnv`](../internal/env.ts) — never
  `process.env` directly (Cloudflare Workers without `nodejs_compat`).
- Path helpers (`trimSlashes`, `splitKey`, `folderCacheKey`) are module-level
  pure functions. Folder walks and pagination loops intentionally use
  sequential `await` (eslint `no-await-in-loop` suppressed with comments).
- `mapBoxError` uses `||` (not `??`) for message fallback so empty-string
  Box messages still get the default table.
- Cache invalidation: `dropFileFromCache` on successful delete; implicit
  invalidation on resolve `NotFound` is not implemented for folders — folder
  cache persists until adapter instance is discarded.
- Top-level regex in tests only; [`index.ts`](./index.ts) has none.

## Releases

Ships with the rest of the monorepo from
[`../../package.json`](../../package.json). Behavioral changes (new
options, default changes, error-shape changes) bump the `files-sdk`
version and add an entry to [`../../CHANGELOG.md`](../../CHANGELOG.md);
pure docs / test-only additions don't. The `box` subpath is already
declared in `exports` — no further wiring needed for new options.

## Where to look next

- Unified contract & `Adapter` interface: [`../index.ts`](../index.ts).
- Shared helpers (`joinPublicUrl`, `existsByProbe`, `DEFAULT_URL_EXPIRES_IN`):
  [`../internal/core.ts`](../internal/core.ts).
- `FilesError` and codes: [`../internal/errors.ts`](../internal/errors.ts).
- Env-var reader: [`../internal/env.ts`](../internal/env.ts).
- `StoredFile` factory: [`../internal/stored-file.ts`](../internal/stored-file.ts).
- Provider catalog entry (search `slug: "box"`):
  [`../providers/index.ts`](../providers/index.ts).
- User-facing docs:
  [`../../../../apps/web/content/docs/adapters/box.mdx`](../../../../apps/web/content/docs/adapters/box.mdx).
- Package README: [`../../README.md`](../../README.md).
- SKILL doc:
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
- Tests: [`../../test/box.test.ts`](../../test/box.test.ts).
