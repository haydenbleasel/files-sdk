# files-sdk/ai-sdk

[Vercel AI SDK](https://ai-sdk.dev) tools for [`files-sdk`](https://github.com/haydenbleasel/files-sdk). Wraps a configured `Files` instance as a set of AI SDK tools so an LLM can browse, read, and (optionally) mutate your bucket through the same unified surface as your application code.

```ts
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { createFileTools } from "files-sdk/ai-sdk";
import { generateText } from "ai";

const files = new Files({
  adapter: s3({ bucket: "uploads", region: "us-east-1" }),
});

const result = await generateText({
  model: yourModel,
  tools: createFileTools({ files }),
  prompt: "Find every CSV under reports/ and summarize the latest one.",
});
```

Write tools require user approval by default — designed for human-in-the-loop agents. Read tools never require approval.

## Installation

`ai` and `zod` are optional peer dependencies. They are only needed when you consume this subpath.

```sh
bun add ai zod
# or
npm install ai zod
# or
pnpm add ai zod
```

## API

### `createFileTools(options)`

Returns a record of AI SDK tools keyed by tool name, ready to spread into the `tools` field of `generateText`, `streamText`, or any agent.

```ts
type FileToolsOptions = {
  /**
   * The configured `Files` instance the tools will operate against.
   * Each tool delegates to methods on this instance, inheriting the
   * SDK's key validation and `FilesError` wrapping.
   */
  files: Files;

  /**
   * When `true`, write tools (`uploadFile`, `deleteFile`, `copyFile`,
   * `signUploadUrl`) are omitted entirely. The model cannot mutate
   * the bucket regardless of approval configuration.
   */
  readOnly?: boolean;

  /**
   * Approval gating for write tools. Defaults to `true` (every write
   * requires approval). Pass `false` to disable, or an object keyed
   * by write-tool name for fine-grained control. Unspecified entries
   * in the object form default to `true`.
   */
  requireApproval?: boolean | Partial<Record<FileWriteToolName, boolean>>;

  /**
   * Per-tool overrides for `tool()` fields. `execute`, `inputSchema`,
   * and `outputSchema` cannot be overridden.
   */
  overrides?: Partial<Record<string, ToolOverrides>>;
};

type FileWriteToolName =
  | "uploadFile"
  | "deleteFile"
  | "copyFile"
  | "signUploadUrl";
```

### Approval control

Write operations are approval-gated by default — your agent runtime decides how to surface the prompt. Override globally or per-tool:

```ts
// All writes require approval (default).
createFileTools({ files });

// Drop the approval gate entirely.
createFileTools({ files, requireApproval: false });

// Granular: only the destructive operations need approval.
createFileTools({
  files,
  requireApproval: {
    deleteFile: true,
    signUploadUrl: true,
    uploadFile: false,
    copyFile: false,
  },
});
```

### Read-only mode

`readOnly: true` strips every write tool. Useful for retrieval-style agents that browse and summarize but never mutate the bucket:

```ts
createFileTools({ files, readOnly: true });
// → { listFiles, getFileMetadata, downloadFile, getFileUrl }
```

### Overrides

Patch any safe `tool()` field on a per-tool basis without touching the underlying implementation:

```ts
createFileTools({
  files,
  overrides: {
    listFiles: {
      description: "List files in the current tenant's bucket",
    },
    deleteFile: { needsApproval: false, title: "Remove file" },
  },
});
```

Supported override fields: `description`, `title`, `needsApproval`, `strict`, `providerOptions`, `onInputStart`, `onInputDelta`, `onInputAvailable`, `toModelOutput`. Core properties (`execute`, `inputSchema`, `outputSchema`) are intentionally not overridable — the contract that drives tool behavior should not be patched at this layer.

### Cherry-picking tools

Each tool factory is also exported individually for fully custom setups — useful when mixing AI SDK tools across multiple domains and you need full control over the returned shape:

```ts
import { Files } from "files-sdk";
import { listFiles, downloadFile, uploadFile } from "files-sdk/ai-sdk";

const files = new Files({ adapter });

const tools = {
  listFiles: listFiles(files),
  downloadFile: downloadFile(files),
  uploadFile: uploadFile(files),
};
```

Each factory accepts the `Files` instance and (for write tools) a `{ needsApproval }` option:

```ts
const guarded = uploadFile(files, { needsApproval: true });
const ungated = uploadFile(files, { needsApproval: false });
```

## Tool surface

Eight tools are returned by default — four read, four write. Each one is a thin wrapper around a `Files` method, so they share the SDK's key validation, normalized errors, and adapter portability.

### Read tools (no approval)

| Tool              | Wraps                     | Returns                                                         |
| ----------------- | ------------------------- | --------------------------------------------------------------- |
| `listFiles`       | `files.list(opts)`        | `{ items: [{ key, size, type, lastModified, etag }], cursor? }` |
| `getFileMetadata` | `files.head(key)`         | `{ key, size, type, lastModified, etag, metadata }`             |
| `downloadFile`    | `files.head` + `download` | `{ key, size, type, content, encoding }` (text or base64)       |
| `getFileUrl`      | `files.url(key, opts)`    | `{ key, url }`                                                  |

### Write tools (approval-gated)

| Tool            | Wraps                              | Returns                                                                 |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `uploadFile`    | `files.upload(key, body, opts)`    | `{ key, size, contentType, etag, lastModified }`                        |
| `deleteFile`    | `files.delete(key)`                | `{ deleted: true, key }`                                                |
| `copyFile`      | `files.copy(from, to)`             | `{ copied: true, from, to }`                                            |
| `signUploadUrl` | `files.signedUploadUrl(key, opts)` | `{ method: "PUT", url, headers? }` or `{ method: "POST", url, fields }` |

### Notable per-tool behavior

- **`downloadFile`** has a `maxBytes` guard (default 1 MiB) checked via `head()` _before_ any transfer. JSON tool boundaries don't love multi-MB payloads and surprise OOMs are unfriendly. Returns UTF-8 text by default; pass `binary: true` to receive base64-encoded bytes for non-text files.
- **`uploadFile`** accepts `content: string` plus an optional `encoding: "text" | "base64"`. Base64 is decoded to bytes before the upload so binary payloads stay JSON-safe at the tool boundary. `contentType`, `cacheControl`, and `metadata` are forwarded through to `files.upload`.
- **`signUploadUrl`** is approval-gated. No bytes move during the tool call itself, but issuing a presigned URL grants upload permission until `expiresIn` elapses.
- **`getFileUrl`** forwards `expiresIn` and `responseContentDisposition` straight to `files.url()`. Handy for letting the model hand the user a download link instead of streaming bytes back through the tool boundary.

## Errors

All tools rethrow the SDK's `FilesError` as-is — the AI SDK surfaces it to the caller. `downloadFile`'s `maxBytes` guard throws `FilesError` with `code: "Provider"` and a message including the actual size and the configured limit.

## License

MIT
