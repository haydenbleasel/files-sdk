# AGENTS.md — `files-sdk/dropbox`

Guidance for coding agents working inside the `files-sdk/dropbox`
adapter. Every adapter implements the same `Adapter<Raw>` contract from
[`../index.ts`](../index.ts); this file documents only the
dropbox-specific deviations. For the unified surface, read
[`../../README.md`](../../README.md) and
[`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md)
first.

Dropbox is a NATIVE adapter — it talks to the official `dropbox` SDK
directly rather than going through `s3()`. Most adapter-level bugs
land in one of two places: the four-shaped auth resolver (pre-built
client, static token, callable token, OAuth refresh-token flow) or
the URL strategy that splits between 4-hour temporary links and
permanent shared links.

## Overview

Dropbox via the official `dropbox` SDK. Family: **consumer file
provider** (alongside `google-drive`, `onedrive`, `box`, `sharepoint`).
Path-addressable like OneDrive — virtual keys map directly to Dropbox
paths under an optional `rootFolderPath` virtual bucket root, so there
is no virtual-key cache and no ID resolution.

The unified surface — `upload`, `download`, `head`, `exists`,
`delete`, `copy`, `list`, `url` — is implemented natively against the
SDK's `filesUpload` / `filesDownload` / `filesGetMetadata` /
`filesDeleteV2` / `filesCopyV2` / `filesListFolder` /
`sharingCreateSharedLinkWithSettings` / `filesGetTemporaryLink`
primitives. `signedUploadUrl()` throws — see Operation map. Optional
peer dependency: `dropbox`.

## Directory layout

```text
packages/files-sdk/src/dropbox/
├── index.ts                # adapter implementation + auth resolver
├── AGENTS.md               # this file
└── CLAUDE.md               # `@AGENTS.md`
```

Sibling files outside this directory:

- Tests: [`../../test/dropbox.test.ts`](../../test/dropbox.test.ts)
  (adapter behaviour) and
  [`../../test/dropbox-auth.test.ts`](../../test/dropbox-auth.test.ts)
  (auth resolver + refresh flow).
- User docs:
  [`../../../../apps/web/content/docs/adapters/dropbox.mdx`](../../../../apps/web/content/docs/adapters/dropbox.mdx).
- Provider catalog entry (search `slug: "dropbox"`):
  [`../providers/index.ts`](../providers/index.ts).

## Build, test, typecheck

Run from `packages/files-sdk/`:

```bash
bun test test/dropbox.test.ts         # adapter unit tests
bun test test/dropbox-auth.test.ts    # auth resolver + refresh-token flow
bun test                              # full SDK suite
bun run build                         # tsup ESM bundle -> dist/dropbox/
bun run types                         # tsgo --noEmit (typecheck only)
```

This package uses **`bun test`** (not vitest) and **`tsgo`** (not
`tsc`). The per-subpath bundle output is `dist/dropbox/index.{js,d.ts}`
per the `exports` map in [`../../package.json`](../../package.json).

## Public surface

Defined in [`./index.ts`](./index.ts):

- `dropbox(opts: DropboxAdapterOptions): DropboxAdapter` — primary
  factory.
- `DropboxAdapter` — `Adapter<DropboxClient> & { readonly rootFolderPath: string }`
  so callers can read the configured root without re-passing it.
- `DropboxClient` — type alias for the SDK's `Dropbox` class. `raw` is
  the underlying client.
- `DropboxAdapterOptions` — config interface; JSDoc on every field is
  the source of truth (the docs MDX pulls it via `AutoTypeTable`).
- `mapDropboxError(err): FilesError` — exported for tests and callers
  that need to classify an SDK error themselves.

The adapter also hangs a non-enumerable `_authHandle` for the auth
tests to reach `ensureAccessToken` / `getAccessToken`. Test-only —
don't promote it to the public type.

## Authentication / configuration

Dropbox's auth is the most distinctive part of this adapter. Four
shapes are accepted, with a strict "exactly one" rule:

1. **Pre-built `client`** — pass a `Dropbox` instance you already
   constructed (team-space `pathRoot`, shared `DropboxAuth`, custom
   headers, …). The adapter never refreshes; you own the token
   lifecycle. `ensureAccessToken()` is a no-op.
2. **Static `accessToken: string`** — applied at construction via
   `DropboxAuth({ accessToken })`. `ensureAccessToken()` is a no-op.
3. **Callable `accessToken: () => string | Promise<string>`** — the
   resolver is awaited on **every** call and pushed into the SDK
   before the request goes out. The adapter does not cache the
   result; caching/refresh is the caller's responsibility. Pairs
   naturally with secret managers.
4. **OAuth2 refresh-token flow** — `refreshToken` plus `appKey`, and
   optionally `appSecret`. The adapter exchanges credentials at
   `https://api.dropboxapi.com/oauth2/token` and caches the access
   token until ~60s before expiry (`REFRESH_LEEWAY_MS = 60_000`).
   Confidential (server-side) clients pass both `appKey` and
   `appSecret`; PKCE-only public clients pass `appKey` alone and
   `client_secret` is omitted from the form body.

Mode selection rules (enforced in `resolveAuth`): `client` wins
outright; `accessToken` together with any refresh-flow field throws
`Provider`; refresh flow requires both `refreshToken` and `appKey`.
The SDK's own auto-refresh is **not** activated — `DropboxAuth({})`
is constructed without `refreshToken` / `clientId` so the SDK can't
race the adapter's refresh. The adapter is the sole refresh authority
and the SDK just sees a fresh token on each call (via `setAccessToken`).

Env-var fallback (read via [`readEnv`](../internal/env.ts), safe on
Cloudflare Workers without `nodejs_compat`): `DROPBOX_ACCESS_TOKEN`
for static-token mode, or `DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY`
(+ optional `DROPBOX_APP_SECRET`) for the refresh flow. If nothing
resolves, construction throws `FilesError("Provider", …)` enumerating
every accepted shape.

## Operation map

Every method awaits `authHandle.ensureAccessToken()` before issuing
the SDK call and catches with `mapDropboxError`.

- `upload` — `filesUpload` with `mode: { ".tag": "overwrite" }` and
  `mute: true` for bodies up to `SIMPLE_UPLOAD_LIMIT_BYTES`
  (`150 * 1024 * 1024`, Dropbox's single-call cap). Larger bodies
  switch to the chunked path: `filesUploadSessionStart` →
  N × `filesUploadSessionAppendV2` (8 MiB chunks) →
  `filesUploadSessionFinish`. `metadata` and `cacheControl` throw
  `Provider` at the boundary — Dropbox files carry neither field
  natively. With `publicByDefault: true`, a shared link is also
  created on upload (idempotent — see URL behavior).
- `download` — buffer path issues `filesDownload` and extracts bytes
  from either `fileBinary` (Node) or `fileBlob` (browser/Workers).
  Stream path is special: the SDK's `filesDownload` buffers the full
  response, so true streaming falls back to `filesGetTemporaryLink`
  plus a `fetch()` against the returned URL (which exposes
  `Response.body` as a real `ReadableStream`). `signal` only flows
  through on the stream path; the SDK transport has no cancellation
  primitive.
- `head` — `filesGetMetadata`. Folder/deleted entries are rejected as
  `NotFound`. The returned `StoredFile` installs a lazy body factory
  that re-issues `filesDownload` on first body access — not free.
- `exists` — `existsByProbe` against `filesGetMetadata` with the same
  folder/deleted rejection (duplicated because the probe wrapper
  expects a `NotFound` throw, not a sentinel value).
- `delete` — `filesDeleteV2`. Idempotent: a mapped `NotFound` returns
  silently; other errors propagate.
- `copy` — `filesCopyV2` (server-side; no read+write round-trip).
- `list` — `filesListFolder` with `recursive: true`;
  `filesListFolderContinue` when a `cursor` is passed. Folders and
  any entry whose path equals `rootFolderPath` are dropped. When
  `has_more` is set, `result.cursor` is surfaced as
  `ListResult.cursor`.
- `url` — see URL behavior below.
- `signedUploadUrl` — throws `Provider`. Dropbox's
  `files/get_temporary_upload_link` returns a URL that requires
  `POST` with `Content-Type: application/octet-stream` and the raw
  bytes as the body. Our `SignedUpload` shape supports
  PUT-with-raw-body or POST-with-form-fields (S3 policy style); a
  raw-body POST fits neither. The JSDoc points callers at
  `adapter.raw.filesGetTemporaryUploadLink(...)`.

Body normalization is local (the dropbox SDK accepts Node `Buffer`,
which the shared [`normalizeBody`](../internal/core.ts) does not
preserve). Error mapping (`mapDropboxError`) walks the SDK's
discriminated `.tag` union with a depth-6 guard, classifies by first
matching tag, then falls back to HTTP status. Tag sets:

- `NOT_FOUND_TAGS = { not_found, not_file, not_folder, restricted_content }`
- `UNAUTH_TAGS = { invalid_access_token, expired_access_token, missing_scope, user_suspended, route_access_denied, access_denied }`
- `CONFLICT_TAGS = { conflict, no_write_permission, shared_link_already_exists }`

HTTP 409 alone is **not** a `Conflict` signal — Dropbox uses 409 as
the generic envelope for endpoint-specific errors and the actual
classification lives in the body tags. `FilesError` instances pass
through untouched.

## URL behavior

`url(key, opts?)` follows a three-state decision tree distinct from
the signing-adapter precedence:

1. `publicBaseUrl` set → `${publicBaseUrl}/${key}` via
   [`joinPublicUrl`](../internal/core.ts). No network call, no
   signing. Useful when a CDN sits in front of pre-shared Dropbox
   links.
2. `publicByDefault: true` → creates (or retrieves) a permanent
   public shared link via `sharingCreateSharedLinkWithSettings`. The
   result is rewritten so `?dl=0` becomes `?dl=1` (raw bytes instead
   of the preview page); URLs that already carry a `dl=` parameter
   are left untouched, and URLs with no `dl=` get `?dl=1` (or `&dl=1`
   when a query string is already present) appended.
3. Otherwise → mints a `filesGetTemporaryLink`. The per-call
   `expiresIn` beats `defaultUrlExpiresIn`, which is clamped at
   construction to `MAX_TEMPORARY_LINK_DURATION = 14_400` (4 hours,
   Dropbox's maximum). Per-call values above 14400 throw `Provider`
   with guidance to switch to `publicByDefault: true` for a permanent
   link.

`responseContentDisposition` always throws `Provider` — neither
temporary nor shared links honour a disposition override on Dropbox,
and silently dropping the override is the kind of stored-XSS
regression [`resolveUrlStrategy`](../internal/core.ts) explicitly
guards against elsewhere.

The shared-link creation path handles `shared_link_already_exists`:
the SDK throws with the existing link's metadata at
`err.error.shared_link_already_exists.metadata.url`, and the adapter
reuses that URL (rewriting `dl=0` → `dl=1`). If the embedded
metadata is empty or missing, the original error is rethrown.

## Provider quirks worth remembering

- **Plan policy can forbid public shared links.** Dropbox Business
  teams may disable public shared links entirely. The adapter
  surfaces Dropbox's `access_denied` error unmodified (classified as
  `Unauthorized`) — don't retry or fall back to a temporary link;
  the team policy is the answer.
- **150 MB simple-upload limit.** Bodies above
  `SIMPLE_UPLOAD_LIMIT_BYTES` switch to `filesUploadSession*` with
  8 MiB chunks (session ceiling is Dropbox's 350 GB cap). The
  boundary is inclusive — exactly 150 MiB uses the simple path;
  150 MiB + 1 byte uses the session path.
- **Path normalization is case-insensitive.** Dropbox lowercases
  paths, so `head()` and `list()` results may carry casing different
  from what the caller uploaded. The adapter prefers `path_display`
  and falls back to `path_lower`.
- **No native content-type or arbitrary metadata.** `filesUpload`
  accepts no Content-Type; `download()` infers a MIME from the
  filename extension via the local `TYPE_BY_EXT` table.
  `upload(..., { metadata })` throws — escape hatch is `adapter.raw`
  plus `property_groups` (requires a registered Dropbox template).
- **Refresh-flow cache is per-instance.** The cached
  `{ token, expiresOnMs }` is not shared across processes;
  multi-process deployments mint independent tokens. Dropbox
  tolerates this, but OAuth-endpoint log volume scales with process
  count.
- **`rootFolderPath` must already exist.** The adapter does not
  auto-create folders. `keyToPath` joins `rootFolderPath` with the
  virtual key under a single leading slash; `pathToKey` strips it
  back off for `list()` so callers see un-prefixed keys.

## Testing approach

Two test files split the surface:

- [`../../test/dropbox.test.ts`](../../test/dropbox.test.ts) — uses a
  hand-rolled `fakeClient` implementing every Dropbox SDK method as a
  `mock(...)` returning `{ headers, result, status }` envelopes from
  an in-memory `Map<string, FakeFile>`. Covers the full operation
  map, every `mapDropboxError` branch (tag-based and status
  fallback), simple-vs-session upload, body shapes (`string`,
  `Uint8Array`, `Blob`, `ArrayBuffer`, `ArrayBufferView`,
  `ReadableStream`), stream-mode download via the temporary-link
  fetch, the `publicByDefault` flow including
  `shared_link_already_exists` recovery and rethrow, `rootFolderPath`
  nesting, and the chunked-upload offset math.
- [`../../test/dropbox-auth.test.ts`](../../test/dropbox-auth.test.ts)
  — exercises the auth resolver in isolation via `_authHandle`.
  Covers static / callable / refresh-token modes, the 60s pre-expiry
  refresh leeway, the PKCE-vs-confidential `client_secret` toggle,
  env-var fallbacks, the non-OK response and missing-`access_token`
  failure paths, and the unreadable-error-body defensive branch.

`bun test` is the runner — no vitest. When adding behaviour, prefer
extending the existing `fakeClient` over fabricating new SDK shapes
inline.

## Coding conventions

- Named exports only — no default exports.
- Errors flow through `mapDropboxError`; `FilesError` instances
  short-circuit so internal throws aren't rewrapped.
- Body normalization is the local `normalizeBody` (returns `Buffer`),
  not the shared [`normalizeBody`](../internal/core.ts) (returns
  `Uint8Array`). The Dropbox SDK accepts `Buffer` directly;
  converting through `Uint8Array` would force a redundant copy.
- The SDK's published `.d.ts` omits the `auth` field on the `Dropbox`
  class, but the constructor stores it at runtime. Cast through
  `DropboxWithAuth` rather than `as any`.
- No `process.env` outside [`readEnv`](../internal/env.ts). Use
  `createStoredFile` from
  [`../internal/stored-file.ts`](../internal/stored-file.ts) for
  every `StoredFile` returned. The non-enumerable `_authHandle` is
  test-only — don't promote it and don't reach for it elsewhere.

## Releases

Ships via Changesets. Behavioural changes (new options, default
changes, error-shape changes, new auth modes) need a changeset — run
`bunx changeset` from the repo root and pick `files-sdk`. README,
AGENTS.md, and pure test additions don't. The Dropbox subpath is
already declared in [`../../package.json`](../../package.json)
`exports`.

## Where to look next

- Unified `Adapter` contract: [`../index.ts`](../index.ts); source:
  [`./index.ts`](./index.ts); tests:
  [`../../test/dropbox.test.ts`](../../test/dropbox.test.ts),
  [`../../test/dropbox-auth.test.ts`](../../test/dropbox-auth.test.ts).
- Shared helpers: [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts).
- Provider catalog (search `slug: "dropbox"`):
  [`../providers/index.ts`](../providers/index.ts).
- User docs:
  [`../../../../apps/web/content/docs/adapters/dropbox.mdx`](../../../../apps/web/content/docs/adapters/dropbox.mdx);
  package [`README`](../../README.md);
  [`SKILL`](../../../../skills/files-sdk/SKILL.md).
