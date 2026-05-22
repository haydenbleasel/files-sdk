# AGENTS.md — `files-sdk/sharepoint`

Guidance for coding agents working on the `sharepoint` adapter. The
unified `Adapter<Raw>` contract — call shapes, `FilesError`,
`UrlOptions`, `SignUploadOptions`, body normalization — lives in
[`../index.ts`](../index.ts); this file documents only the
sharepoint-specific deviations. Read [`../../README.md`](../../README.md)
and [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md)
first for the unified surface.

`sharepoint()` is a **native** Microsoft Graph adapter in the sense that
it owns site / library / drive resolution against Graph, then delegates
every file operation to [`onedrive()`](../onedrive/index.ts) once a
`driveId` is known. It is not an S3 shim and not a second Graph
implementation — behavior changes in `onedrive` cascade here, and error
messages from the inner layer are relabeled from `"OneDrive error"` to
`"SharePoint error"`.

## Overview

SharePoint document libraries via Microsoft Graph. Virtual keys map to
real folder paths inside a document library (same path-addressable model
as OneDrive: `/drives/{driveId}/root:/folder/file.txt`). The adapter's
job is SharePoint-shaped targeting: turn `siteUrl`, `hostname` /
`sitePath`, `siteId`, and optional `documentLibrary` into a concrete
`driveId`, then hand off to `onedrive({ client, driveId, … })`.

Resolution is **lazy** (auth only at construction; first method triggers
1–2 Graph calls), **memoized** on success, and **not** cached on failure.

Optional peer dependencies (declared in
[`../../package.json`](../../package.json)):
`@microsoft/microsoft-graph-client`, `@azure/identity`.

## Directory layout

```text
packages/files-sdk/src/sharepoint/
├── index.ts                # adapter implementation
├── AGENTS.md               # this file
└── CLAUDE.md               # `@AGENTS.md`
```

Siblings outside this directory: tests at
[`../../test/sharepoint.test.ts`](../../test/sharepoint.test.ts);
user docs at
[`../../../../apps/web/content/docs/adapters/sharepoint.mdx`](../../../../apps/web/content/docs/adapters/sharepoint.mdx);
catalog entry at [`../providers/index.ts`](../providers/index.ts)
(search `slug: "sharepoint"`).

## Build, test, typecheck

Run from `packages/files-sdk/`:

```bash
bun test test/sharepoint.test.ts   # resolution + delegation unit tests
bun test test/onedrive.test.ts     # inner operation map (when touching delegation)
bun test                           # full SDK suite
bun run build                      # tsup → dist/sharepoint/
bun run types                      # tsgo --noEmit (typecheck only)
```

Pinned tooling: **`bun test`** (not vitest) and **`tsgo`** (not `tsc`).
The `sharepoint` subpath is enumerated in
[`../../package.json`](../../package.json)'s `exports` map — keep it in
sync with the file layout.

## Public surface

Exports from [`./index.ts`](./index.ts):

- `sharepoint(opts?: SharePointAdapterOptions): SharePointAdapter` —
  primary factory; auth is required (throws at construction if none
  resolves), but site / library selection can be deferred to env vars
  and still fails on first call if missing.
- `SharePointAdapter` — alias for
  `Adapter<Client> & { readonly rootFolderPath }`; no `basePath` on the
  outer adapter (that lives on the inner `onedrive` instance after
  resolution).
- `SharePointAdapterOptions` — config interface; JSDoc on every field is
  the source of truth (the docs MDX pulls it via `AutoTypeTable`).

The adapter's `name` is `"sharepoint"`. `raw` is the **resolver**
`Client` (the same instance passed into `onedrive({ client, driveId })`),
not a separate client per layer.

## Authentication / configuration

Auth reuses [`buildAuthProvider`](../onedrive/index.ts) from the
onedrive module. Four explicit shapes plus env fallback, evaluated in
**priority order** (first match wins):

1. **`client: Client`** — pre-built Graph client; escape hatch for MSAL,
   NextAuth, or a broker you already wired.
2. **`clientCredentials: { tenantId, clientId, clientSecret }`** —
   app-only via `@azure/identity`'s `ClientSecretCredential`. Typical for
   unattended SharePoint access. Scoped to
   `https://graph.microsoft.com/.default`.
