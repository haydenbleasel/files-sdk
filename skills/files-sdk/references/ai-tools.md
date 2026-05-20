# AI tool bindings

Three subpaths expose a configured `Files` instance as ready-made tools for AI agents. They share the same eight operations (`listFiles`, `getFileMetadata`, `downloadFile`, `getFileUrl`, `uploadFile`, `deleteFile`, `copyFile`, `signUploadUrl`) and the same approval-gating defaults — only the _shape of the binding_ differs per SDK.

The four writes (`uploadFile`, `deleteFile`, `copyFile`, `signUploadUrl`) are approval-gated by default. Reads are not.

## Vercel AI SDK — `files-sdk/ai-sdk`

Tools are a record shaped for `tools: { ... }` on `generateText`/`streamText`/`ToolLoopAgent`.

```ts
import { Files } from "files-sdk";
import { createFileTools } from "files-sdk/ai-sdk";
import { s3 } from "files-sdk/s3";
import { generateText } from "ai";

const files = new Files({ adapter: s3({ bucket: "uploads" }) });

await generateText({
  model,
  tools: createFileTools({ files }),
  prompt: "Find every CSV under reports/ and summarize the latest one.",
});
```

### Read-only agent

```ts
createFileTools({ files, readOnly: true });
// Result type is ReadOnlyFileTools — writes are not just gated, they don't exist.
```

### Granular approval

```ts
createFileTools({
  files,
  requireApproval: {
    deleteFile: true,
    uploadFile: false,
    copyFile: false,
    signUploadUrl: true,
  },
});
```

### Per-tool overrides

```ts
createFileTools({
  files,
  overrides: {
    deleteFile: { needsApproval: false },
    listFiles: { description: "List user uploads in the current tenant" },
  },
});
```

`execute`, `inputSchema`, and `outputSchema` cannot be overridden. If you need to change behavior, wrap the tool yourself or call the `Files` methods directly.

## OpenAI — `files-sdk/openai`

Two surfaces: **Responses API** and **Agents SDK**. Pick whichever your codebase already uses.

### Responses API

```ts
import { Files } from "files-sdk";
import { createResponsesFileTools } from "files-sdk/openai";
import { s3 } from "files-sdk/s3";
import OpenAI from "openai";

const openai = new OpenAI();
const files = new Files({ adapter: s3({ bucket: "uploads" }) });
const tools = createResponsesFileTools({ files });

const response = await openai.responses.create({
  model: "gpt-5",
  tools: tools.definitions,
  input: [{ role: "user", content: "List files under reports/." }],
});

// Run any function_calls the model emitted.
const followUp: unknown[] = [];
for (const item of response.output) {
  if (item.type === "function_call") {
    if (tools.needsApproval(item.name)) {
      // Human-in-the-loop: pause, ask, then continue.
      continue;
    }
    const output = await tools.execute(item);
    followUp.push(item, output);
  }
}
```

Notes:

- `tools.execute(call)` parses + validates `arguments`, runs the operation, returns a `function_call_output` item ready to push into the next turn's input.
- JSON parse and Zod validation failures are returned **as the tool output** so the model can self-correct. `FilesError` from the SDK is rethrown — the caller decides how to surface it.
- `tools.execute` does **not** enforce approval. Check `tools.needsApproval(item.name)` before executing if you want the gate.

### Agents SDK

```ts
import { Files } from "files-sdk";
import { createAgentsFileTools } from "files-sdk/openai";
import { s3 } from "files-sdk/s3";
import { Agent, run } from "@openai/agents";

const files = new Files({ adapter: s3({ bucket: "uploads" }) });
const tools = createAgentsFileTools({ files });

const agent = new Agent({
  name: "Bucket assistant",
  tools: Object.values(tools),
});

await run(agent, "List files under reports/.");
```

The agents-shape returns a record keyed by tool name; spread or `Object.values()` to plug into the `tools` array.

## Anthropic Claude Agent SDK — `files-sdk/claude`

Bridges to the Claude Agent SDK's in-process MCP server + `allowedTools` + `canUseTool` triad.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { createClaudeFileTools } from "files-sdk/claude";

const files = new Files({ adapter: s3({ bucket: "uploads" }) });
const tools = createClaudeFileTools({ files });

for await (const message of query({
  prompt: "List my files.",
  options: {
    mcpServers: tools.mcpServers,
    allowedTools: tools.allowedTools,
    canUseTool: tools.canUseTool,
  },
})) {
  // handle messages
}
```

What the bundle exposes:

- `mcpServers` — pass into `query({ options: { mcpServers } })`.
- `allowedTools` — strings of the form `mcp__<serverName>__<toolName>`. Pass into `query({ options: { allowedTools } })`.
- `canUseTool` — ready-made approval callback. Allows reads, allows writes whose `needsApproval` resolves to `false`, denies the rest with `"requires approval"`.
- `needsApproval(toolName)` — accepts both bare names (`"uploadFile"`) and prefixed (`"mcp__files__uploadFile"`).
- `server` and `serverName` — the raw MCP server instance and its name, for callers composing into a larger `mcpServers` map.

Override the server name when composing multiple MCP servers:

```ts
createClaudeFileTools({ files, serverName: "user-uploads" });
// allowedTools entries become `mcp__user-uploads__listFiles`, etc.
```

## Choosing across the three

- **Vercel AI SDK** — simplest binding. The framework handles tool dispatch; you just pass `createFileTools({ files })`.
- **OpenAI Responses** — most explicit. You loop the `function_call` items yourself, which is also where you decide whether to pause for approval. Good when you want full control of the agent loop.
- **OpenAI Agents** — similar to AI SDK in spirit (framework loops for you), but inside the OpenAI Agents runtime.
- **Claude Agent SDK** — driven by the MCP + `canUseTool` contract. Use this when the agent already lives inside Claude Code or another Claude Agent SDK harness.

All four `requireApproval` shapes (`true`, `false`, `{ ... }`, `readOnly`) work identically across the three subpaths.
