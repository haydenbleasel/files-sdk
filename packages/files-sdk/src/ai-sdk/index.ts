import type { Files } from "../index.js";
import { resolveApproval } from "../internal/ai-tools/approval.js";
import type { ApprovalConfig } from "../internal/ai-tools/approval.js";
import { WRITE_TOOL_NAMES } from "../internal/ai-tools/schemas.js";
import type {
  FileReadToolName,
  FileToolName,
  FileWriteToolName,
} from "../internal/ai-tools/schemas.js";
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

export type {
  ApprovalConfig,
  FileReadToolName,
  FileToolName,
  FileWriteToolName,
};

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
  /**
   * Paginated list of objects with optional `prefix`, `cursor`, and `limit`.
   * Returns metadata-only entries (`key`, `size`, `type`, `lastModified`,
   * `etag`) plus a continuation cursor.
   */
  listFiles: ReturnType<typeof listFiles>;
  /**
   * Fetch metadata for a single key without transferring the body. Wraps
   * `files.head(key)`; returns size, content type, etag, and any custom
   * metadata.
   */
  getFileMetadata: ReturnType<typeof getFileMetadata>;
  /**
   * Download an object and return its contents. Accepts a `maxBytes` guard
   * (default 1 MiB) checked via `head()` _before_ any transfer — JSON tool
   * boundaries don't love multi-megabyte payloads. Returns UTF-8 text by
   * default; pass `binary: true` to receive base64-encoded bytes for
   * non-text files.
   */
  downloadFile: ReturnType<typeof downloadFile>;
  /**
   * Build a URL for the object. Forwards `expiresIn` and
   * `responseContentDisposition` straight to `files.url()` — handy for
   * letting the model hand the user a download link instead of streaming
   * bytes back through the tool boundary.
   */
  getFileUrl: ReturnType<typeof getFileUrl>;
  /**
   * Upload a file. Accepts `content: string` plus an optional
   * `encoding: "text" | "base64"` — base64 is decoded before upload so
   * binary payloads stay JSON-safe at the tool boundary. Forwards
   * `contentType`, `cacheControl`, and `metadata`. **Approval-gated.**
   */
  uploadFile: ReturnType<typeof uploadFile>;
  /** Permanently delete an object. **Approval-gated.** */
  deleteFile: ReturnType<typeof deleteFile>;
  /**
   * Copy an object to a new key within the same bucket. The source remains
   * intact. **Approval-gated.**
   */
  copyFile: ReturnType<typeof copyFile>;
  /**
   * Issue a presigned URL the model can hand back to the client for a
   * direct upload. Approval-gated by default — even though no bytes move
   * during the tool call itself, issuing the URL grants upload permission
   * until `expiresIn` elapses.
   */
  signUploadUrl: ReturnType<typeof signUploadUrl>;
}

export type ReadOnlyFileTools = Pick<FileTools, FileReadToolName>;

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