3. **`oauth: { clientId, clientSecret, refreshToken, tenantId? }`** —
   delegated refresh-token flow (same hand-rolled credential as
   `onedrive()`).
4. **`accessToken: string | (() => string | Promise<string>)`** — static
   or dynamic bearer; the adapter does not cache callables.

**Env fallback:** `SHAREPOINT_ACCESS_TOKEN` → `ONEDRIVE_ACCESS_TOKEN`;
credential triple prefers `SHAREPOINT_*` per field then `ONEDRIVE_*`.
Missing auth throws at construction (`sharepoint: missing auth. …`).

Other knobs forwarded to the inner `onedrive()` after resolution:

- `rootFolderPath` — logical bucket root inside the library; must
  already exist. Trimmed on the outer `rootFolderPath` getter (leading /
  trailing slashes) even before resolution completes.
- `publicByDefault` — gates `url()` and optional post-upload sharing
  links (see [URL behavior](#url-behavior)).
- `copyTimeoutMs` — async copy poll timeout on the inner adapter
  (default `60_000` ms in `onedrive`).

Env lookups use [`readEnv`](../internal/env.ts) for Workers-safe imports.

## Site and drive resolution

Pass **at most one** site selector. `driveId` bypasses site resolution
entirely.

### Site selection (required unless `driveId` is set)

| Option | Env fallback | Graph call |
| ------ | ------------ | ---------- |
| `siteId` | `SHAREPOINT_SITE_ID` | Use as-is (Graph triple form `<host>,<guid>,<guid>`) |
| `siteUrl` | `SHAREPOINT_SITE_URL` | Parse URL → `hostname` + `sitePath`, then lookup |
| `hostname` + optional `sitePath` | `SHAREPOINT_HOSTNAME` | Lookup by host and path |

**`siteUrl`** must parse as a URL or throws `Provider`. Lookup:
`GET /sites/{hostname}:/{sitePath}` when path present, else
`GET /sites/{hostname}`. Example:
`https://contoso.sharepoint.com/sites/marketing` →
`/sites/contoso.sharepoint.com:/sites/marketing`. Missing `id` or site
selector throws `Provider` on first call.

### Drive selection (after site, unless `driveId` is set)

| Option | Env fallback | Graph call |
| ------ | ------------ | ---------- |
| `driveId` | `SHAREPOINT_DRIVE_ID` | Skip site + library resolution |
| `documentLibrary` | `SHAREPOINT_DOCUMENT_LIBRARY` | `GET /sites/{siteId}/drives`, match `name` |
| (omit library) | — | `GET /sites/{siteId}/drive` (default library) |

Missing library names throw `Provider` with available drive names.
Resolution and delegation share one `resolverClient` passed to
`onedrive({ client, driveId, … })`.

## Operation map

After resolution, every method delegates to the inner `OneDriveAdapter`
via a `call()` wrapper that relabels `FilesError` messages containing
`"OneDrive error"` → `"SharePoint error"`. Non-`FilesError` failures and
messages without that substring pass through unchanged.

Inherited from [`onedrive`](../onedrive/index.ts) (see
[`../onedrive/AGENTS.md`](../onedrive/AGENTS.md) for primitives):

- `upload` — simple `PUT …/content` up to **250 MiB**
  (`SIMPLE_UPLOAD_LIMIT_BYTES`); `metadata` and `cacheControl` throw.
- `download` / `head` / `exists` / `delete` / `copy` / `list` — same
  Graph paths and semantics as OneDrive on the resolved drive.
- `delete` — soft delete (recycle bin), not permanent purge.
- `copy` — async Graph copy with monitor-URL polling until
  `copyTimeoutMs`.
- `list` — non-recursive children listing; `prefix` filtered
  client-side per page.

SharePoint adds **no** extra operations — only resolution + relabel.

## Upload sessions

`signedUploadUrl()` → inner `POST …/createUploadSession`, returns
`{ method: "PUT", url }` (Graph's pre-authenticated session URL for
chunked `Content-Range` uploads, not an S3 presign). Use above 250 MiB
or drop to `raw`.

## URL behavior

Sharing links are Graph `createLink` calls on the inner adapter — not
signed GET URLs.

- **`publicByDefault: false` (default)** — `url()` throws `Provider`
  (inner message mentions `url()`; relabeled to SharePoint wording when
  applicable). Use `download()` for private library items.
- **`publicByDefault: true`** — `url()` and post-upload linking use
  `POST {item}/createLink` with `{ scope: "anonymous", type: "view" }`,
  returning `link.webUrl`. Subject to tenant / site link-sharing policy;
  blocked anonymous sharing surfaces as `Unauthorized` via
  `mapGraphError`.
- **`expiresIn` is ignored** on share links (tenant default expiry).
- **`responseContentDisposition` always throws** on the inner layer —
  Graph has no Content-Disposition override on share links.

## Provider quirks worth remembering

- **Late site/library failures** — only auth is eager; bad `siteUrl` or
  missing library throws on first call.
- **`raw` before first call** — resolution has not run; use adapter
  methods or known `driveId`.
- **`siteId` here ≠ `onedrive({ siteId })`** — SharePoint resolves a
  site then a library; OneDrive's option jumps to `/sites/{id}/drive`.
- **`driveId` skips `/sites/`** — pass when you already have the
  library drive ID.
- **Library names** — exact match on `drive.name` from `/drives`.
- **Delegated limits** — see
  [`sharepoint.mdx`](../../../../apps/web/content/docs/adapters/sharepoint.mdx)
  Limitations (250 MiB upload, soft delete, async copy, etc.).
- **Relabel** — only `FilesError` messages containing `"OneDrive error"`.

## Testing approach

[`../../test/sharepoint.test.ts`](../../test/sharepoint.test.ts) fakes
Graph via patched `Client.initWithMiddleware`. Covers resolution paths,
env fallbacks, memoization / retry, delegation of all operations,
`publicByDefault` / `copyTimeoutMs`, and error relabel. Add resolution
fixtures here; onedrive tests own the auth matrix and operation map.

## Coding conventions

- Named exports only — `sharepoint`, `SharePointAdapter`,
  `SharePointAdapterOptions`. No default exports.
- Prefix construction and resolution errors with `sharepoint:` via
  [`FilesError("Provider", …)`](../internal/errors.ts).
- Use [`readEnv`](../internal/env.ts) for env vars — never `process.env`
  directly.
- Keep resolution helpers (`resolveSiteId`, `resolveDriveId`,
  `parseSiteUrl`, `relabelError`) private; auth construction stays in
  `buildOneDriveAuthOptions` mirroring onedrive priority.
- When extending options, forward new onedrive knobs through the
  `onedrive({ … })` call inside `resolve()` and document env aliases in
  [`../providers/index.ts`](../providers/index.ts) if added.
- Top-level regex literals only (`parseSiteUrl` uses none; `rootFolderPath`
  getter uses `/^\/+|(?<!\/)\/+$/gu`).

## Releases

The repo uses Changesets. Behavioral changes need a changeset
(`bunx changeset`, committed under `.changeset/`); new options, resolution
logic, auth fallbacks, and error-shape changes bump `files-sdk`.
README / AGENTS.md edits don't. Changes to
[`../onedrive/index.ts`](../onedrive/index.ts) that affect delegated
behavior should be called out in sharepoint release notes when user-visible.

## Where to look next

- Source [`./index.ts`](./index.ts); tests
  [`../../test/sharepoint.test.ts`](../../test/sharepoint.test.ts); docs
  [`../../../../apps/web/content/docs/adapters/sharepoint.mdx`](../../../../apps/web/content/docs/adapters/sharepoint.mdx).
- Inner adapter [`../onedrive/index.ts`](../onedrive/index.ts) +
  [`../onedrive/AGENTS.md`](../onedrive/AGENTS.md).
- Provider catalog (`slug: "sharepoint"`):
  [`../providers/index.ts`](../providers/index.ts).
- Unified contract [`../index.ts`](../index.ts); shared helpers
  [`../internal/core.ts`](../internal/core.ts),
  [`../internal/errors.ts`](../internal/errors.ts),
  [`../internal/env.ts`](../internal/env.ts); package
  [`../../README.md`](../../README.md); SKILL
  [`../../../../skills/files-sdk/SKILL.md`](../../../../skills/files-sdk/SKILL.md).
