import { AppwriteException, Client, Storage } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

import type {
  Adapter,
  Body,
  DownloadOptions,
  ListOptions,
  ListResult,
  StoredFile,
  UploadOptions,
  UrlOptions,
} from "../index.js";
import { existsByProbe } from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import type { FilesErrorCode } from "../internal/errors.js";
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface AppwriteAdapterOptions {
  /**
   * Appwrite storage bucket ID.
   */
  bucket: string;
  /**
   * Existing client instance or Storage instance.
   * Highest precedence.
   */
  client?: Client | Storage;
  /**
   * Appwrite API endpoint (e.g. `https://cloud.appwrite.io/v1`).
   * Falls back to `APPWRITE_ENDPOINT` then `NEXT_PUBLIC_APPWRITE_ENDPOINT`.
   */
  endpoint?: string;
  /**
   * Appwrite Project ID.
   * Falls back to `APPWRITE_PROJECT_ID` then `NEXT_PUBLIC_APPWRITE_PROJECT_ID`.
   */
  projectId?: string;
  /**
   * Appwrite API Key.
   * Falls back to `APPWRITE_API_KEY` then `APPWRITE_KEY`.
   */
  key?: string;
  /**
   * Set to `true` if the bucket is configured as a public bucket.
   * `url()` will then return a constructed permanent, unsigned URL.
   * Otherwise, `url()` throws an error.
   */
  public?: boolean;
}

export type AppwriteAdapter = Adapter<Storage> & {
  readonly bucket: string;
};

const DEFAULT_LIST_LIMIT = 100;

const NOT_FOUND_CODES = new Set([404]);
const UNAUTH_CODES = new Set([401, 403]);
const CONFLICT_CODES = new Set([409]);

const classifyAppwriteError = (status?: number): FilesErrorCode => {
  if (status && NOT_FOUND_CODES.has(status)) {
    return "NotFound";
  }
  if (status && UNAUTH_CODES.has(status)) {
    return "Unauthorized";
  }
  if (status && CONFLICT_CODES.has(status)) {
    return "Conflict";
  }
  return "Provider";
};

const DEFAULT_MESSAGES: Record<FilesErrorCode, string> = {
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: "Appwrite error",
  Unauthorized: "Unauthorized",
};

export const mapAppwriteError = (err?: unknown): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  if (err instanceof AppwriteException) {
    const code = classifyAppwriteError(err.code);
    return new FilesError(code, err.message ?? DEFAULT_MESSAGES[code], err);
  }
  const code = "Provider";
  return new FilesError(code, DEFAULT_MESSAGES[code], err);
};

const normalizeBody = async (
  body: Body,
  filename: string,
  _contentTypeHint?: string
): Promise<unknown> => {
  let data: Uint8Array;

  if (typeof body === "string") {
    data = new TextEncoder().encode(body);
  } else if (body instanceof Blob) {
    data = new Uint8Array(await body.arrayBuffer());
  } else if (body instanceof Uint8Array) {
    data = body;
  } else if (body instanceof ArrayBuffer) {
    data = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    data = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    data = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
  } else {
    throw new FilesError(
      "Provider",
      "Unsupported body type for Appwrite adapter",
      null
    );
  }

  return InputFile.fromBuffer(Buffer.from(data), filename);
};

const isStorageInstance = (candidate: unknown): candidate is Storage =>
  typeof candidate === "object" &&
  candidate !== null &&
  "createFile" in candidate &&
  typeof (candidate as { createFile?: unknown }).createFile === "function";

