import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface MinioAdapterOptions {
  /** MinIO bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * MinIO server URL, e.g. `http://localhost:9000`. Include the scheme —
   * `http://` for local dev, `https://` in production.
   */
  endpoint: string;
  /**
   * Static credentials. Falls back to `MINIO_ACCESS_KEY_ID`; required if
   * that env var isn't set.
   */
  accessKeyId?: string;
  /**
   * Static credentials. Falls back to `MINIO_SECRET_ACCESS_KEY`; required if
   * that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * SigV4 region used for signing. Defaults to `us-east-1`. SigV4 requires
   * some region in the signature, but MinIO ignores it for routing — leave
   * the default unless you've configured per-region buckets.
   */
  region?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `true` for MinIO; flip off only if you've set up
   * per-bucket subdomain routing in front of your server.
   */
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
