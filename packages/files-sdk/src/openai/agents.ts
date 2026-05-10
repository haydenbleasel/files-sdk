import { tool } from "@openai/agents";

import type { Files } from "../index.js";
import { resolveApproval } from "../internal/ai-tools/approval.js";
import type { ApprovalConfig } from "../internal/ai-tools/approval.js";
import { executors } from "../internal/ai-tools/executors.js";
import {
  TOOL_SCHEMAS,
  WRITE_TOOL_NAMES,
} from "../internal/ai-tools/schemas.js";
import type {
  FileReadToolName,
  FileToolName,
  FileWriteToolName,
} from "../internal/ai-tools/schemas.js";
import type { AgentsToolOverrides } from "./types.js";

export const agentsListFiles = (files: Files) =>
  tool({
    description: TOOL_SCHEMAS.listFiles.description,
    execute: (input) => executors.listFiles(files, input),
    name: "listFiles",
    parameters: TOOL_SCHEMAS.listFiles.input,
  });

export const agentsGetFileMetadata = (files: Files) =>
  tool({
    description: TOOL_SCHEMAS.getFileMetadata.description,
    execute: (input) => executors.getFileMetadata(files, input),
    name: "getFileMetadata",
    parameters: TOOL_SCHEMAS.getFileMetadata.input,
  });

export const agentsDownloadFile = (files: Files) =>
  tool({
    description: TOOL_SCHEMAS.downloadFile.description,
    execute: (input) => executors.downloadFile(files, input),
    name: "downloadFile",
    parameters: TOOL_SCHEMAS.downloadFile.input,
  });

export const agentsGetFileUrl = (files: Files) =>
  tool({
    description: TOOL_SCHEMAS.getFileUrl.description,
    execute: (input) => executors.getFileUrl(files, input),
    name: "getFileUrl",
    parameters: TOOL_SCHEMAS.getFileUrl.input,
  });

export const agentsUploadFile = (
  files: Files,
  { needsApproval = true }: { needsApproval?: boolean } = {}
) =>
  tool({
    description: TOOL_SCHEMAS.uploadFile.description,
    execute: (input) => executors.uploadFile(files, input),
    name: "uploadFile",
    needsApproval,
    parameters: TOOL_SCHEMAS.uploadFile.input,
  });

export const agentsDeleteFile = (
  files: Files,
  { needsApproval = true }: { needsApproval?: boolean } = {}
) =>
  tool({
    description: TOOL_SCHEMAS.deleteFile.description,
    execute: (input) => executors.deleteFile(files, input),
    name: "deleteFile",
    needsApproval,
    parameters: TOOL_SCHEMAS.deleteFile.input,
  });

export const agentsCopyFile = (
  files: Files,
  { needsApproval = true }: { needsApproval?: boolean } = {}
) =>
  tool({
    description: TOOL_SCHEMAS.copyFile.description,
    execute: (input) => executors.copyFile(files, input),
    name: "copyFile",
    needsApproval,
    parameters: TOOL_SCHEMAS.copyFile.input,
  });

export const agentsSignUploadUrl = (
  files: Files,
  { needsApproval = true }: { needsApproval?: boolean } = {}
) =>
  tool({
    description: TOOL_SCHEMAS.signUploadUrl.description,
    execute: (input) => executors.signUploadUrl(files, input),
    name: "signUploadUrl",
    needsApproval,
    parameters: TOOL_SCHEMAS.signUploadUrl.input,
  });

export interface AgentsFileTools {
  listFiles: ReturnType<typeof agentsListFiles>;
  getFileMetadata: ReturnType<typeof agentsGetFileMetadata>;
  downloadFile: ReturnType<typeof agentsDownloadFile>;
  getFileUrl: ReturnType<typeof agentsGetFileUrl>;
  uploadFile: ReturnType<typeof agentsUploadFile>;
  deleteFile: ReturnType<typeof agentsDeleteFile>;
  copyFile: ReturnType<typeof agentsCopyFile>;
  signUploadUrl: ReturnType<typeof agentsSignUploadUrl>;
}

