# AGENTS.md — `files-sdk/onedrive`

Guidance for coding agents working on the `onedrive` adapter. The
unified `Adapter<Raw>` contract — call shapes, `FilesError`,
`UrlOptions`, `SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file documents only the
onedrive-specific deviations. Read [`../../README.md`](../../README.md)
and [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md)
first for the unified surface.

`onedrive` is a **native** adapter on `@microsoft/microsoft-graph-client`
plus `@azure/identity` — not a wrapper around `s3()`. The sibling
[`sharepoint`](../sharepoint/index.ts) adapter delegates here for its
file-operation layer after resolving site / library to a `driveId`;
behavior changes cascade there, so edit with care.

## Overview

OneDrive (personal and Business) and SharePoint document libraries via
Microsoft Graph. Graph is path-addressable
(`/drive/root:/folder/file.txt`), so the adapter maps virtual keys
straight onto real OneDrive paths — no virtual-key cache, no `fsdkKey`
bookkeeping, the path you upload is the path you see in the OneDrive
UI. The full unified surface (`upload`, `download`, `head`, `exists`,
`delete`, `copy`, `list`, `url`, `signedUploadUrl`) is implemented
natively against the Graph client.

Optional peer dependencies declared in
[`../../package.json`](../../package.json):
`@microsoft/microsoft-graph-client`, `@azure/identity`.

## Directory layout

```text
packages/files-sdk/src/onedrive/
├── index.ts                # adapter implementation
├── AGENTS.md               # this file
└── CLAUDE.md               # `@AGENTS.md`
```

Siblings outside this directory: tests at
[`../../test/onedrive.test.ts`](../../test/onedrive.test.ts) and
[`../../test/onedrive-auth.test.ts`](../../test/onedrive-auth.test.ts);
user docs at
[`../../../../apps/web/content/docs/adapters/onedrive.mdx`](../../../../apps/web/content/docs/adapters/onedrive.mdx);
catalog entry at [`../providers/index.ts`](../providers/index.ts)
(search `slug: "onedrive"`).

## Build, test, typecheck

Run from `packages/files-sdk/`:

```bash
bun test test/onedrive.test.ts        # operation-map unit tests
bun test test/onedrive-auth.test.ts   # auth construction + token paths
bun test                              # full SDK suite
bun run build                         # tsup → dist/onedrive/
bun run types                         # tsgo --noEmit (typecheck only)
```

Pinned tooling: **`bun test`** (not vitest) and **`tsgo`** (not `tsc`).
The `onedrive` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep it in
sync with the file layout.

## Public surface

Exports from [`./index.ts`](./index.ts):

- `onedrive(opts?: OneDriveAdapterOptions): OneDriveAdapter` — primary
  factory; all fields optional (env fallback covers no-args).
- `OneDriveAdapter` — alias for
  `Adapter<Client> & { readonly basePath; readonly rootFolderPath }`;
  the extras let callers introspect the resolved drive target.
- `OneDriveClient` — alias for the Graph `Client`; `raw` is typed as
  this.
- `OneDriveAdapterOptions` — config interface; JSDoc on every field is
  the source of truth (the docs MDX pulls it via `AutoTypeTable`).
- `mapGraphError(err): FilesError` — exported so callers dropping to
  `raw` can route Graph errors through the same classifier.
- `buildAuthProvider(opts)` — consumed by
  [`sharepoint`](../sharepoint/index.ts); not part of the documented
  public API.

The adapter's `name` is `"onedrive"`.

## Authentication / configuration

Four explicit auth shapes plus an env-var fallback, **mutually
exclusive** — the factory throws `FilesError("Provider", …)` if more
than one shape is set or none resolves.

1. **`clientCredentials: { tenantId, clientId, clientSecret }`** —
   app-only via `@azure/identity`'s `ClientSecretCredential`. The app
   acts on its own behalf, so `/me/drive` is unavailable: pass
   `driveId`, `siteId`, or `userId`. Scoped to
   `https://graph.microsoft.com/.default` via
   `TokenCredentialAuthenticationProvider`.
