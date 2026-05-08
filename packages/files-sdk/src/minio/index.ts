import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface MinioAdapterOptions {
  bucket: string;
  endpoint: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` — appropriate for a public bucket policy or
   * a reverse proxy in front of MinIO. When unset, `url()` falls back to
   * a presigned GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by
   * `url()` when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type MinioAdapter = Adapter<S3Client>;

export const minio = (opts: MinioAdapterOptions): MinioAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("MINIO_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("MINIO_SECRET_ACCESS_KEY");

  if (!opts.endpoint) {
    throw new FilesError(
      "Provider",
      "minio adapter: missing endpoint. Pass `endpoint` (e.g. http://localhost:9000)."
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "minio adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set MINIO_ACCESS_KEY_ID + MINIO_SECRET_ACCESS_KEY."
    );
  }

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // MinIO is wire-compatible with S3 but self-hosted; relabel the default
    // provider message so users don't see "S3 error" from their MinIO adapter.
    defaultProviderMessage: "MinIO error",
    endpoint: opts.endpoint,
    // MinIO routes via path style by default (virtual-hosted style requires
    // per-bucket DNS setup). Allow override for users who've configured it.
    forcePathStyle: opts.forcePathStyle ?? true,
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    // SigV4 requires *some* region; MinIO ignores it for routing.
    region: opts.region ?? "us-east-1",
  });

  return {
    ...inner,
    name: "minio",
  };
};
