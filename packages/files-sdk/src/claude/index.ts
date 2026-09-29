import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

import type { Files } from "../index.js";
import { resolveApproval } from "../internal/ai-tools/approval.js";
import type { ApprovalConfig } from "../internal/ai-tools/approval.js";
import { WRITE_TOOL_NAMES } from "../internal/ai-tools/schemas.js";
import type {
  FileToolName,
  FileWriteToolName,
} from "../internal/ai-tools/schemas.js";
import {
  claudeCopyFile,
  claudeDeleteFile,
  claudeDownloadFile,
  claudeGetFileMetadata,
  claudeGetFileUrl,
  claudeListFiles,
  claudeSignUploadUrl,
  claudeUploadFile,
} from "./tools.js";
import type { ClaudeToolOverrides } from "./types.js";

// The per-tool factories each return SdkMcpToolDefinition with a different
// concrete input shape. The SDK's own `tools` option is typed to accept any
// of them, so the homogeneous record borrows that element type and the
// definitions flow into `createSdkMcpServer` without a cast.
type SdkToolDefinition = NonNullable<
  Parameters<typeof createSdkMcpServer>[0]["tools"]
>[number];

export type { ApprovalConfig } from "../internal/ai-tools/approval.js";
export type {
  FileReadToolName,
  FileToolName,
  FileWriteToolName,
} from "../internal/ai-tools/schemas.js";

export interface ClaudeFileToolsOptions {
  /**
   * The configured `Files` instance the tools will operate against.
   */
  files: Files;
  /**
   * When `true`, write tools (`uploadFile`, `deleteFile`, `copyFile`,
   * `signUploadUrl`) are omitted from the MCP server. The model cannot
   * mutate the bucket regardless of approval configuration.
   */
  readOnly?: boolean;
  /**
   * Approval gating reflected by {@link ClaudeFileTools.needsApproval},
   * {@link ClaudeFileTools.allowedTools} (approval-gated writes are left out,
   * so the SDK routes them through `canUseTool`), and the bundled
   * {@link ClaudeFileTools.canUseTool}. Defaults to `true` (every write
   * requires approval). Pass `false` to disable, or an object keyed by
   * write-tool name for fine-grained control.
   */
  requireApproval?: ApprovalConfig;
  /**
   * Per-tool overrides for `description` / `annotations` without touching
   * the underlying handler or input schema.
   */
  overrides?: Partial<Record<FileToolName, ClaudeToolOverrides>>;
  /**
   * Name of the in-process MCP server that wraps these tools. Affects the
   * `mcp__<server-name>__<tool-name>` strings the agent uses to address
   * each tool. Defaults to `"files"`.
   */
  serverName?: string;
  /**
   * MCP server `version` metadata. Defaults to `"1.0.0"`.
   */
  serverVersion?: string;
}

export interface ClaudeFileTools {
  /**
   * Pass into `query({ options: { mcpServers: tools.mcpServers } })`.
   */
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
  /**
   * Pass into `query({ options: { allowedTools: tools.allowedTools } })`.
   * Each entry is of the form `mcp__<serverName>__<toolName>`.
   *
   * The Agent SDK runs every `allowedTools` entry **without** consulting
   * `canUseTool`, so this lists only the tools that need no approval: the
   * read tools, plus any write tool whose `needsApproval` resolves to
   * `false`. Approval-gated writes are left out on purpose, so each call
   * reaches `canUseTool`.
   */
  allowedTools: string[];
  /**
   * Ready-made `canUseTool` callback, scoped to this bundle's MCP server.
   * For tools on that server it allows reads and writes whose `needsApproval`
   * resolves to `false`, and denies approval-gated writes with a
   * `"requires approval"` message. It denies **every other tool** (built-ins
   * like `Bash` or `Write`, other MCP servers), because `canUseTool` is the
   * permission callback for the whole session and this one only knows how to
   * authorize its own tools.
   *
   * Pass it directly into `query()` when files are the only tools that should
   * run unprompted. To authorize other tools too, write your own callback
   * that delegates names starting with `mcp__<serverName>__` here (or to
   * {@link ClaudeFileTools.needsApproval}) and applies your own policy to the
   * rest.
   */
  canUseTool: CanUseTool;
  /**
   * Whether the named tool is approval-gated under the configured
   * `requireApproval`. Accepts both bare names (`"uploadFile"`) and the
   * MCP-prefixed form (`"mcp__files__uploadFile"`). Read tools and unknown
   * names return `false`.
   */
  needsApproval: (toolName: string) => boolean;
  /**
   * The raw SDK MCP server instance — same value as
   * `mcpServers[serverName]`. Exposed for callers that want to compose it
   * into a larger `mcpServers` map.
   */
  server: McpSdkServerConfigWithInstance;
  /**
   * The MCP server name used in the `mcp__<server>__*` prefix.
   */
  serverName: string;
}

const DEFAULT_SERVER_NAME = "files";
const DEFAULT_SERVER_VERSION = "1.0.0";

// SAFETY: `Set#has` is a pure membership test — widening the probe to the
// set's key type can't yield a false positive, and a hit proves the name is a
// write-tool name.
const isWriteTool = (name: string): name is FileWriteToolName =>
  WRITE_TOOL_NAMES.has(name as FileWriteToolName);

