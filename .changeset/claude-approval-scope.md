---
"files-sdk": patch
---

`files-sdk/claude` no longer lets approval-gated writes skip approval. `createClaudeFileTools()` listed every tool in `allowedTools`, which the Claude Agent SDK runs without consulting `canUseTool`, so `uploadFile`, `deleteFile`, `copyFile`, and `signUploadUrl` ran unprompted even under the default `requireApproval: true`; `allowedTools` now lists only the tools that need no approval. The bundled `canUseTool` also denies tools that aren't on its own MCP server (such as `Bash`, `Write`, or another server's tools) instead of allowing them; compose your own callback to authorize those.
