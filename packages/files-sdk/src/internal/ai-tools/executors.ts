import type { Files } from "../../index.js";
import { FilesError } from "../errors.js";
import { DEFAULT_MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_BYTES } from "./schemas.js";
import type {
  CopyFileInput,
  DeleteFileInput,
  DownloadFileInput,
  GetFileMetadataInput,
  GetFileUrlInput,
  ListFilesInput,
  SignUploadUrlInput,
  UploadFileInput,
} from "./schemas.js";

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

export const executors = {
  copyFile: async (files: Files, { from, to }: CopyFileInput) => {
    await files.copy(from, to);
    return { copied: true as const, from, to };
  },

  deleteFile: async (files: Files, { key }: DeleteFileInput) => {
    await files.delete(key);
    return { deleted: true as const, key };
  },

  downloadFile: async (
    files: Files,
    { key, maxBytes, binary }: DownloadFileInput
  ) => {
    const limit = maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    if (limit > MAX_DOWNLOAD_BYTES) {
      throw new FilesError(
        "Provider",
        `maxBytes must be less than or equal to ${MAX_DOWNLOAD_BYTES}. Use getFileUrl to delegate larger downloads to the client.`
      );
    }
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

  getFileMetadata: async (files: Files, { key }: GetFileMetadataInput) => {
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

  getFileUrl: async (
    files: Files,
    { key, expiresIn, responseContentDisposition }: GetFileUrlInput
  ) => {
    const url = await files.url(key, {
      expiresIn,
      responseContentDisposition,
    });
    return { key, url };
  },

  listFiles: async (
    files: Files,
    { prefix, cursor, limit }: ListFilesInput
  ) => {
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

  signUploadUrl: (
    files: Files,
    { key, expiresIn, contentType, maxSize, minSize }: SignUploadUrlInput
  ) =>
    files.signedUploadUrl(key, {
      contentType,
      expiresIn,
      maxSize,
      minSize,
    }),

  uploadFile: async (
    files: Files,
    {
      key,
      content,
      encoding,
      contentType,
      cacheControl,
      metadata,
    }: UploadFileInput
  ) => {
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
} as const;
