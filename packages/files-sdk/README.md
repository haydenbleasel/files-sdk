# Files SDK

A unified storage SDK for object and blob backends. One small, honest API. Web-standards I/O. An escape hatch when you need the native client.

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
```

Swap the adapter import (`files-sdk/r2`, `files-sdk/gcs`, `files-sdk/azure`, …) and the rest of your code stays the same.

## What you get

- **One API across providers** — `upload`, `download`, `head`, `delete`, `copy`, `list`, `url`, `signedUploadUrl`. The shape is the same on S3, GCS, Azure, Vercel Blob, the local filesystem, and consumer providers like Dropbox.
- **Web-standard I/O** — bodies are `Blob`, `File`, `ReadableStream`, `Uint8Array`, `ArrayBuffer`, or `string`. No provider-specific types leak into your code.
- **Escape hatch** — every adapter exposes its native client at `files.raw`, so provider-specific features are one property access away.
- **Tree-shakeable** — each adapter is a separate entry point. You only bundle what you import.

## Adapters

A growing catalog covering S3 and S3-compatible stores, the major cloud blob platforms, edge/serverless blob services, the local filesystem, and consumer file providers. See [files-sdk.dev](https://files-sdk.dev) for the current list and per-adapter setup.

## AI SDK tools

The `files-sdk/ai` subpath wraps a configured `Files` instance as a set of [Vercel AI SDK](https://ai-sdk.dev) tools — drop them into `generateText`, `streamText`, or any agent and the model can browse, read, and (optionally) mutate your bucket through the same unified surface as your application code.

```ts
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { createFileTools } from "files-sdk/ai";
import { generateText } from "ai";

const files = new Files({ adapter: s3({ bucket: "uploads" }) });

await generateText({
  model: yourModel,
  tools: createFileTools({ files }),
  prompt: "Find every CSV under reports/ and summarize the latest one.",
});
```

Eight tools are returned by default — `listFiles`, `getFileMetadata`, `downloadFile`, `getFileUrl` (read) and `uploadFile`, `deleteFile`, `copyFile`, `signUploadUrl` (write). Write tools require user approval by default; pass `requireApproval: false` to disable globally, an object keyed by tool name for fine-grained control, or `readOnly: true` to strip writes entirely. `ai` and `zod` are optional peer dependencies — install them only when consuming this subpath.

For full details — installation, approval control, read-only mode, the per-tool input/output shapes, overrides, and cherry-picking individual factories — see [`packages/files-sdk/src/ai/README.md`](packages/files-sdk/src/ai/README.md) or the [AI SDK tools section](https://files-sdk.dev/#ai-tools) of the docs site.

## License

MIT
