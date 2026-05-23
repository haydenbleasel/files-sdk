---
name: files-sdk
description: Use files-sdk to add file storage to a TypeScript/JavaScript app with a unified API across S3, R2, GCS, Azure, Vercel Blob, the local filesystem, and ~40 other providers. Triggers when the user wants to upload/download/list/delete files, generate presigned URLs, swap storage providers, expose storage to an AI agent (Vercel AI SDK, OpenAI Responses/Agents, Claude Agent SDK), or asks about "files-sdk", "Files SDK", `new Files(...)`, `files.upload`, `files.url`, `files.signedUploadUrl`, or any `files-sdk/<adapter>` subpath import.
---

# files-sdk

A unified storage SDK for object and blob backends. One small API. Web-standard I/O. Escape hatch to the native client when needed.

When the user asks for help integrating it, follow this skill. It is the source of truth — prefer it over training-data memory of the package.

> **Bundled docs:** When `files-sdk` is installed, the full documentation ships inside the package at `node_modules/files-sdk/docs`. Read those MDX files for the complete, version-matched reference: per-adapter setup under `docs/adapters/`, AI tools under `docs/ai/`, plus `overview`, `api`, `cli`, `providers`, and `troubleshooting`. Prefer them over <https://files-sdk.dev> when the package is present locally — they match the installed version exactly.

## Mental model

- One core class `Files`, configured once with an adapter at construction time. Adapter is fixed for the life of the instance.
- ~40 adapters, each a separate subpath export so only what you import is bundled (`files-sdk/s3`, `files-sdk/r2`, `files-sdk/gcs`, `files-sdk/azure`, `files-sdk/vercel-blob`, `files-sdk/fs`, …).
- The unified API is the **common subset** of what every adapter can do. Provider-specific features (S3 versioning, R2 multipart, Vercel Blob cache options, etc.) live behind `files.raw`, which returns the underlying native client.
- Bodies are web-standard: `Blob`, `File`, `ReadableStream<Uint8Array>`, `Uint8Array`, `ArrayBuffer`, `ArrayBufferView`, or `string`. No provider types leak.

## Install

```sh
npm install files-sdk
```

## Quick start

```ts
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";

const files = new Files({
  adapter: s3({ bucket: "uploads" }),
});

await files.upload("avatars/abc.png", file, { contentType: "image/png" });
const got = await files.download("avatars/abc.png");
const exists = await files.exists("avatars/abc.png");
```

Swap the adapter import and the rest of the code stays the same.

## Core API

All methods live on the `Files` instance and are also available on a key-scoped `FileHandle` from `files.file(key)`.

