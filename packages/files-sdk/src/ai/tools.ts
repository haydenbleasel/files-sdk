import { tool } from "ai";
import { z } from "zod";

import type { Files } from "../index.js";
import { FilesError } from "../internal/errors.js";
import type { ToolOptions } from "./types.js";

/**
 * Default upper bound on `downloadFile` payload size. The tool boundary is
 * JSON, so anything larger than ~1 MiB is almost certainly a mistake (it
 * blows up the model context and the response payload). Callers can raise
 * the cap per-invocation via `maxBytes`.
 */
const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024;

const BASE64_CHUNK_SIZE = 0x80_00;

const base64ToBytes = (input: string): Uint8Array => {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    // atob() yields one code point per byte (0-255), so the nullish coalesce
    // is a type-safety floor — it can never actually trigger inside the loop.
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCodePoint(...chunk);
  }
  return btoa(binary);
};

export const listFiles = (files: Files) =>
  tool({
    description:
      "List files in the configured bucket, optionally filtered by key prefix. Returns paginated metadata with a continuation cursor.",
    execute: async ({ prefix, cursor, limit }) => {
      const result = await files.list({ cursor, limit, prefix });
      return {
        cursor: result.cursor,
        items: result.items.map((item) => ({
          etag: item.etag,
          key: item.key,
          lastModified: item.lastModified,
          size: item.size,
          type: item.type,
        })),
      };
    },
    inputSchema: z.object({
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
    }),
  });

export const getFileMetadata = (files: Files) =>
  tool({
    description:
      "Fetch metadata for a single file (size, content type, etag, custom metadata) without transferring its body.",
    execute: async ({ key }) => {
      const file = await files.head(key);
      return {
        etag: file.etag,
        key: file.key,
        lastModified: file.lastModified,
        metadata: file.metadata,
        size: file.size,
        type: file.type,
      };
    },
    inputSchema: z.object({
      key: z.string().describe("The object key to inspect"),
    }),
  });

export const downloadFile = (files: Files) =>
  tool({
    description:
      "Download a file and return its contents. Returns UTF-8 text by default; set binary=true to receive base64-encoded bytes. Files larger than maxBytes are rejected before transfer.",
    execute: async ({ key, maxBytes, binary }) => {
      const limit = maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
      const meta = await files.head(key);
      if (meta.size > limit) {
        throw new FilesError(
          "Provider",
          `File "${key}" is ${meta.size} bytes which exceeds the maxBytes limit of ${limit}. Pass a larger maxBytes or use getFileUrl to delegate to the client.`
        );
      }
      const file = await files.download(key);
      if (binary) {
        const buf = await file.arrayBuffer();
        return {
          content: bytesToBase64(new Uint8Array(buf)),
          encoding: "base64" as const,
          key: file.key,
          size: file.size,
          type: file.type,
        };
      }
      return {
        content: await file.text(),
        encoding: "text" as const,
        key: file.key,
        size: file.size,
        type: file.type,
      };
    },
    inputSchema: z.object({
      binary: z
        .boolean()
        .optional()
        .describe(
          "When true, returns base64-encoded bytes instead of UTF-8 text"
        ),
      key: z.string().describe("The object key to download"),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Reject downloads larger than this byte count (default ${DEFAULT_MAX_DOWNLOAD_BYTES}). Verified via head() before transferring.`
        ),
    }),
  });

export const getFileUrl = (files: Files) =>
  tool({
    description:
      "Return a URL the caller can use to fetch a file. Signing adapters return a presigned URL that expires after expiresIn seconds; permanent-CDN adapters (Vercel Blob public) return a permanent URL and ignore expiresIn.",
    execute: async ({ key, expiresIn, responseContentDisposition }) => {
      const url = await files.url(key, {
        expiresIn,
        responseContentDisposition,
      });
      return { key, url };
    },
    inputSchema: z.object({
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
    }),
  });

export const uploadFile = (
  files: Files,
  { needsApproval = true }: ToolOptions = {}
) =>
  tool({
    description:
      'Upload a file to the configured bucket. Pass content as UTF-8 text by default, or as base64 with encoding="base64" for binary payloads.',
    execute: async ({
      key,
      content,
      encoding,
      contentType,
      cacheControl,
      metadata,
    }) => {
      const body = encoding === "base64" ? base64ToBytes(content) : content;
      const result = await files.upload(key, body, {
        cacheControl,
        contentType,
        metadata,
      });
      return {
        contentType: result.contentType,
        etag: result.etag,
        key: result.key,
        lastModified: result.lastModified,
        size: result.size,
      };
    },
    inputSchema: z.object({
      cacheControl: z
        .string()
        .optional()
        .describe("Cache-Control header to store with the object"),
      content: z
        .string()
        .describe(
          'File body. Treated as UTF-8 text unless encoding is "base64".'
        ),
      contentType: z
        .string()
        .optional()
        .describe("MIME type recorded with the object"),
      encoding: z
        .enum(["text", "base64"])
        .optional()
        .describe("How to interpret content (default: text)"),
      key: z.string().describe("Destination object key"),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe("Custom string metadata to attach to the object"),
    }),
    needsApproval,
  });

export const deleteFile = (
  files: Files,
  { needsApproval = true }: ToolOptions = {}
) =>
  tool({
    description: "Permanently delete a file from the configured bucket.",
    execute: async ({ key }) => {
      await files.delete(key);
      return { deleted: true, key };
    },
    inputSchema: z.object({
      key: z.string().describe("Object key to delete"),
    }),
    needsApproval,
  });

export const copyFile = (
  files: Files,
  { needsApproval = true }: ToolOptions = {}
) =>
  tool({
    description:
      "Copy a file to a new key within the configured bucket. The source remains intact.",
    execute: async ({ from, to }) => {
      await files.copy(from, to);
      return { copied: true, from, to };
    },
    inputSchema: z.object({
      from: z.string().describe("Source object key"),
      to: z.string().describe("Destination object key"),
    }),
    needsApproval,
  });

export const signUploadUrl = (
  files: Files,
  { needsApproval = true }: ToolOptions = {}
) =>
  tool({
    description:
      "Issue a presigned URL that lets a client upload directly to the configured bucket. Approval-gated by default — the URL grants upload permission until it expires.",
    execute: ({ key, expiresIn, contentType, maxSize, minSize }) =>
      files.signedUploadUrl(key, {
        contentType,
        expiresIn,
        maxSize,
        minSize,
      }),
    inputSchema: z.object({
      contentType: z
        .string()
        .optional()
        .describe("Content-Type that the upload must declare"),
      expiresIn: z
        .number()
        .int()
        .positive()
        .describe("Lifetime of the presigned URL in seconds"),
      key: z.string().describe("Destination object key"),
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
    }),
    needsApproval,
  });
