import { AppwriteException, Client, Query, Storage } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

import type {
  Adapter,
  Body,
  DownloadOptions,
  ListOptions,
  ListResult,
  OffsetResumableDriver,
  ResumableUploadSession,
  StoredFile,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from "../index.js";
import {
  collectStream,
  existsByProbe,
  makeErrorMapper,
  normalizeBody as coreNormalizeBody,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
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

const EMPTY_CODES: ReadonlySet<string> = new Set();

// Appwrite classifies purely by HTTP status — its `AppwriteException` exposes
// the response code on `err.code`. The shared mapper expects `status`, so
// hoist `code` into `status` here. Non-`AppwriteException` errors fall through
// to the `Provider` bucket.
export const mapAppwriteError = makeErrorMapper({
  codes: {
    conflict: EMPTY_CODES,
    notFound: EMPTY_CODES,
    unauthorized: EMPTY_CODES,
  },
  extract: (err) => {
    if (err instanceof AppwriteException) {
      return {
        ...(err.message && { message: err.message }),
        ...(typeof err.code === "number" && { status: err.code }),
      };
    }
    return {};
  },
  providerLabel: "Appwrite error",
});

// Appwrite custom file IDs: max 36 chars, must start with alphanumeric,
// remaining chars are alphanumeric/`.`/`-`/`_`. Surfaced as a clear FilesError
// before hitting the API so callers see what's wrong instead of an opaque 400.
const APPWRITE_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/u;

const assertAppwriteKey = (key: string, label = "key"): void => {
  if (!APPWRITE_KEY_RE.test(key)) {
    throw new FilesError(
      "Provider",
      `appwrite: ${label} "${key}" is not a valid Appwrite file ID — must be 1-36 chars, start with [a-zA-Z0-9], and use only [a-zA-Z0-9._-] (no slashes).`
    );
  }
};

const isSupportedBody = (body: unknown): body is Body =>
  typeof body === "string" ||
  body instanceof Uint8Array ||
  body instanceof ArrayBuffer ||
  ArrayBuffer.isView(body) ||
  body instanceof Blob ||
  body instanceof ReadableStream;

// `InputFile.fromBuffer` has no streaming form, so streamed bodies must be
// drained up-front. Other Body shapes already arrive as `Uint8Array` from
// the shared helper.
const toInputFile = async (body: Body, filename: string): Promise<unknown> => {
  if (!isSupportedBody(body)) {
    throw new FilesError(
      "Provider",
      "Unsupported body type for Appwrite adapter"
    );
  }
  const { data } = await coreNormalizeBody(body);
  const bytes =
    data instanceof ReadableStream ? await collectStream(data) : data;
  return InputFile.fromBuffer(Buffer.from(bytes), filename);
};

const isStorageInstance = (candidate: unknown): candidate is Storage =>
  typeof candidate === "object" &&
  candidate !== null &&
  "createFile" in candidate &&
  typeof (candidate as { createFile?: unknown }).createFile === "function";

export const appwrite = (opts: AppwriteAdapterOptions): AppwriteAdapter => {
  let storage: Storage;
  let { endpoint, projectId } = opts;
  // Captured for the raw chunked (resumable) upload path, which the node SDK
  // doesn't expose. Only available when the adapter builds its own client from
  // an API key — a pre-built `client` keeps its key private, so resumable
  // throws there.
  let apiKey: string | undefined;

  if (opts.client) {
    if (isStorageInstance(opts.client)) {
      storage = opts.client;
      const innerClient = storage.client;
      if (innerClient?.config) {
        endpoint ??= innerClient.config.endpoint;
        projectId ??= innerClient.config.project;
      }
    } else {
      const { client } = opts;
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
    apiKey = key;

    if (!projectId) {
      throw new FilesError(
        "Provider",
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

  // `contentType` is silently dropped — Appwrite's createFile auto-detects
  // mime from the payload and has no override. `cacheControl` and
  // `metadata` throw at upload time (Appwrite has no equivalent fields),
  // matching the dropbox/box pattern instead of swallowing a caller's
  // explicit intent. Documented on the adapter's limitations section.
  return {
    bucket: opts.bucket,
    copy: async (from: string, to: string) => {
      assertAppwriteKey(to, "copy destination");
      try {
        // Use `to` as the InputFile filename rather than fetching the
        // source's display name — saves a roundtrip per copy. Appwrite's
        // storage identity is the file ID, and the destination key is
        // already what callers expect to see.
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
        const limit = listOpts?.limit ?? DEFAULT_LIST_LIMIT;
        const queries: string[] = [Query.limit(limit)];

        if (listOpts?.prefix) {
          // Query on `$id` (the canonical key) rather than `name` (Appwrite's
          // display filename). For SDK-controlled flows the two are equal —
          // `upload()` sets both to the user-supplied key — but for files
          // created via the console or REST they can diverge, and filtering
          // on the field we don't return would leak unrelated results.
          queries.push(Query.startsWith("$id", listOpts.prefix));
        }
        if (listOpts?.cursor) {
          queries.push(Query.cursorAfter(listOpts.cursor));
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
    resumableUpload(key, resumableOpts): OffsetResumableDriver {
      assertAppwriteKey(key);
      if (resumableOpts.cacheControl) {
        throw new FilesError(
          "Provider",
          "appwrite: `cacheControl` is not supported."
        );
      }
      if (
        resumableOpts.metadata &&
        Object.keys(resumableOpts.metadata).length > 0
      ) {
        throw new FilesError(
          "Provider",
          "appwrite: `metadata` is not supported."
        );
      }
      let session:
        | Extract<ResumableUploadSession, { provider: "appwrite" }>
        | undefined;
      let finalFile:
        | { $id: string; mimeType?: string; sizeOriginal?: number }
        | undefined;
      let contentType = "application/octet-stream";
      const requireConfig = () => {
        if (!(endpoint && projectId && apiKey)) {
          throw new FilesError(
            "Provider",
            "appwrite: resumable uploads require an API key with endpoint/projectId — a pre-built `client` doesn't expose its key."
          );
        }
        return { apiKey, endpoint, projectId };
      };
      const requireSession = () => {
        if (!session) {
          throw new FilesError(
            "Provider",
            "appwrite: resumable upload not started."
          );
        }
        return session;
      };
      return {
        adopt(adopted: ResumableUploadSession) {
          if (adopted.provider !== "appwrite") {
            throw new FilesError(
              "Provider",
              `Cannot resume a ${adopted.provider} session on an appwrite adapter.`
            );
          }
          if (adopted.key !== key) {
            throw new FilesError(
              "Provider",
              "Resume token does not match this upload's key."
            );
          }
          session = adopted;
          ({ contentType } = adopted);
        },
        begin(meta): Promise<ResumableUploadSession> {
          ({ contentType } = meta);
          session = {
            contentType,
            fileId: key,
            key,
            offset: 0,
            provider: "appwrite",
          };
          return Promise.resolve(session);
        },
        complete(): Promise<UploadResult> {
          // `uploadAt` records every chunk's response, and the orchestrator
          // always sends at least one chunk before completing, so `finalFile`
          // is the last (complete) file. Fall back to the session for safety.
          const current = requireSession();
          return Promise.resolve({
            contentType: finalFile?.mimeType ?? contentType,
            key: finalFile?.$id ?? current.fileId,
            size: finalFile?.sizeOriginal ?? current.offset,
          });
        },
        async discard() {
          try {
            await storage.deleteFile({ bucketId: opts.bucket, fileId: key });
          } catch {
            // Best-effort — a partial chunked upload may not be deletable.
          }
        },
        mode: "offset",
        // Appwrite's chunked upload uses a fixed 5 MiB chunk; every chunk but
        // the last must be exactly that size, so this isn't caller-tunable.
        partSize: 5 * 1024 * 1024,
        probe(): Promise<{ nextOffset: number }> {
          return Promise.resolve({ nextOffset: requireSession().offset });
        },
        async uploadAt({ offset, data, total, signal }): Promise<{
          nextOffset: number;
        }> {
          const cfg = requireConfig();
          const current = requireSession();
          const form = new FormData();
          form.append("fileId", current.fileId);
          form.append("file", new Blob([data as unknown as BlobPart]), key);
          const res = await fetch(
            `${cfg.endpoint}/storage/buckets/${opts.bucket}/files`,
            {
              body: form,
              headers: {
                "Content-Range": `bytes ${offset}-${offset + data.byteLength - 1}/${total}`,
                "X-Appwrite-ID": current.fileId,
                "X-Appwrite-Key": cfg.apiKey,
                "X-Appwrite-Project": cfg.projectId,
              },
              method: "POST",
              ...(signal && { signal }),
            }
          );
          if (!res.ok) {
            const text = await res.text();
            throw new FilesError(
              "Provider",
              `appwrite: chunk upload failed (HTTP ${res.status}): ${text}`.trim()
            );
          }
          finalFile = (await res.json()) as typeof finalFile;
          const nextOffset = offset + data.byteLength;
          current.offset = nextOffset;
          return { nextOffset };
        },
      };
    },
    signedUploadUrl: (_key: string, _opts: unknown) =>
      Promise.reject(
        new FilesError(
          "Provider",
          "appwrite: signedUploadUrl is not supported. Appwrite has no presigned upload primitive — use a JWT or the client SDK for direct uploads."
        )
      ),
    upload: async (key: string, body: Body, uploadOpts?: UploadOptions) => {
      assertAppwriteKey(key);
      if (uploadOpts?.cacheControl) {
        throw new FilesError(
          "Provider",
          "appwrite: `cacheControl` is not supported. Appwrite does not expose HTTP cache headers on file content."
        );
      }
      if (uploadOpts?.metadata && Object.keys(uploadOpts.metadata).length > 0) {
        throw new FilesError(
          "Provider",
          "appwrite: `metadata` is not supported. Appwrite's `createFile` has no arbitrary-metadata field; drop to `raw` if you need to attach metadata via a separate API."
        );
      }
      try {
        const inputFile = await toInputFile(body, key);

        // Cast: the SDK types `file` as the DOM `File`, but at runtime
        // accepts the Node `InputFile` returned by `InputFile.fromBuffer`.
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
          new FilesError(
            "Provider",
            "appwrite: url() is not supported. Appwrite SDKs cannot mint signed read URLs with API keys — set { public: true } on the adapter for a public bucket to return a permanent view URL."
          )
        );
      }
      if (!endpoint || !projectId) {
        return Promise.reject(
          new FilesError(
            "Provider",
            "appwrite: missing endpoint or projectId required for URL generation"
          )
        );
      }
      return Promise.resolve(
        `${endpoint}/storage/buckets/${opts.bucket}/files/${key}/view?project=${projectId}`
      );
    },
  };
};