| Method                       | Returns              | Notes                                                                                                        |
| ---------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `upload(key, body, opts?)`   | `UploadResult`       | `opts`: `contentType`, `cacheControl`, `metadata`.                                                           |
| `download(key, opts?)`       | `StoredFile`         | `opts.as` is `"blob"` or `"stream"`.                                                                         |
| `head(key)`                  | `StoredFile`         | Metadata only. The returned object still has `text()`/`blob()`/`arrayBuffer()`/`stream()` but they lazy-GET. |
| `exists(key)`                | `boolean`            | `false` only on `NotFound`. Auth/transport errors still throw — do not treat as "missing".                   |
| `delete(key)`                | `void`               |                                                                                                              |
| `copy(from, to)`             | `void`               |                                                                                                              |
| `list(opts?)`                | `{ items, cursor? }` | `opts`: `prefix`, `cursor`, `limit`.                                                                         |
| `url(key, opts?)`            | `string`             | See [URL behavior](#url-behavior) — varies by adapter.                                                       |
| `signedUploadUrl(key, opts)` | `SignedUpload`       | See [Signed upload URLs](#signed-upload-urls) — pass `maxSize`.                                              |
| `file(key)`                  | `FileHandle`         | Same methods, key pre-bound. Also has `copyTo(dest)` and `copyFrom(src)`.                                    |

### `StoredFile` shape

`name`, `key`, `size`, `type`, `lastModified?`, `etag?`, `metadata?`, plus `arrayBuffer()`, `text()`, `blob()`, `stream()`.

### File handles

For repeated work on the same key:

```ts
const avatar = files.file("avatars/abc.png");

await avatar.upload(file, { contentType: "image/png" });
if (await avatar.exists()) {
  const meta = await avatar.head();
  const url = await avatar.url({ expiresIn: 300 });
}
await avatar.delete();
```

## URL behavior

`url(key, opts?)` returns the most direct URL the adapter can produce. Behavior is not uniform:

- **Signing adapters** (S3, R2 HTTP, MinIO, DigitalOcean Spaces, Storj, Hetzner, Akamai, Backblaze B2, Wasabi, Tigris): presigned `GetObject` URL expiring after `opts.expiresIn` seconds (default ~3600). If the adapter was constructed with `publicBaseUrl`, the URL is built against that origin instead and does not expire.
- **R2 binding**: uses `publicBaseUrl` if set; falls back to HTTP signing if HTTP credentials were also passed (hybrid); otherwise throws.
- **Vercel Blob (public)**: permanent CDN URL. `expiresIn` is ignored.
- **Vercel Blob (private)**: throws — no URL primitive. Use `download()`.

### Two `UrlOptions` worth knowing

- `expiresIn` — seconds. Honored by signing adapters; ignored by Vercel Blob public; N/A where `url()` throws.
- `responseContentDisposition` — **strongly recommend `"attachment"` (or `'attachment; filename="..."'`) for user-uploaded buckets.** Without it, a user-uploaded `.html` or scripted SVG executes inline at the bucket origin (stored XSS). Passing this option **forces the signing path** on signing adapters (even when `publicBaseUrl` is set) because a permanent CDN URL has no signature to bind the override to. Throws on Vercel Blob (no primitive) and R2 binding without HTTP creds.

### Key encoding

The SDK does **not** URL-encode keys when building public URLs (or Vercel Blob's fast path). The caller is responsible. If keys come from untrusted input, validate or `encodeURIComponent`-escape segments before passing.

## Signed upload URLs

`signedUploadUrl(key, opts)` where `opts: { expiresIn, contentType?, maxSize?, minSize? }`.

- **Always pass `maxSize`.** Without it, the adapter returns a presigned `PUT` URL with **no server-side size limit** — anyone holding the URL can upload an arbitrarily large file until `expiresIn` elapses. With `maxSize`, the adapter returns a presigned `POST` form (S3/R2) enforcing the size via a `content-length-range` policy.
- `minSize` defaults to `1` (rejects empty uploads, which are usually a broken client). Pass `0` to allow zero-byte uploads.
- Return shape is one of:
  - `{ method: "PUT", url, headers? }`
  - `{ method: "POST", url, fields }` — POST as `multipart/form-data` with `fields` and the file last.

## Errors

Every adapter error is wrapped in `FilesError` (re-exported from `files-sdk`). It has a `.code` of type `FilesErrorCode` and a `.cause` for the underlying provider error. Catch `FilesError` at the boundary; use `.code` to branch.

## Escape hatch

```ts
import type { s3 } from "files-sdk/s3";
const native = files.raw; // typed as the native client for the configured adapter
```

Use this for provider features that aren't in the unified API (versioning, lifecycle, multipart, etc.).

## Adapter catalog

S3-family and S3-compatible stores wrap the `s3()` adapter with provider-friendly defaults. Direct-binding adapters (R2 worker binding, fs, Vercel Blob, GCS, Azure, Dropbox, Google Drive, OneDrive, Box, SharePoint, Cloudinary, UploadThing, Supabase, Appwrite, Netlify Blobs, …) have their own implementation.

Always check the live list and per-adapter options at <https://files-sdk.dev> rather than guessing. The package's `exports` map in `packages/files-sdk/package.json` is also authoritative for what subpaths exist.

## AI tools

Three subpaths expose a configured `Files` instance as tools for AI agents. All share the same operations and approval-gating defaults.

| Subpath            | For                                                           | Factory           |
| ------------------ | ------------------------------------------------------------- | ----------------- |
| `files-sdk/ai-sdk` | Vercel AI SDK (`generateText`, `streamText`, `ToolLoopAgent`) | `createFileTools` |
| `files-sdk/openai` | OpenAI Responses API and Agents SDK                           | (see subpath)     |
| `files-sdk/claude` | Anthropic Claude Agent SDK                                    | (see subpath)     |

Vercel AI SDK example:

```ts
import { Files } from "files-sdk";
import { createFileTools } from "files-sdk/ai-sdk";
import { s3 } from "files-sdk/s3";
import { generateText } from "ai";

const files = new Files({ adapter: s3({ bucket: "uploads" }) });

await generateText({
  model,
  tools: createFileTools({ files }),
  prompt: "Find every CSV under reports/ and summarize the latest one.",
});
```

Key options on `createFileTools`:

- `readOnly: true` — strips write tools entirely (`uploadFile`, `deleteFile`, `copyFile`, `signUploadUrl`). The model cannot mutate the bucket.
- `requireApproval` — defaults to `true` (all writes require approval). Pass `false` to disable, or a per-tool record like `{ deleteFile: true, uploadFile: false }`.
- `overrides` — per-tool patches for `description`, `title`, `needsApproval`. Cannot override `execute`, `inputSchema`, or `outputSchema`.

## Decision guide

- **User asks "how do I add file uploads to my app?"** → Pick the adapter that matches their hosting/provider, show the `new Files({ adapter: x({...}) })` + `upload`/`url` pattern.
- **User wants to swap providers** → Change the subpath import and the adapter factory call. The rest of their code is unchanged.
- **User asks for presigned client-side uploads** → `signedUploadUrl` with `maxSize` (always). Walk them through the `PUT` vs `POST` return shape.
- **User asks how to get a public download URL** → `files.url(key)`. If they need a forced download, recommend `responseContentDisposition: "attachment"`. If their adapter throws on `url()` (Vercel Blob private, R2 binding w/o config), tell them to use `download()` or configure `publicBaseUrl`/HTTP creds.
- **User asks for a feature not in the unified API** → Reach for `files.raw` and the provider's native client.
- **User wants to give an LLM access to their bucket** → Use the matching AI-tools subpath. Default to leaving `requireApproval` on for writes; suggest `readOnly: true` if the agent only needs to read.

## References

Load the relevant reference file only when the user's task matches it — don't preload them all.

When the package is installed locally, `node_modules/files-sdk/docs` holds the full, version-matched documentation (see the note at the top) — reach for it for per-adapter detail the bundled references below don't cover.

- [references/client-uploads.md](references/client-uploads.md) — presigned-upload flow end-to-end: server route returning `signedUploadUrl` with `maxSize`, client handling for both PUT and POST shapes, the field-order gotcha on POST, and server-side confirmation.
- [references/ai-tools.md](references/ai-tools.md) — full examples for `files-sdk/ai-sdk`, `files-sdk/openai` (Responses + Agents), and `files-sdk/claude`. Covers `readOnly`, granular approval, per-tool overrides, and how to choose across the three.
- [references/adapter-setup.md](references/adapter-setup.md) — construction snippets and non-obvious knobs for the common adapters (`s3`, `r2` HTTP vs binding vs hybrid, `vercel-blob` public vs private, `gcs`, `azure`, `minio`, `fs`).
- [references/errors-and-recipes.md](references/errors-and-recipes.md) — `FilesError.code` values, the `exists()` and `head()` traps, key-encoding rules, and migration rewrites from `@aws-sdk/client-s3`, `@vercel/blob`, and `@google-cloud/storage`.

## Verification

Before answering with specifics:

- Confirm the adapter the user has chosen actually exists by checking `packages/files-sdk/package.json` exports or `packages/files-sdk/src/<adapter>/`.
- For non-obvious behavior (URL signing, `exists` semantics, `signedUploadUrl` POST vs PUT), re-read the JSDoc on the relevant method in `packages/files-sdk/src/index.ts` rather than trusting memory.
