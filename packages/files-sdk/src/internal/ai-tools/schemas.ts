import { z } from "zod";

/**
 * Default upper bound on `downloadFile` payload size. The tool boundary is
 * JSON, so anything larger than ~1 MiB is almost certainly a mistake (it
 * blows up the model context and the response payload). Callers can raise
 * the cap per-invocation via `maxBytes`, up to MAX_DOWNLOAD_BYTES.
 */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

const DESTINATION_KEY_DESC = "Destination object key";

const listFilesInput = z.object({
  cursor: z
    .string()
    .optional()
    .describe("Continuation cursor returned by a previous call"),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum number of items to return"),
  prefix: z
    .string()
    .optional()
    .describe("Only return keys that start with this prefix"),
});

const getFileMetadataInput = z.object({
  key: z.string().describe("The object key to inspect"),
});

const downloadFileInput = z.object({
  binary: z
    .boolean()
    .optional()
    .describe("When true, returns base64-encoded bytes instead of UTF-8 text"),
  key: z.string().describe("The object key to download"),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_DOWNLOAD_BYTES)
    .optional()
    .describe(
      `Reject downloads larger than this byte count (default ${DEFAULT_MAX_DOWNLOAD_BYTES}, maximum ${MAX_DOWNLOAD_BYTES}). Verified via head() before transferring.`
    ),
});

const getFileUrlInput = z.object({
  expiresIn: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Override the adapter default URL expiry in seconds. Ignored by permanent-CDN adapters."
    ),
  key: z.string().describe("The object key to build a URL for"),
  responseContentDisposition: z
    .string()
    .optional()
    .describe(
      "Force a Content-Disposition header on the response (e.g. 'attachment; filename=\"f.txt\"'). Strongly recommended for user-uploaded content to prevent inline rendering of HTML/SVG."
    ),
});

const uploadFileInput = z.object({
  cacheControl: z
    .string()
    .optional()
    .describe("Cache-Control header to store with the object"),
  content: z
    .string()
    .describe('File body. Treated as UTF-8 text unless encoding is "base64".'),
  contentType: z
    .string()
    .optional()
    .describe("MIME type recorded with the object"),
  encoding: z
    .enum(["text", "base64"])
    .optional()
    .describe("How to interpret content (default: text)"),
  key: z.string().describe(DESTINATION_KEY_DESC),
  metadata: z
    .record(z.string(), z.string())
    .optional()
    .describe("Custom string metadata to attach to the object"),
});

const deleteFileInput = z.object({
  key: z.string().describe("Object key to delete"),
});

const copyFileInput = z.object({
  from: z.string().describe("Source object key"),
  to: z.string().describe(DESTINATION_KEY_DESC),
});

const signUploadUrlInput = z.object({
  contentType: z
    .string()
    .optional()
    .describe("Content-Type that the upload must declare"),
  expiresIn: z
    .number()
    .int()
    .positive()
    .describe("Lifetime of the presigned URL in seconds"),
  key: z.string().describe(DESTINATION_KEY_DESC),
  maxSize: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum upload size in bytes. When set, the adapter falls back to a presigned POST whose policy enforces the size server-side. When omitted, a presigned PUT with no size limit is returned."
    ),
  minSize: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Minimum upload size in bytes for the presigned POST policy. Defaults to 1; pass 0 to allow empty uploads. Only used when maxSize is set."
    ),
});

export const TOOL_SCHEMAS = {
  copyFile: {
    description:
      "Copy a file to a new key within the configured bucket. The source remains intact.",
    input: copyFileInput,
  },
  deleteFile: {
    description: "Permanently delete a file from the configured bucket.",
    input: deleteFileInput,
  },
  downloadFile: {
    description:
      "Download a file and return its contents. Returns UTF-8 text by default; set binary=true to receive base64-encoded bytes. Files larger than maxBytes are rejected before transfer.",
    input: downloadFileInput,
  },
  getFileMetadata: {
    description:
      "Fetch metadata for a single file (size, content type, etag, custom metadata) without transferring its body.",
    input: getFileMetadataInput,
  },
  getFileUrl: {
    description:
      "Return a URL the caller can use to fetch a file. Signing adapters return a presigned URL that expires after expiresIn seconds; permanent-CDN adapters (Vercel Blob public) return a permanent URL and ignore expiresIn.",
    input: getFileUrlInput,
  },
  listFiles: {
    description:
      "List files in the configured bucket, optionally filtered by key prefix. Returns paginated metadata with a continuation cursor.",
    input: listFilesInput,
  },
  signUploadUrl: {
    description:
      "Issue a presigned URL that lets a client upload directly to the configured bucket. Approval-gated by default — the URL grants upload permission until it expires.",
    input: signUploadUrlInput,
  },
  uploadFile: {
    description:
      'Upload a file to the configured bucket. Pass content as UTF-8 text by default, or as base64 with encoding="base64" for binary payloads.',
    input: uploadFileInput,
  },
} as const;

export type FileToolName = keyof typeof TOOL_SCHEMAS;

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

export const WRITE_TOOL_NAMES: ReadonlySet<FileWriteToolName> = new Set([
  "uploadFile",
  "deleteFile",
  "copyFile",
  "signUploadUrl",
]);

export type ListFilesInput = z.infer<typeof listFilesInput>;
export type GetFileMetadataInput = z.infer<typeof getFileMetadataInput>;
export type DownloadFileInput = z.infer<typeof downloadFileInput>;
export type GetFileUrlInput = z.infer<typeof getFileUrlInput>;
export type UploadFileInput = z.infer<typeof uploadFileInput>;
export type DeleteFileInput = z.infer<typeof deleteFileInput>;
export type CopyFileInput = z.infer<typeof copyFileInput>;
export type SignUploadUrlInput = z.infer<typeof signUploadUrlInput>;
