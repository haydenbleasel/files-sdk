---
"files-sdk": patch
---

`files-sdk/ai-sdk` and `files-sdk/claude`: an override field set to `undefined` in `createFileTools({ overrides })` or `createClaudeFileTools({ overrides })` now leaves the tool's own value in place, as it already did in `files-sdk/openai`. It used to erase the field, so `overrides: { deleteFile: { needsApproval: undefined } }` removed the approval gate from a write tool, and an undefined `description` or `annotations` stripped the tool's description or its read-only and destructive hints.