2. **`oauth: { clientId, clientSecret, refreshToken, tenantId? }`** —
   delegated (3-legged), analogous to the Dropbox refresh-token mode.
   `@azure/identity` ships no native refresh-token credential, so the
   adapter hand-rolls a private `RefreshTokenCredential` that POSTs
   `grant_type=refresh_token` to
   `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`
   (default `tenantId: "common"`) and caches the access token until
   60 s before expiry. Non-OK responses and 200s missing `access_token`
   throw `Unauthorized`.
3. **`accessToken: string | (() => string | Promise<string>)`** — static
   or dynamic bearer. The string form is returned verbatim; the
   callable runs on every Graph call. The adapter does **not** cache;
   your callable owns cache / refresh.
4. **`client: Client`** — pre-built Graph client. Escape hatch for
   callers wiring auth themselves (NextAuth, MSAL Node, an external
   broker). `signedUploadUrl()` still works because Graph's
   upload-session URL is pre-authenticated by Graph itself.

**Env-var fallback** — when no auth field is passed.
`ONEDRIVE_ACCESS_TOKEN` takes the static-token path;
`ONEDRIVE_TENANT_ID` + `ONEDRIVE_CLIENT_ID` + `ONEDRIVE_CLIENT_SECRET`
(all three) take the `clientCredentials` path. The catalog entry in
[`../providers/index.ts`](../providers/index.ts) enumerates these.

Drive targets (pass at most one):

- `driveId` → `/drives/{driveId}` (env `ONEDRIVE_DRIVE_ID`).
  **Required** for `clientCredentials`.
- `siteId` → `/sites/{siteId}/drive` (env `ONEDRIVE_SITE_ID`) — default
  document library of a SharePoint site.
- `userId` → `/users/{userId}/drive` (env `ONEDRIVE_USER_ID`) — typical
  with app-only auth.
- Unset → `/me/drive`. Interactive (delegated) auth only.

Other knobs: `rootFolderPath` (logical bucket root, must already exist),
`publicByDefault` (gates `url()`), `copyTimeoutMs` (default `60_000`).
Env lookups go through [`readEnv`](../internal/env.ts) so the adapter
imports cleanly on runtimes without `process` (Cloudflare Workers
without `nodejs_compat`).

## Operation map

Errors route through `mapGraphError`, which classifies by HTTP status
(404 → `NotFound`, 401/403 → `Unauthorized`, 409/412 → `Conflict`, else
→ `Provider`) and by Graph's named codes (`itemNotFound`,
`InvalidAuthenticationToken`, `accessDenied`, `unauthenticated`,
`nameAlreadyExists`, `resourceModified`). Messages prefer
`err.body.error.message`, then `err.message`, then a per-code default.

- `upload` — `PUT {basePath}/root:/{encodedKey}:/content` with the body
  as a `Buffer` and explicit `Content-Type`. Bodies above
  `SIMPLE_UPLOAD_LIMIT_BYTES = 250 MiB` throw `Provider`; use
  `signedUploadUrl()` or drop to `raw` for chunked sessions.
  `metadata` and `cacheControl` both throw — drive items carry no
  arbitrary-metadata field (use `raw` + Open Extensions) and no
  `Cache-Control` primitive. When `publicByDefault: true`, also calls
  `createLink` after the PUT.
- `download` — buffer path uses `responseType(ARRAYBUFFER)`; stream
  path uses `responseType(STREAM)` then `Readable.toWeb`. Both fire the
  metadata GET in parallel with `/content` so the `StoredFile` carries
  authoritative `size` / `type` / `etag` / `lastModified`.
- `head` — single item GET. Body accessors lazily issue `/content` on
  first call via a `lazyDownload` factory; not free.
- `exists` — `existsByProbe(client.api(item).get, mapGraphError)` from
  [`../internal/core.ts`](../internal/core.ts); `NotFound` → `false`,
  other failures propagate.
- `delete` — `DELETE {item}`; idempotent on mapped `NotFound`.
- `copy` — Graph's copy is async. POST to `{item}/copy` with
  `responseType(RAW)` to expose the raw `Response` (202 + `Location`
  monitor URL), then poll every `COPY_POLL_INTERVAL_MS = 500 ms` until
  `status === "completed"`, failing on `"failed"` and throwing
  `Provider` after `copyTimeoutMs`. A 2xx with no monitor URL is
  treated as success.
