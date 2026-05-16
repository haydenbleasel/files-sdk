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
const exists = await files.exists("avatars/abc.png");
```

Swap the adapter import (`files-sdk/r2`, `files-sdk/gcs`, `files-sdk/azure`, …) and the rest of your code stays the same.

## Timeouts, aborts, and retries

Configure defaults on the `Files` instance, then override per operation when
needed:

```ts
const files = new Files({
  adapter: s3({ bucket: "uploads" }),
  timeout: 10_000,
  retries: {
    max: 3,
    backoff: ({ attempt }) => attempt * 500,
  },
});

await files.head("avatars/abc.png", { timeout: 2_000 });

const controller = new AbortController();
await files.upload("avatars/abc.png", file, {
  signal: controller.signal,
  retries: 0,
});
```

You can also pass a number for `retries`, e.g. `retries: 3`. Retries apply to
provider-level failures; `NotFound`, `Unauthorized`, `Conflict`, and explicit
abort signals are not retried. Upload retries are disabled for `ReadableStream`
bodies because a consumed stream cannot be safely replayed.

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

- **One API across providers** — `upload`, `download`, `head`, `exists`, `delete`, `copy`, `list`, `url`, `signedUploadUrl`, plus `file(key)` for a key-scoped handle. The shape is the same on S3, GCS, Azure, Vercel Blob, the local filesystem, and consumer providers like Dropbox. `exists` returns `false` only when the provider reports `NotFound`; auth, permission, and transport failures still throw.
- **Web-standard I/O** — bodies are `Blob`, `File`, `ReadableStream`, `Uint8Array`, `ArrayBuffer`, or `string`. No provider-specific types leak into your code.
- **Escape hatch** — every adapter exposes its native client at `files.raw`, so provider-specific features are one property access away.
- **Tree-shakeable** — each adapter is a separate entry point. You only bundle what you import.

## Adapters

A growing catalog covering S3 and S3-compatible stores, the major cloud blob platforms, edge/serverless blob services, the local filesystem, and consumer file providers. See [files-sdk.dev](https://files-sdk.dev) for the current list and per-adapter setup.

## AI tools

A growing set of subpaths wrap a configured `Files` instance as ready-made tools for popular AI SDKs — currently the [Vercel AI SDK](https://ai-sdk.dev) (`files-sdk/ai-sdk`), OpenAI's [Responses API](https://platform.openai.com/docs/api-reference/responses) and [Agents SDK](https://openai.github.io/openai-agents-js/) (`files-sdk/openai`), and Anthropic's [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) (`files-sdk/claude`). All share the same file operations and approval-gating defaults, so models can browse, read, and (optionally) mutate your bucket through the same unified surface as your application code. See [files-sdk.dev](https://files-sdk.dev) for the current list and per-SDK setup.

## License

MIT