export const createAppwriteAdapter = (
  opts: AppwriteAdapterOptions
): AppwriteAdapter => {
  let storage: Storage;
  let { endpoint, projectId } = opts;

  if (opts.client) {
    if (isStorageInstance(opts.client)) {
      storage = opts.client;
      const { client } = storage as unknown as { client?: Client };
      if (client?.config) {
        endpoint ??= client.config.endpoint;
        projectId ??= client.config.project;
      }
    } else {
      const client = opts.client as Client;
      storage = new Storage(client);
      if (client.config) {
        endpoint ??= client.config.endpoint;
        projectId ??= client.config.project;
      }
    }
  } else {
    endpoint ??=
      readEnv("APPWRITE_ENDPOINT") ??
      readEnv("NEXT_PUBLIC_APPWRITE_ENDPOINT") ??
      "https://cloud.appwrite.io/v1";

    projectId ??=
      readEnv("APPWRITE_PROJECT_ID") ??
      readEnv("NEXT_PUBLIC_APPWRITE_PROJECT_ID");

    const key =
      opts.key ?? readEnv("APPWRITE_API_KEY") ?? readEnv("APPWRITE_KEY");

    if (!projectId) {
      throw new Error(
        "Appwrite adapter requires a projectId or an existing client"
      );
    }

    const client = new Client();
    client.setEndpoint(endpoint).setProject(projectId);
    if (key) {
      client.setKey(key);
    }

    storage = new Storage(client);
  }

  return {
    bucket: opts.bucket,
    copy: async (from: string, to: string) => {
      try {
        const buffer = await storage.getFileDownload({
          bucketId: opts.bucket,
          fileId: from,
        });

        const inputFile = InputFile.fromBuffer(Buffer.from(buffer), to);
        await storage.createFile({
          bucketId: opts.bucket,
          file: inputFile as unknown as File,
          fileId: to,
        });
      } catch (error) {
        throw mapAppwriteError(error);
      }
    },
    delete: async (key: string) => {
      try {
        await storage.deleteFile({ bucketId: opts.bucket, fileId: key });
      } catch (error) {
        throw mapAppwriteError(error);
      }
    },
    download: async (key: string, _opts?: DownloadOptions) => {
      try {
        const [stat, buffer] = await Promise.all([
          storage.getFile({ bucketId: opts.bucket, fileId: key }),
          storage.getFileDownload({ bucketId: opts.bucket, fileId: key }),
        ]);

        return createStoredFile(
          {
            key,
            size: stat.sizeOriginal,
            type: stat.mimeType,
          },
          { data: new Uint8Array(buffer), kind: "buffer" }
        );
      } catch (error) {
        throw mapAppwriteError(error);
      }
    },
    exists(key: string) {
      return existsByProbe(
        () => storage.getFile({ bucketId: opts.bucket, fileId: key }),
        mapAppwriteError
      );
    },
    head: async (key: string) => {
      try {
        const stat = await storage.getFile({
          bucketId: opts.bucket,
          fileId: key,
        });
        return createStoredFile(
          {
            key,
            size: stat.sizeOriginal,
            type: stat.mimeType,
          },
          {
            factory: async () => {
              const buffer = await storage.getFileDownload({
                bucketId: opts.bucket,
                fileId: key,
              });
              return new Uint8Array(buffer);
            },
            kind: "lazy",
          }
        );
      } catch (error) {
        throw mapAppwriteError(error);
      }
    },
    list: async (listOpts?: ListOptions): Promise<ListResult> => {
      try {
        const queries: string[] = [];
        const limit = listOpts?.limit ?? DEFAULT_LIST_LIMIT;
        queries.push(`limit(${limit})`);

        if (listOpts?.cursor) {
          queries.push(`cursorAfter("${listOpts.cursor}")`);
        }

        const response = await storage.listFiles({
          bucketId: opts.bucket,
          queries,
        });

        const items: StoredFile[] = response.files.map((file) =>
          createStoredFile(
            {
              key: file.$id,
              size: file.sizeOriginal,
              type: file.mimeType,
            },
            {
              factory: async () => {
                const buffer = await storage.getFileDownload({
                  bucketId: opts.bucket,
                  fileId: file.$id,
                });
                return new Uint8Array(buffer);
              },
              kind: "lazy",
            }
          )
        );

        let nextCursor: string | undefined;
        if (response.files.length === limit) {
          nextCursor = response.files.at(-1)?.$id;
        }

        return {
          cursor: nextCursor,
          items,
        };
      } catch (error) {
        throw mapAppwriteError(error);
      }
    },
    name: "appwrite",
    raw: storage,
    signedUploadUrl: (_key: string, _opts: unknown) =>
      Promise.reject(new FilesError("Provider", "unsupported_operation", null)),
    upload: async (key: string, body: Body, uploadOpts?: UploadOptions) => {
      try {
        const inputFile = await normalizeBody(
          body,
          key,
          uploadOpts?.contentType
        );

        const response = await storage.createFile({
          bucketId: opts.bucket,
          file: inputFile as unknown as File,
          fileId: key,
        });

        return {
          contentType: response.mimeType,
          key: response.$id,
          size: response.sizeOriginal,
        };
      } catch (error) {
        throw mapAppwriteError(error);
      }
    },
    url: (key: string, _urlOpts?: UrlOptions) => {
      if (!opts.public) {
        return Promise.reject(
          new FilesError("Provider", "unsupported_operation", null)
        );
      }
      if (!endpoint || !projectId) {
        return Promise.reject(
          new FilesError(
            "Provider",
            "Missing endpoint or projectId required for URL generation",
            null
          )
        );
      }
      return Promise.resolve(
        `${endpoint}/storage/buckets/${opts.bucket}/files/${key}/view?project=${projectId}`
      );
    },
  };
};