- `list` — `GET {container}/children`. Folders are filtered
  client-side; `prefix` is applied client-side per page (no server-side
  prefix primitive on `/children`). Cursor is the `@odata.nextLink`
  absolute URL — the Graph client accepts it as a path, so paging
  re-issues with `cursor` plumbed through.
- `url` — throws `Provider` unless `publicByDefault: true`. Graph has
  no signed-URL primitive for private items; the workaround is
  `POST {item}/createLink` with `{ scope: "anonymous", type: "view" }`,
  returning `link.webUrl`. `responseContentDisposition` always throws.
- `signedUploadUrl` — `POST {item}/createUploadSession` with
  `item: { "@microsoft.graph.conflictBehavior": "replace", name }`;
  returns `{ method: "PUT", url: uploadUrl }`. The session URL is
  pre-authenticated by Graph (no bearer needed); intended for chunked
  resumable uploads, surfaced as a one-shot PUT for symmetry.

## URL behavior

- **`publicByDefault: false` (default)** — `url()` throws `Provider`.
  Use `download()` for private items.
- **`publicByDefault: true`** — `url()` calls `createLink` with
  `scope: "anonymous"`, `type: "view"` and returns `link.webUrl`.
  `createLink` is idempotent for the same `scope` + `type` pair, so
  repeat calls return the existing link rather than duplicating.
- **`expiresIn` is silently ignored** — share links use the tenant's
  default link expiry; Graph exposes no per-link override.
- **`responseContentDisposition` always throws** — Graph has no
  Content-Disposition override on share links or
  `@microsoft.graph.downloadUrl`. The unified surface treats this as a
  security ask (avoiding a stored-XSS regression on user-uploaded
  HTML/SVG) and fails loudly. See
  [`resolveUrlStrategy`](../internal/core.ts) for the rationale applied
  on signing adapters.
- **Tenant policy** — anonymous sharing can be disabled at the
  tenant / site / library level; `createLink` then returns
  `accessDenied`, which the mapper surfaces as `Unauthorized`.

## Provider quirks worth remembering

- **Path encoding.** `itemApiPath` percent-encodes each segment of
  `rootFolderPath + key` with `encodeURIComponent` and joins with `/`.
  The literal `:` in `/root:/{path}:` is structural — Graph's separator
  switching from path-addressable to children/content suffix mode.
  Never let a user-supplied `:` reach it unescaped; route every new
  endpoint through `encodePathSegments`.
- **Simple-upload cap is 250 MiB, not Graph's old 4 MiB.** Graph raised
  the limit; `SIMPLE_UPLOAD_LIMIT_BYTES` reflects the current value.
  Anything above goes through `createUploadSession` (the resumable URL
  `signedUploadUrl` returns).
- **Copy blocks until it resolves.** Set a short `copyTimeoutMs` or
  drop to `raw` and own the monitor URL for fire-and-forget. Poll
  interval is fixed at 500 ms.
- **`@azure/identity` has no refresh-token credential.** The adapter
  hand-rolls `RefreshTokenCredential` rather than reusing
  `OnBehalfOfCredential` (different flow) or MSAL public-client flows
  (interactive). New delegated flows should implement `TokenCredential`,
  hand it to `TokenCredentialAuthenticationProvider`, and cache with a
  60 s buffer.
- **`/me/drive` requires interactive auth.** `resolveBasePath` enforces
  this at construction so the failure is a clear `Provider`-coded error
  instead of an opaque 401 at first call.
- **Throttling (429) and 5xx aren't retried here.** The Files SDK's
  `retries` option still handles `Provider`-coded errors. Graph's
  `Retry-After` is not honored explicitly; `Client.initWithMiddleware`
  picks up the default middleware retry handler when you keep the
  default stack.
- **`prefix` / `limit` on `list` are best-effort.** `prefix` filters
  the current page client-side; `limit` only applies on the first page
  via `.top(limit)` — `@odata.nextLink` URLs carry the original page
  size.
