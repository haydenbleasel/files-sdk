// Resumable-upload driver shared by the GCS and Firebase Storage adapters —
// both sit on `@google-cloud/storage`'s `File`. `File.createResumableUpload()`
// returns a pre-authorized session URI; the actual chunk transfer is the
// generic offset-HTTP protocol (see `createOffsetHttpDriver`).

import type { File } from "@google-cloud/storage";

import type {
  OffsetResumableDriver,
  ResumableDriverOptions,
  ResumableUploadSession,
  UploadResult,
} from "../index.js";
import { resumableChunkSize } from "./core.js";
import { FilesError } from "./errors.js";
import { createOffsetHttpDriver } from "./resumable-offset-http.js";
import { trustedHttpsSessionUrl } from "./resumable-session-url.js";

const GCS_CHUNK_DEFAULT = 8 * 1024 * 1024;

interface GcsObjectMetadata {
  size?: string | number;
  contentType?: string;
  etag?: string;
  updated?: string;
}

const parseResult = async (
  res: Response,
  key: string
): Promise<UploadResult> => {
  const meta = (await res.json()) as GcsObjectMetadata;
  return {
    contentType: meta.contentType ?? "application/octet-stream",
    ...(meta.etag && { etag: meta.etag }),
    key,
    ...(meta.updated && { lastModified: new Date(meta.updated).getTime() }),
    size: Number(meta.size ?? 0),
  };
};

export const createGcsResumableDriver = (params: {
  file: File;
  bucket: string;
  key: string;
  opts: ResumableDriverOptions;
  wrapErr: (err: unknown) => FilesError;
}): OffsetResumableDriver => {
  const { file, bucket, key, opts, wrapErr } = params;
  return createOffsetHttpDriver({
    async open(meta) {
      const [uri] = await file.createResumableUpload({
        metadata: {
          contentType: meta.contentType,
          ...(opts.cacheControl && { cacheControl: opts.cacheControl }),
          ...(opts.metadata && { metadata: opts.metadata }),
        },
      });
      const trustedUri = trustedHttpsSessionUrl(
        uri,
        "gcs resumable session URL",
        ["storage.googleapis.com"]
      );
      return {
        session: {
          bucket,
          key,
          provider: "gcs",
          uri: trustedUri,
        },
        uri: trustedUri,
      };
    },
    parseResult: (res) => parseResult(res, key),
    partSize: resumableChunkSize(opts.multipart) ?? GCS_CHUNK_DEFAULT,
    resume(session: ResumableUploadSession): string {
      if (session.provider !== "gcs") {
        throw new FilesError(
          "Provider",
          `Cannot resume a ${session.provider} session on a GCS/Firebase adapter.`
        );
      }
      if (session.bucket !== bucket || session.key !== key) {
        throw new FilesError(
          "Provider",
          "Resume token does not match this upload's bucket/key."
        );
      }
      return trustedHttpsSessionUrl(session.uri, "gcs resumable session URL", [
        "storage.googleapis.com",
      ]);
    },
    wrapErr,
  });
};
