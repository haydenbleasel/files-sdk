import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

import type { Files } from "../index.js";
import { executors } from "../internal/ai-tools/executors.js";
import { TOOL_SCHEMAS } from "../internal/ai-tools/schemas.js";
import { isString } from "../internal/is.js";
import type { ToolAnnotations } from "./types.js";

/**
 * The MCP `CallToolResult` a handler resolves with. Derived from the SDK's
 * handler signature rather than imported from `@modelcontextprotocol/sdk` so
 * this subpath doesn't take on a second peer dependency.
 */
type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

const READ_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true };
const WRITE_ANNOTATIONS: ToolAnnotations = {
  destructiveHint: true,
  readOnlyHint: false,
};
const IDEMPOTENT_WRITE_ANNOTATIONS: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  readOnlyHint: false,
};

// Executor outputs are JSON-shaped records; a string output (already text)
// is passed through as-is so it isn't double-encoded.
const okResult = <Output>(output: Output): CallToolResult => ({
  content: [
    {
      text: isString(output) ? output : JSON.stringify(output),
      type: "text",
    },
  ],
});

const errorResult = (cause: unknown): CallToolResult => ({
  content: [
    {
      text: cause instanceof Error ? cause.message : String(cause),
      type: "text",
    },
  ],
  isError: true,
});

const wrap =
  <Input, Output>(run: (input: Input) => Promise<Output>) =>
  async (input: Input) => {
    try {
      return okResult(await run(input));
    } catch (error) {
      return errorResult(error);
    }
  };

export interface ClaudeWriteToolOptions {
  annotations?: ToolAnnotations;
}

export const claudeListFiles = (files: Files) =>
  tool(
    "listFiles",
    TOOL_SCHEMAS.listFiles.description,
    TOOL_SCHEMAS.listFiles.input.shape,
    wrap((input) => executors.listFiles(files, input)),
    { annotations: READ_ANNOTATIONS }
  );

export const claudeGetFileMetadata = (files: Files) =>
  tool(
    "getFileMetadata",
    TOOL_SCHEMAS.getFileMetadata.description,
    TOOL_SCHEMAS.getFileMetadata.input.shape,
    wrap((input) => executors.getFileMetadata(files, input)),
    { annotations: READ_ANNOTATIONS }
  );

export const claudeDownloadFile = (files: Files) =>
  tool(
    "downloadFile",
    TOOL_SCHEMAS.downloadFile.description,
    TOOL_SCHEMAS.downloadFile.input.shape,
    wrap((input) => executors.downloadFile(files, input)),
    { annotations: READ_ANNOTATIONS }
  );

export const claudeGetFileUrl = (files: Files) =>
  tool(
    "getFileUrl",
    TOOL_SCHEMAS.getFileUrl.description,
    TOOL_SCHEMAS.getFileUrl.input.shape,
    wrap((input) => executors.getFileUrl(files, input)),
    { annotations: READ_ANNOTATIONS }
  );

export const claudeUploadFile = (
  files: Files,
  { annotations = WRITE_ANNOTATIONS }: ClaudeWriteToolOptions = {}
) =>
  tool(
    "uploadFile",
    TOOL_SCHEMAS.uploadFile.description,
    TOOL_SCHEMAS.uploadFile.input.shape,
    wrap((input) => executors.uploadFile(files, input)),
    { annotations }
  );

export const claudeDeleteFile = (
  files: Files,
  { annotations = WRITE_ANNOTATIONS }: ClaudeWriteToolOptions = {}
) =>
  tool(
    "deleteFile",
    TOOL_SCHEMAS.deleteFile.description,
    TOOL_SCHEMAS.deleteFile.input.shape,
    wrap((input) => executors.deleteFile(files, input)),
    { annotations }
  );

export const claudeCopyFile = (
  files: Files,
  { annotations = IDEMPOTENT_WRITE_ANNOTATIONS }: ClaudeWriteToolOptions = {}
) =>
  tool(
    "copyFile",
    TOOL_SCHEMAS.copyFile.description,
    TOOL_SCHEMAS.copyFile.input.shape,
    wrap((input) => executors.copyFile(files, input)),
    { annotations }
  );

export const claudeSignUploadUrl = (
  files: Files,
  { annotations = IDEMPOTENT_WRITE_ANNOTATIONS }: ClaudeWriteToolOptions = {}
) =>
  tool(
    "signUploadUrl",
    TOOL_SCHEMAS.signUploadUrl.description,
    TOOL_SCHEMAS.signUploadUrl.input.shape,
    wrap((input) => executors.signUploadUrl(files, input)),
    { annotations }
  );
