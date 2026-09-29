---
"files-sdk": patch
---

The `copyFile` tool from `files-sdk/claude` (`claudeCopyFile()` and `createClaudeFileTools()`) is now annotated `destructiveHint: true`, since copying onto an existing destination overwrites it. It stays `idempotentHint: true`.
