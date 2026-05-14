import { CodeBlock } from "@/components/code-block";
import { CodeTabs } from "@/components/code-tabs";
import { Heading } from "@/components/heading";

const INSTALL_TABS = [
  {
    code: "npm install @anthropic-ai/claude-agent-sdk zod",
    id: "npm",
    label: "npm",
    lang: "bash",
  },
  {
    code: "pnpm add @anthropic-ai/claude-agent-sdk zod",
    id: "pnpm",
    label: "pnpm",
    lang: "bash",
  },
  {
    code: "bun add @anthropic-ai/claude-agent-sdk zod",
    id: "bun",
    label: "bun",
    lang: "bash",
  },
  {
    code: "yarn add @anthropic-ai/claude-agent-sdk zod",
    id: "yarn",
    label: "yarn",
    lang: "bash",
  },
] as const;

const QUICK_START = `import { query } from "@anthropic-ai/claude-agent-sdk";
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { createClaudeFileTools } from "files-sdk/claude";

const files = new Files({ adapter: s3({ bucket: "uploads" }) });
const tools = createClaudeFileTools({ files });

for await (const message of query({
  prompt: "Find every CSV under reports/ and summarize the latest one.",
  options: {
    mcpServers: tools.mcpServers,
    allowedTools: tools.allowedTools,
    canUseTool: tools.canUseTool,
  },
})) {
  // handle messages
}`;

const APPROVAL_EXAMPLE = `// All writes require approval (default) - denied by the bundled canUseTool.
createClaudeFileTools({ files });

// Disable the approval gate entirely.
createClaudeFileTools({ files, requireApproval: false });

// Granular: only destructive operations need approval.
createClaudeFileTools({
  files,
  requireApproval: {
    deleteFile: true,
    signUploadUrl: true,
    uploadFile: false,
    copyFile: false,
  },
});`;

const CUSTOM_CAN_USE_TOOL_EXAMPLE = `import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

const tools = createClaudeFileTools({ files });

// Compose your own canUseTool - needsApproval accepts both bare
// names ("uploadFile") and the mcp-prefixed form passed in by the SDK.
const canUseTool: CanUseTool = async (name, input) => {
  if (tools.needsApproval(name)) {
    const approved = await askUser(name, input);
    return approved
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "User rejected the call." };
  }
  return { behavior: "allow", updatedInput: input };
};`;

const READ_ONLY_EXAMPLE = `// Strip every write tool. The model can browse but cannot mutate
// the bucket regardless of approval configuration.
createClaudeFileTools({ files, readOnly: true });
// allowedTools → ["mcp__files__listFiles", "mcp__files__getFileMetadata",
//                 "mcp__files__downloadFile", "mcp__files__getFileUrl"]`;

const SERVER_NAME_EXAMPLE = `// Override the MCP server name - affects the mcp__<server>__<tool>
// prefix the model sees, and the mcpServers map key.
const tools = createClaudeFileTools({ files, serverName: "storage" });
// tools.allowedTools → ["mcp__storage__listFiles", ...]
// tools.mcpServers   → { storage: <McpSdkServerConfigWithInstance> }`;

const CHERRY_PICK_EXAMPLE = `import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { Files } from "files-sdk";
import {
  claudeDownloadFile,
  claudeListFiles,
  claudeUploadFile,
} from "files-sdk/claude";

const files = new Files({ adapter });

// Compose your own MCP server with just the tools you want.
const server = createSdkMcpServer({
  name: "files",
  version: "1.0.0",
  tools: [claudeListFiles(files), claudeDownloadFile(files), claudeUploadFile(files)],
});`;