- **Drive-item ETags carry literal quotes.** `itemToStoredMeta` strips
  them via `replaceAll('"', "")` so callers see `abc`, not `"abc"`.
  Stay consistent on new ETag-returning paths.

## Testing approach

Two files, one per concern; `bun test` is the runner.

- [`../../test/onedrive.test.ts`](../../test/onedrive.test.ts) wires a
  fake Graph client (`{ api(path) → builder }` shim) through the
  `client` option and asserts path / body / headers each operation
  issues. Covers path encoding, the four basePath variants
  (`/me/drive`, `/drives/{id}`, `/sites/{id}/drive`, `/users/{id}/drive`),
  `rootFolderPath`, the upload-size cap, the copy monitor-URL poll
  (mocking `globalThis.fetch`), the `publicByDefault` `createLink`
  path, and every `mapGraphError` branch — including
  `GraphError.body.error.message` extraction and the plain-object
  `statusCode` / `status` / `code` fallbacks.
- [`../../test/onedrive-auth.test.ts`](../../test/onedrive-auth.test.ts)
  monkey-patches `Client.initWithMiddleware` and
  `ClientSecretCredential.prototype.getToken` to capture the
  `AuthenticationProvider` the adapter builds, then exercises every
  auth shape: static + callable `accessToken`, `clientCredentials`
  wiring, the OAuth refresh-token POST (URL, body, scope, default
  tenant, caching, near-expiry re-fetch, non-OK, missing
  `access_token`), and the env-var fallbacks — including the
  "still need a target" failure when only the credentials triple is
  set.

Add operation fixtures to `onedrive.test.ts`; auth-shape ones to
`onedrive-auth.test.ts`. No vitest config; no network-calling
integration tests in this package.

## Coding conventions

- Named exports only — `onedrive`, `OneDriveAdapter`,
  `OneDriveAdapterOptions`, `OneDriveClient`, `mapGraphError`,
  `buildAuthProvider`. No default exports.
- Construction-time and unsupported-option errors use
  [`FilesError("Provider", …)`](../internal/errors.ts) with an
  `onedrive:` message prefix. Operation errors flow through
  `mapGraphError` — pass `FilesError` instances through unchanged
  (the mapper short-circuits on them).
- Use [`createStoredFile`](../internal/stored-file.ts) for every
  `StoredFile` returned — don't hand-roll body accessors. The
  `factory` / `kind: "lazy"` path is the contract `head()`'s
  body-on-demand depends on.
- Read env vars via [`readEnv`](../internal/env.ts). Direct
  `process.env` breaks Cloudflare Workers without `nodejs_compat`.
- Top-level regex literals only; the current file has none.
- `encodePathSegments` is the only path-building helper — route new
  endpoints through it so the `:` / `/` separator rules stay
  consistent. Keep `RefreshTokenCredential` private.

## Releases

The repo uses Changesets. Behavioral changes need a changeset
(`bunx changeset`, committed under `.changeset/`); new options, default
changes, auth-flow changes, and error-shape changes bump `files-sdk`.
README / AGENTS.md edits don't. Public-type changes in
`OneDriveAdapterOptions` or `OneDriveAdapter` should also flag the
dependent [`sharepoint`](../sharepoint/index.ts) adapter — it consumes
this surface for its file-operation layer.

## Where to look next

- Source [`./index.ts`](./index.ts); tests
  [`../../test/onedrive.test.ts`](../../test/onedrive.test.ts) +
  [`../../test/onedrive-auth.test.ts`](../../test/onedrive-auth.test.ts);
  docs [`../../../../apps/web/content/docs/adapters/onedrive.mdx`](../../../../apps/web/content/docs/adapters/onedrive.mdx).
- Provider catalog (`slug: "onedrive"`):
  [`../providers/index.ts`](../providers/index.ts); sibling
  [`../sharepoint/index.ts`](../sharepoint/index.ts).
- Unified contract [`../index.ts`](../index.ts); shared helpers
  [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts),
  [`../internal/stored-file.ts`](../internal/stored-file.ts); package
  [`../../README.md`](../../README.md); SKILL
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