export type ReadOnlyAgentsFileTools = Pick<AgentsFileTools, FileReadToolName>;

export interface AgentsFileToolsOptions {
  /**
   * The configured `Files` instance the tools will operate against.
   */
  files: Files;
  /**
   * When `true`, write tools (`uploadFile`, `deleteFile`, `copyFile`,
   * `signUploadUrl`) are omitted entirely. The model cannot mutate the
   * bucket regardless of approval configuration.
   */
  readOnly?: boolean;
  /**
   * Approval gating for write tools. Defaults to `true` (every write
   * requires approval). Pass `false` to disable, or an object keyed
   * by write-tool name for fine-grained control.
   */
  requireApproval?: ApprovalConfig;
  /**
   * Per-tool overrides for `description` and `needsApproval` without
   * touching `execute` or `parameters`.
   */
  overrides?: Partial<Record<FileToolName, AgentsToolOverrides>>;
}

/**
 * Create a set of files-sdk tools shaped for the OpenAI Agents SDK
 * (`@openai/agents`).
 *
 * Returns a record keyed by tool name — spread `Object.values()` into
 * `new Agent({ tools })`. Write tools require approval by default; the
 * Agents SDK surfaces an `interruption` that the program resolves by
 * approving or rejecting the call.
 *
 * @example
 * ```ts
 * import { Agent, run } from "@openai/agents";
 * import { Files } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { createAgentsFileTools } from "files-sdk/openai";
 *
 * const files = new Files({ adapter: s3({ bucket: "uploads" }) });
 * const tools = createAgentsFileTools({ files });
 *
 * const agent = new Agent({
 *   instructions: "Help the user manage their files.",
 *   name: "Files agent",
 *   tools: Object.values(tools),
 * });
 *
 * const result = await run(agent, "List my files.");
 * ```
 */
export function createAgentsFileTools(
  opts: AgentsFileToolsOptions & { readOnly: true }
): ReadOnlyAgentsFileTools;
export function createAgentsFileTools(
  opts: AgentsFileToolsOptions & { readOnly?: false | undefined }
): AgentsFileTools;
export function createAgentsFileTools(
  opts: AgentsFileToolsOptions
): AgentsFileTools | ReadOnlyAgentsFileTools;
export function createAgentsFileTools({
  files,
  readOnly = false,
  requireApproval = true,
  overrides,
}: AgentsFileToolsOptions): AgentsFileTools | ReadOnlyAgentsFileTools {
  const approval = (name: FileWriteToolName) => ({
    needsApproval: resolveApproval(name, requireApproval),
  });

  const allTools: AgentsFileTools = {
    copyFile: agentsCopyFile(files, approval("copyFile")),
    deleteFile: agentsDeleteFile(files, approval("deleteFile")),
    downloadFile: agentsDownloadFile(files),
    getFileMetadata: agentsGetFileMetadata(files),
    getFileUrl: agentsGetFileUrl(files),
    listFiles: agentsListFiles(files),
    signUploadUrl: agentsSignUploadUrl(files, approval("signUploadUrl")),
    uploadFile: agentsUploadFile(files, approval("uploadFile")),
  };

  if (overrides) {
    for (const [name, toolOverrides] of Object.entries(overrides)) {
      if (name in allTools && toolOverrides) {
        const key = name as keyof AgentsFileTools;
        Object.assign(allTools, {
          [key]: { ...allTools[key], ...toolOverrides },
        });
      }
    }
  }

  if (!readOnly) {
    return allTools;
  }

  return Object.fromEntries(
    Object.entries(allTools).filter(
      ([name]) => !WRITE_TOOL_NAMES.has(name as FileWriteToolName)
    )
  ) as ReadOnlyAgentsFileTools;
}

export type { FileReadToolName, FileToolName, FileWriteToolName };
