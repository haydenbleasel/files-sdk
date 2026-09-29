---
"files-sdk": patch
---

The `uploadFile` tool from `files-sdk/openai`'s `createAgentsFileTools()` (and `agentsUploadFile()`) now has a strict-mode-valid parameter schema. The OpenAI Agents SDK sends Zod-typed tools with `strict: true`, and the free-form `metadata` map could not be expressed in strict mode, so OpenAI rejected the tool definition. The Agents `uploadFile` tool no longer takes `metadata`, matching the Responses factory under `strict`.
