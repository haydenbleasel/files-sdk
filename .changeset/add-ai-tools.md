---
"files-sdk": minor
---

Add AI SDK tools subpath (`files-sdk/ai`) exporting `createFileTools(...)` — wraps a configured `Files` instance as a set of Vercel AI SDK tools (`listFiles`, `getFileMetadata`, `downloadFile`, `getFileUrl`, `uploadFile`, `deleteFile`, `copyFile`, `signUploadUrl`) ready to plug into `generateText` / `streamText` / any agent. Mirrors `@github-tools/sdk`'s ergonomics: write tools require approval by default (configurable globally or per-tool via `requireApproval`), `readOnly: true` strips writes entirely, and `overrides` lets callers patch tool descriptions/titles/etc. without touching `execute`. Individual tool factories (`uploadFile`, `downloadFile`, …) are also exported for cherry-picking. `ai` and `zod` are optional peer dependencies — only required when consuming the new subpath.
