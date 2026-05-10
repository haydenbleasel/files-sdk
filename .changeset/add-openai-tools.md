---
"files-sdk": minor
---

Add OpenAI tools subpath (`files-sdk/openai`) with two factories:

- `createResponsesFileTools(...)` — for OpenAI's native [Responses API](https://platform.openai.com/docs/api-reference/responses). Returns `{ definitions, execute, needsApproval }`. `definitions` is the array of function-tool specs to pass into `openai.responses.create({ tools })`. `execute(call)` runs a `function_call` item and returns a `function_call_output` ready to push into the next turn's input — JSON parse failures and Zod validation errors come back as the tool's output so the model can self-correct.
- `createAgentsFileTools(...)` — for the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) (`@openai/agents`). Returns a record of `tool()` outputs ready to spread into `new Agent({ tools })`.

Both wrap the same eight file operations as `files-sdk/ai-sdk` (`listFiles`, `getFileMetadata`, `downloadFile`, `getFileUrl`, `uploadFile`, `deleteFile`, `copyFile`, `signUploadUrl`) with the same approval-gating defaults, `readOnly` mode, and per-tool overrides. Schemas + execute logic are extracted to a shared internal module so the three subpaths can't drift apart.

`openai` and `@openai/agents` are optional peer dependencies — install only the one(s) you use. The subpath requires Zod 4.
