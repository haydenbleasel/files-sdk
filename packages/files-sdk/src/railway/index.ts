import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

const RAILWAY_DEFAULT_ENDPOINT = "https://t3.storageapi.dev";

export interface RailwayAdapterOptions {
  /**
   * The bucket's S3 name: its display name plus a short hash (e.g.
   * `my-bucket-jdhhd8oe18xi`), shown in the bucket's Credentials tab. Falls
   * back to `AWS_S3_BUCKET_NAME`, the name `railway bucket credentials` prints
   * it under; required if that env var isn't set.
   */
  bucket?: string;
  /**
   * Override the S3 endpoint. Falls back to `AWS_ENDPOINT_URL`, then defaults
   * to `https://t3.storageapi.dev`, the endpoint Railway's Credentials tab
   * shows for current buckets.
   */
  endpoint?: string;
  /**
   * Static access key ID. Falls back to `AWS_ACCESS_KEY_ID`; required if that
   * env var isn't set.
   */
  accessKeyId?: string;
  /**
   * Static secret access key. Falls back to `AWS_SECRET_ACCESS_KEY`; required
   * if that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * SigV4 region used for signing. Defaults to `"auto"`, the value Railway
   * hands out. Buckets are pinned to the region picked at creation, so this
   * is never used for routing, but the signature requires *some* value.
   */
  region?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Falls back to `AWS_S3_URL_STYLE` (`"path"` or `"virtual"`), which
   * Railway hands out alongside the credentials. Current buckets use
   * virtual-hosted style; some buckets created before Railway switched need
   * path-style, and their Credentials tab says so.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. Railway buckets have no public
   * URLs of their own, so this is for a proxy service or CDN you put in front
   * of the bucket: `url(key)` returns `${publicBaseUrl}/${key}` and skips
   * signing. When unset, `url()` returns a presigned GetObject URL (default
   * expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type RailwayAdapter = Adapter<S3Client> & {
  readonly bucket: string;
};

/** Maps Railway's `AWS_S3_URL_STYLE` onto `forcePathStyle`. */
const urlStyleFromEnv = (): boolean | undefined => {
  const style = readEnv("AWS_S3_URL_STYLE");
  if (!style) {
    return;
  }
  const normalized = style.trim().toLowerCase();
  if (normalized === "path") {
    return true;
  }
  if (normalized === "virtual") {
    return false;
  }
  throw new FilesError(
    "Invalid",
    `railway adapter: AWS_S3_URL_STYLE must be "path" or "virtual", got "${style}".`
  );
};

export const railway = (opts: RailwayAdapterOptions = {}): RailwayAdapter => {
  const bucket = opts.bucket ?? readEnv("AWS_S3_BUCKET_NAME");
  if (!bucket) {
    throw new FilesError(
      "Invalid",
      "railway adapter: missing bucket. Pass `bucket` or set AWS_S3_BUCKET_NAME (the bucket's BUCKET variable)."
    );
  }

  // Static keys go in as a pair or not at all. With only one, the other would
  // come from the environment and could belong to a different bucket.
  if (Boolean(opts.accessKeyId) !== Boolean(opts.secretAccessKey)) {
    throw new FilesError(
      "Invalid",
      "railway adapter: pass `accessKeyId` and `secretAccessKey` together, or neither to read AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY."
    );
  }
  const accessKeyId = opts.accessKeyId ?? readEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("AWS_SECRET_ACCESS_KEY");
  // No AWS credential chain: a shared profile or instance role would sign
  // with AWS keys that Railway rejects, so missing keys fail here instead.
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Invalid",
      "railway adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY."
    );
  }

  const forcePathStyle = opts.forcePathStyle ?? urlStyleFromEnv();

  const inner = s3({
    bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Railway Buckets are wire-compatible with S3; relabel the default
    // provider message so users don't see "S3 error" from their Railway adapter.
    defaultProviderMessage: "Railway Buckets error",
    endpoint:
      opts.endpoint || readEnv("AWS_ENDPOINT_URL") || RAILWAY_DEFAULT_ENDPOINT,
    ...(forcePathStyle !== undefined && { forcePathStyle }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region ?? "auto",
  });

  return {
    ...inner,
    name: "railway",
  };
};
