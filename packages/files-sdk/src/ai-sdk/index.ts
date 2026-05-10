import type { Files } from "../index.js";
import {
  copyFile,
  deleteFile,
  downloadFile,
  getFileMetadata,
  getFileUrl,
  listFiles,
  signUploadUrl,
  uploadFile,
} from "./tools.js";
import type { ToolOverrides } from "./types.js";

export type FileReadToolName =
  | "listFiles"
  | "getFileMetadata"
  | "downloadFile"
  | "getFileUrl";

export type FileWriteToolName =
  | "uploadFile"
  | "deleteFile"
  | "copyFile"
  | "signUploadUrl";

export type FileToolName = FileReadToolName | FileWriteToolName;

/**
 * Whether write operations require user approval.
 *
 * - `true` — all write tools need approval (default)
 * - `false` — no approval needed for any write tool
 * - object — per-tool override; unspecified write tools default to `true`
 *
 * @example
 * ```ts
 * requireApproval: {
 *   deleteFile: true,
 *   uploadFile: false,
 *   copyFile: false,
 * }
 * ```
 */
export type ApprovalConfig =
  | boolean
  | Partial<Record<FileWriteToolName, boolean>>;

export interface FileToolsOptions {
  /**
   * The configured `Files` instance the tools will operate against.
   * Each tool delegates to the methods on this instance, inheriting its
   * adapter, key validation, and `FilesError` wrapping.
   */
  files: Files;
  /**
   * When `true`, write tools (`uploadFile`, `deleteFile`, `copyFile`,
   * `signUploadUrl`) are omitted entirely. The model cannot mutate the
   * bucket regardless of approval configuration.
   */
  readOnly?: boolean;
  /**
   * Approval gating for write tools. Defaults to `true` (all writes
   * require approval). See {@link ApprovalConfig}.
   */
  requireApproval?: ApprovalConfig;
  /**
   * Per-tool overrides for customizing tool behavior (description, title,
   * needsApproval, etc.) without changing the underlying implementation.
   * `execute`, `inputSchema`, and `outputSchema` cannot be overridden.
   *
   * @example
   * ```ts
   * createFileTools({
   *   files,
   *   overrides: {
   *     deleteFile: { needsApproval: false },
   *     listFiles: { description: "List user uploads in the current tenant" },
   *   },
   * })
   * ```
   */
  overrides?: Partial<Record<FileToolName, ToolOverrides>>;
}

export interface FileTools {
  listFiles: ReturnType<typeof listFiles>;
  getFileMetadata: ReturnType<typeof getFileMetadata>;
  downloadFile: ReturnType<typeof downloadFile>;
  getFileUrl: ReturnType<typeof getFileUrl>;
  uploadFile: ReturnType<typeof uploadFile>;
  deleteFile: ReturnType<typeof deleteFile>;
  copyFile: ReturnType<typeof copyFile>;
  signUploadUrl: ReturnType<typeof signUploadUrl>;
}

export type ReadOnlyFileTools = Pick<FileTools, FileReadToolName>;

const WRITE_TOOL_NAMES: ReadonlySet<FileWriteToolName> = new Set([
  "uploadFile",
  "deleteFile",
  "copyFile",
  "signUploadUrl",
]);

const resolveApproval = (
  toolName: FileWriteToolName,
  config: ApprovalConfig
): boolean => {
  if (typeof config === "boolean") {
    return config;
  }
  return config[toolName] ?? true;
};

/**
 * Create a set of files-sdk tools for the Vercel AI SDK.
 *
 * Write operations require user approval by default. Control globally or
 * per-tool via `requireApproval`, or strip writes entirely with
 * `readOnly: true`.
 *
 * @example
 * ```ts
 * import { Files } from "files-sdk";
 * import { createFileTools } from "files-sdk/ai-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { generateText } from "ai";
 *
 * const files = new Files({ adapter: s3({ bucket: "uploads" }) });
 *
 * const result = await generateText({
 *   model: yourModel,
 *   tools: createFileTools({ files }),
 *   prompt: "Find every CSV under reports/ and summarize the latest one.",
 * });
 * ```
 *
 * @example Read-only agent
 * ```ts
 * createFileTools({ files, readOnly: true })
 * ```
 *
 * @example Granular approval
 * ```ts
 * createFileTools({
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
export function createFileTools(
  opts: FileToolsOptions & { readOnly: true }
): ReadOnlyFileTools;
export function createFileTools(
  opts: FileToolsOptions & { readOnly?: false | undefined }
): FileTools;
export function createFileTools(
  opts: FileToolsOptions
): FileTools | ReadOnlyFileTools;
export function createFileTools({
  files,
  readOnly = false,
  requireApproval = true,
  overrides,
}: FileToolsOptions): FileTools | ReadOnlyFileTools {
  const approval = (name: FileWriteToolName) => ({
    needsApproval: resolveApproval(name, requireApproval),
  });

  const allTools: FileTools = {
    copyFile: copyFile(files, approval("copyFile")),
    deleteFile: deleteFile(files, approval("deleteFile")),
    downloadFile: downloadFile(files),
    getFileMetadata: getFileMetadata(files),
    getFileUrl: getFileUrl(files),
    listFiles: listFiles(files),
    signUploadUrl: signUploadUrl(files, approval("signUploadUrl")),
    uploadFile: uploadFile(files, approval("uploadFile")),
  };

  if (overrides) {
    for (const [name, toolOverrides] of Object.entries(overrides)) {
      if (name in allTools && toolOverrides) {
        const key = name as keyof FileTools;
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
  ) as ReadOnlyFileTools;
}

export type { ToolOptions, ToolOverrides } from "./types.js";
export {
  copyFile,
  deleteFile,
  downloadFile,
  getFileMetadata,
  getFileUrl,
  listFiles,
  signUploadUrl,
  uploadFile,
} from "./tools.js";
