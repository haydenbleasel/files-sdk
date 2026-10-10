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

// The Agents SDK emits every Zod-parameterised tool with `strict: true`, and
// OpenAI strict mode requires `additionalProperties: false` on every object —
// a free-form map like `uploadFile`'s `metadata` record can't be expressed and
// the API rejects the whole tool definition. Drop it here, as the Responses
// pack does under strict mode.
const agentsUploadFileInput = TOOL_SCHEMAS.uploadFile.input.omit({
  metadata: true,
});

// SAFETY: `Set#has` is a pure membership test — widening the probe to the
// set's key type can't yield a false positive, and a hit proves the name is a
// write-tool name.
const isWriteTool = (name: string): name is FileWriteToolName =>
  WRITE_TOOL_NAMES.has(name as FileWriteToolName);

export const agentsListFiles = (
  files: Files,
  { description, needsApproval = false }: AgentsToolOverrides = {}
) =>
  tool({
    description: description ?? TOOL_SCHEMAS.listFiles.description,
    execute: (input) => executors.listFiles(files, input),
    name: "listFiles",
    needsApproval,
    parameters: TOOL_SCHEMAS.listFiles.input,
  });

export const agentsGetFileMetadata = (
  files: Files,
  { description, needsApproval = false }: AgentsToolOverrides = {}
) =>
  tool({
    description: description ?? TOOL_SCHEMAS.getFileMetadata.description,
    execute: (input) => executors.getFileMetadata(files, input),
    name: "getFileMetadata",
    needsApproval,
    parameters: TOOL_SCHEMAS.getFileMetadata.input,
  });

export const agentsDownloadFile = (
  files: Files,
  { description, needsApproval = false }: AgentsToolOverrides = {}
) =>
  tool({
    description: description ?? TOOL_SCHEMAS.downloadFile.description,
    execute: (input) => executors.downloadFile(files, input),
    name: "downloadFile",
    needsApproval,
    parameters: TOOL_SCHEMAS.downloadFile.input,
  });

export const agentsGetFileUrl = (
  files: Files,
  { description, needsApproval = false }: AgentsToolOverrides = {}
) =>
  tool({
    description: description ?? TOOL_SCHEMAS.getFileUrl.description,
    execute: (input) => executors.getFileUrl(files, input),
    name: "getFileUrl",
    needsApproval,
    parameters: TOOL_SCHEMAS.getFileUrl.input,
  });

/**
 * `uploadFile` for the Agents SDK. The tool runs in OpenAI strict mode, which
 * cannot represent free-form maps, so unlike the AI SDK and Claude packs it
 * takes no `metadata` argument.
 */
export const agentsUploadFile = (
  files: Files,
  { description, needsApproval = true }: AgentsToolOverrides = {}
) =>
  tool({
    description: description ?? TOOL_SCHEMAS.uploadFile.description,
    execute: (input) => executors.uploadFile(files, input),
    name: "uploadFile",
    needsApproval,
    parameters: agentsUploadFileInput,
  });

export const agentsDeleteFile = (
  files: Files,
  { description, needsApproval = true }: AgentsToolOverrides = {}
) =>
  tool({
    description: description ?? TOOL_SCHEMAS.deleteFile.description,
    execute: (input) => executors.deleteFile(files, input),
    name: "deleteFile",
    needsApproval,
    parameters: TOOL_SCHEMAS.deleteFile.input,
  });

export const agentsCopyFile = (
  files: Files,
  { description, needsApproval = true }: AgentsToolOverrides = {}
) =>
  tool({
    description: description ?? TOOL_SCHEMAS.copyFile.description,
    execute: (input) => executors.copyFile(files, input),
    name: "copyFile",
    needsApproval,
    parameters: TOOL_SCHEMAS.copyFile.input,
  });

export const agentsSignUploadUrl = (
  files: Files,
  { description, needsApproval = true }: AgentsToolOverrides = {}
) =>
  tool({
    description: description ?? TOOL_SCHEMAS.signUploadUrl.description,
    execute: (input) => executors.signUploadUrl(files, input),
    name: "signUploadUrl",
    needsApproval,
    parameters: TOOL_SCHEMAS.signUploadUrl.input,
  });

// A `type`, not an `interface`, so it's assignable to an index-signature
// record (`Record<string, Tool>`) the way `files-sdk/ai-sdk`'s `FileTools` is.
// oxlint-disable-next-line typescript/consistent-type-definitions -- must stay a type alias to be assignable to a string-keyed record (see above)
export type AgentsFileTools = {
  listFiles: ReturnType<typeof agentsListFiles>;
  getFileMetadata: ReturnType<typeof agentsGetFileMetadata>;
  downloadFile: ReturnType<typeof agentsDownloadFile>;
  getFileUrl: ReturnType<typeof agentsGetFileUrl>;
  uploadFile: ReturnType<typeof agentsUploadFile>;
  deleteFile: ReturnType<typeof agentsDeleteFile>;
  copyFile: ReturnType<typeof agentsCopyFile>;
  signUploadUrl: ReturnType<typeof agentsSignUploadUrl>;
};

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
   * touching `execute` or `parameters`. A `needsApproval` here wins over
   * `requireApproval`, and can gate a read tool too.
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
 * The Agents SDK runs these tools in OpenAI strict mode, so every parameter
 * schema is strict-valid: optional arguments are nullable, and `uploadFile`
 * takes no `metadata` (strict mode can't express a free-form map).
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
  // Overrides go into each factory rather than onto the built tool: the
  // Agents SDK turns `needsApproval` into the function its runner calls, so a
  // boolean patched onto a built tool would fail on the first call.
  const optionsFor = (name: FileToolName): AgentsToolOverrides => {
    const override = overrides?.[name];
    return {
      ...(isWriteTool(name) && {
        needsApproval: resolveApproval(name, requireApproval),
      }),
      ...(override?.description !== undefined && {
        description: override.description,
      }),
      ...(override?.needsApproval !== undefined && {
        needsApproval: override.needsApproval,
      }),
    };
  };

  const allTools: AgentsFileTools = {
    copyFile: agentsCopyFile(files, optionsFor("copyFile")),
    deleteFile: agentsDeleteFile(files, optionsFor("deleteFile")),
    downloadFile: agentsDownloadFile(files, optionsFor("downloadFile")),
    getFileMetadata: agentsGetFileMetadata(
      files,
      optionsFor("getFileMetadata")
    ),
    getFileUrl: agentsGetFileUrl(files, optionsFor("getFileUrl")),
    listFiles: agentsListFiles(files, optionsFor("listFiles")),
    signUploadUrl: agentsSignUploadUrl(files, optionsFor("signUploadUrl")),
    uploadFile: agentsUploadFile(files, optionsFor("uploadFile")),
  };

  if (!readOnly) {
    return allTools;
  }

  // SAFETY: `allTools` holds exactly the FileToolName keys; dropping the
  // FileWriteToolName ones leaves exactly the FileReadToolName entries the
  // read-only shape declares.
  return Object.fromEntries(
    Object.entries(allTools).filter(([name]) => !isWriteTool(name))
  ) as ReadOnlyAgentsFileTools;
}

export type {
  FileReadToolName,
  FileToolName,
  FileWriteToolName,
} from "../internal/ai-tools/schemas.js";