export const Claude = () => (
  <section>
    <Heading as="h2" id="claude-tools">
      Claude Agent SDK
    </Heading>
    <p>
      The <code>files-sdk/claude</code> subpath exposes a configured{" "}
      <code>Files</code> instance to the{" "}
      <a
        className="underline decoration-dotted underline-offset-4 hover:text-foreground"
        href="https://docs.claude.com/en/api/agent-sdk/overview"
        rel="noreferrer"
        target="_blank"
      >
        Claude Agent SDK
      </a>{" "}
      (<code>@anthropic-ai/claude-agent-sdk</code>, the renamed Claude Code
      SDK). The Agent SDK consumes tools as an in-process MCP server plus an{" "}
      <code>allowedTools</code> allow-list and a <code>canUseTool</code>{" "}
      approval callback, so <code>createClaudeFileTools</code> returns a bundle
      of all three - pass them straight into <code>query()</code>.
    </p>
    <p>
      <code>@anthropic-ai/claude-agent-sdk</code> and <code>zod</code> are
      optional peer dependencies - only install them if you're consuming this
      subpath.
    </p>

    <section>
      <Heading as="h3" id="claude-tools-installation">
        Installation
      </Heading>
      <CodeTabs tabs={INSTALL_TABS} />
    </section>

    <section>
      <Heading as="h3" id="claude-tools-quick-start">
        Quick start
      </Heading>
      <p>
        <code>createClaudeFileTools</code> returns{" "}
        <code>
          {
            "{ mcpServers, allowedTools, canUseTool, needsApproval, server, serverName }"
          }
        </code>
        . The first three slot directly into <code>query()</code>'s options; the
        rest are escape hatches for callers that want to compose with existing
        MCP servers or wire their own approval UX.
      </p>
      <CodeBlock code={QUICK_START} lang="tsx" />
    </section>

    <section>
      <Heading as="h3" id="claude-tools-approval">
        Approval control
      </Heading>
      <p>
        The bundled <code>canUseTool</code> denies any tool whose{" "}
        <code>needsApproval</code> resolves to <code>true</code> with a{" "}
        <code>"requires approval"</code> message, and allows everything else.{" "}
        <code>requireApproval</code> accepts a boolean for the all-or-nothing
        case, or an object keyed by write tool name for fine-grained control.
      </p>
      <CodeBlock code={APPROVAL_EXAMPLE} lang="ts" />
      <p>
        For real human-in-the-loop UX, compose your own <code>canUseTool</code>{" "}
        on top of <code>tools.needsApproval()</code>. The helper accepts both
        bare names (<code>"uploadFile"</code>) and the MCP-prefixed form (
        <code>"mcp__files__uploadFile"</code>) that the SDK passes in, so the
        callback is symmetric whichever shape you receive.
      </p>
      <CodeBlock code={CUSTOM_CAN_USE_TOOL_EXAMPLE} lang="ts" />
    </section>

    <section>
      <Heading as="h3" id="claude-tools-read-only">
        Read-only mode
      </Heading>
      <p>
        Pass <code>readOnly: true</code> to drop every write tool from the
        bundled MCP server. The model cannot mutate the bucket regardless of how{" "}
        <code>requireApproval</code> is configured.
      </p>
      <CodeBlock code={READ_ONLY_EXAMPLE} lang="ts" />
    </section>

    <section>
      <Heading as="h3" id="claude-tools-server-name">
        Server name
      </Heading>
      <p>
        Claude addresses each MCP tool as{" "}
        <code>mcp__&lt;server-name&gt;__&lt;tool-name&gt;</code>. The default
        server name is <code>"files"</code>; override it via{" "}
        <code>serverName</code> when you need to namespace alongside another MCP
        server or just prefer a different label in transcripts.
      </p>
      <CodeBlock code={SERVER_NAME_EXAMPLE} lang="ts" />
    </section>

    <section>
      <Heading as="h3" id="claude-tools-cherry-pick">
        Cherry-picking tools
      </Heading>
      <p>
        Each tool factory is exported individually as a{" "}
        <code>SdkMcpToolDefinition</code> - bundle them into your own{" "}
        <code>createSdkMcpServer</code> call when you want full control over the
        MCP server shape or want to mix files-sdk tools with your own.
      </p>
      <CodeBlock code={CHERRY_PICK_EXAMPLE} lang="ts" />
    </section>
  </section>
);