/**
 * Create files-sdk tools shaped for the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`).
 *
 * The Claude Agent SDK consumes tools by way of an in-process MCP server +
 * an `allowedTools` allow-list + a `canUseTool` approval callback. The
 * returned bundle gives you all three, plus the raw server instance and a
 * `needsApproval()` helper if you want to wire your own `canUseTool`.
 *
 * `allowedTools` lists only the tools that run without approval (the SDK
 * never asks `canUseTool` about those), so approval-gated writes always reach
 * `canUseTool`. The bundled `canUseTool` denies gated writes and any tool
 * that isn't on this bundle's MCP server; compose your own to prompt a human
 * or to authorize other tools.
 *
 * @example
 * ```ts
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { Files } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { createClaudeFileTools } from "files-sdk/claude";
 *
 * const files = new Files({ adapter: s3({ bucket: "uploads" }) });
 * const tools = createClaudeFileTools({ files });
 *
 * for await (const message of query({
 *   prompt: "List my files.",
 *   options: {
 *     mcpServers: tools.mcpServers,
 *     allowedTools: tools.allowedTools,
 *     canUseTool: tools.canUseTool,
 *   },
 * })) {
 *   // handle messages
 * }
 * ```
 *
 * @example Read-only agent
 * ```ts
 * createClaudeFileTools({ files, readOnly: true })
 * ```
 *
 * @example Granular approval
 * ```ts
 * createClaudeFileTools({
 *   files,
 *   requireApproval: {
 *     deleteFile: true,
 *     uploadFile: false,
 *     copyFile: false,
 *     signUploadUrl: true,
 *   },
 * })
 * ```
 */
export const createClaudeFileTools = ({
  files,
  readOnly = false,
  requireApproval = true,
  overrides,
  serverName = DEFAULT_SERVER_NAME,
  serverVersion = DEFAULT_SERVER_VERSION,
}: ClaudeFileToolsOptions): ClaudeFileTools => {
  const allTools: Record<FileToolName, SdkToolDefinition> = {
    copyFile: claudeCopyFile(files),
    deleteFile: claudeDeleteFile(files),
    downloadFile: claudeDownloadFile(files),
    getFileMetadata: claudeGetFileMetadata(files),
    getFileUrl: claudeGetFileUrl(files),
    listFiles: claudeListFiles(files),
    signUploadUrl: claudeSignUploadUrl(files),
    uploadFile: claudeUploadFile(files),
  };

  if (overrides) {
    for (const [name, toolOverrides] of Object.entries(overrides)) {
      if (name in allTools && toolOverrides) {
        // SAFETY: `allTools` is a closed record keyed by exactly the
        // FileToolName union, so the `in` check above proves membership.
        const key = name as FileToolName;
        allTools[key] = { ...allTools[key], ...toolOverrides };
      }
    }
  }

  // SAFETY: `Object.entries` widens keys to `string`; `allTools` is a closed
  // record whose only keys are the FileToolName union.
  const includedTools = (
    Object.entries(allTools) as [FileToolName, SdkToolDefinition][]
  ).filter(([name]) => !(readOnly && isWriteTool(name)));

  const prefix = `mcp__${serverName}__`;
  const stripPrefix = (name: string): string =>
    name.startsWith(prefix) ? name.slice(prefix.length) : name;

  const includedSet: ReadonlySet<string> = new Set(
    includedTools.map(([name]) => name)
  );

  const needsApproval = (toolName: string): boolean => {
    const bare = stripPrefix(toolName);
    if (!includedSet.has(bare)) {
      return false;
    }
    if (!isWriteTool(bare)) {
      return false;
    }
    return resolveApproval(bare, requireApproval);
  };

  // `canUseTool` sees the name exactly as the SDK addresses it, so only the
  // prefixed form of a tool on this server counts as one of ours. Anything
  // else (Bash, Write, another MCP server's tools) is outside what this
  // bundle can vouch for and is denied rather than waved through.
  const ownsTool = (toolName: string): boolean =>
    toolName.startsWith(prefix) &&
    includedSet.has(toolName.slice(prefix.length));

  const canUseTool: CanUseTool = (toolName, input) => {
    if (!ownsTool(toolName)) {
      return Promise.resolve({
        behavior: "deny",
        message: `Tool "${toolName}" is not a files-sdk tool. The files-sdk canUseTool only authorizes tools on the "${serverName}" MCP server; compose it with your own canUseTool to allow other tools.`,
      });
    }
    return Promise.resolve(
      needsApproval(toolName)
        ? {
            behavior: "deny",
            message: `Tool "${toolName}" requires approval.`,
          }
        : { behavior: "allow", updatedInput: input }
    );
  };

  const server = createSdkMcpServer({
    name: serverName,
    tools: includedTools.map(([, t]) => t),
    version: serverVersion,
  });

  return {
    // Only tools that run without approval: the SDK skips `canUseTool` for
    // anything listed here, so a gated write in this list would never be
    // asked about.
    allowedTools: includedTools
      .filter(([name]) => !needsApproval(name))
      .map(([name]) => `${prefix}${name}`),
    canUseTool,
    mcpServers: { [serverName]: server },
    needsApproval,
    server,
    serverName,
  };
};

export {
  claudeCopyFile,
  claudeDeleteFile,
  claudeDownloadFile,
  claudeGetFileMetadata,
  claudeGetFileUrl,
  claudeListFiles,
  claudeSignUploadUrl,
  claudeUploadFile,
} from "./tools.js";
export type { ClaudeWriteToolOptions } from "./tools.js";
export type { ClaudeToolOverrides, ToolAnnotations } from "./types.js";
