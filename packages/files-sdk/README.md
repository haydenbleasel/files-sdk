# Files SDK

A unified storage SDK for object and blob backends. One small, honest API. Web-standards I/O. An escape hatch when you need the native client.

[![npm downloads](https://img.shields.io/npm/dm/files-sdk.svg)](https://www.npmjs.com/package/files-sdk) [![Socket Badge](https://socket.dev/api/badge/npm/package/files-sdk)](https://socket.dev/npm/package/files-sdk) ![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/haydenbleasel/files-sdk?utm_source=oss&utm_medium=github&utm_campaign=haydenbleasel%2Ffiles-sdk&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)

## Install

```sh
npm install files-sdk
```

Each provider's native SDK is an **optional peer dependency** — install only the ones you actually use, alongside `files-sdk` itself. A few examples:

```sh
# S3 (and any S3-compatible: R2, MinIO, DigitalOcean Spaces, Backblaze B2, Wasabi, …)
npm install files-sdk @aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner

# Google Cloud Storage
npm install files-sdk @google-cloud/storage google-auth-library

# Azure Blob Storage
npm install files-sdk @azure/storage-blob @azure/core-auth @azure/identity

# Vercel Blob
npm install files-sdk @vercel/blob
```

See [files-sdk.dev](https://files-sdk.dev) for the per-adapter install command. If you import an adapter without its peer installed, Node will throw `ERR_MODULE_NOT_FOUND` naming the missing package.

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

Swap the adapter import (`files-sdk/r2`, `files-sdk/gcs`, `files-sdk/azure`, …) and the rest of your code stays the same.

## File handles

Use `files.file(key)` when your application code works with the same object repeatedly:

```ts
const avatar = files.file("avatars/abc.png");

await avatar.upload(file, { contentType: "image/png" });

if (await avatar.exists()) {
  const meta = await avatar.head();
  const url = await avatar.url({ expiresIn: 300 });
}

await avatar.delete();
```

File handles are a thin layer over the same adapter methods, so adapters do not need to implement anything extra.

## What you get

- **One API across providers** — `upload`, `download`, `head`, `exists`, `delete`, `copy`, `move`, `list`/`listAll`, `url`, `signedUploadUrl`, plus `file(key)` for a key-scoped handle. The shape is the same on S3, GCS, Azure, Vercel Blob, the local filesystem, and consumer providers like Dropbox. `exists` returns `false` only when the provider reports `NotFound`; auth, permission, and transport failures still throw.
- **Web-standard I/O** — bodies are `Blob`, `File`, `ReadableStream`, `Uint8Array`, `ArrayBuffer`, or `string`. No provider-specific types leak into your code.
- **Escape hatch** — every adapter exposes its native client at `files.raw`, so provider-specific features are one property access away.
- **Tree-shakeable** — each adapter is a separate entry point. You only bundle what you import.

## Adapters

A growing catalog covering S3 and S3-compatible stores, the major cloud blob platforms, edge/serverless blob services, the local filesystem, and consumer file providers. See [files-sdk.dev](https://files-sdk.dev) for the current list and per-adapter setup.

## AI tools

A growing set of subpaths wrap a configured `Files` instance as ready-made tools for popular AI SDKs — currently the [Vercel AI SDK](https://ai-sdk.dev) (`files-sdk/ai-sdk`), OpenAI's [Responses API](https://platform.openai.com/docs/api-reference/responses) and [Agents SDK](https://openai.github.io/openai-agents-js/) (`files-sdk/openai`), and Anthropic's [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) (`files-sdk/claude`). All share the same file operations and approval-gating defaults, so models can browse, read, and (optionally) mutate your bucket through the same unified surface as your application code. See [files-sdk.dev](https://files-sdk.dev) for the current list and per-SDK setup.

## Live tests

Most tests mock the provider. A few `*.live.test.ts` suites exercise a real backend instead. They are **skipped by default** and only run with `LIVE_TESTS=1`; suites that need credentials also skip when those env vars are absent, so the default `bun test` stays fast, offline, and credential-free.

```sh
# fs needs no credentials — runs against a real temp dir.
LIVE_TESTS=1 bun test fs.live

# s3 needs a bucket + region + credentials.
LIVE_TESTS=1 S3_LIVE_BUCKET=my-bucket AWS_REGION=us-east-1 \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... bun test s3.live
```

Live tests never run on `pull_request` from forks. In CI they run only when a maintainer triggers the `Live tests` workflow manually (`workflow_dispatch`) — typically against `main` after a PR has merged — with credentials from repo secrets.

## License

MIT
