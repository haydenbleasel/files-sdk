---
"files-sdk": patch
---

`files-sdk/openai`: a `needsApproval` override in `createAgentsFileTools({ overrides })` no longer breaks the tool. It used to replace the Agents SDK's approval function with a boolean, so the runner failed with `needsApproval is not a function` on the first call. Overrides are now applied when each tool is built, an override takes precedence over `requireApproval` (and can gate a read tool), and every single-tool factory accepts `{ description, needsApproval }`.
