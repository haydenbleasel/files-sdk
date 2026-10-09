---
"files-sdk": patch
---

Fix `createFileTools()` from `files-sdk/ai-sdk` not typechecking with AI SDK 7. `FileTools` was declared as an `interface`, which has no implicit index signature, so it wasn't assignable to `ai`'s `ToolSet` and `generateText({ tools: createFileTools({ files }) })`, `streamText`, and `new ToolLoopAgent({ tools })` failed to compile with "Index signature for type 'string' is missing". `FileTools` is now a type alias with the same members. `AgentsFileTools` from `files-sdk/openai` gets the same change, so it's assignable to a `Record<string, Tool>`. The Vercel AI SDK docs also now spell out that an AI SDK 7 `toolApproval` function overrides every tool's `needsApproval`, and that returning `undefined` from it runs a write without approval.
