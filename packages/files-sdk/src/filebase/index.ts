import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

const FILEBASE_ENDPOINT = "https://s3.filebase.com";

export interface FilebaseAdapterOptions {
  /** Filebase bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * Filebase S3 endpoint. Defaults to `https://s3.filebase.com` — Filebase
   * runs a single global S3-compatible gateway that fronts IPFS, Sia, and
   * Storj storage networks (the network is chosen per-bucket in the
   * dashboard, not per-request).
   */
  endpoint?: string;
  /**
   * Static credentials. Falls back to `FILEBASE_ACCESS_KEY_ID`; required if
   * that env var isn't set.
   */
  accessKeyId?: string;
  /**
   * Static credentials. Falls back to `FILEBASE_SECRET_ACCESS_KEY`; required
   * if that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * SigV4 region. Defaults to `"us-east-1"`. Filebase ignores it for routing
   * but the SigV4 signature still requires *some* value.
   */
  region?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — Filebase supports virtual-hosted style on
   * the bucket subdomain (`<bucket>.s3.filebase.com`).
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. Filebase serves public
   * objects via per-network gateways (e.g. an IPFS CID gateway); the natural
   * value is whatever gateway URL the dashboard exposes for your bucket.
   * When unset, `url()` falls back to a presigned GetObject (default
   * expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type FilebaseAdapter = Adapter<S3Client>;

export const filebase = (opts: FilebaseAdapterOptions): FilebaseAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("FILEBASE_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("FILEBASE_SECRET_ACCESS_KEY");

  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "filebase adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set FILEBASE_ACCESS_KEY_ID + FILEBASE_SECRET_ACCESS_KEY."
    );
  }

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Filebase is wire-compatible with S3 but a separate product; relabel the
    // default provider message so users don't see "S3 error".
    defaultProviderMessage: "Filebase error",
    endpoint: opts.endpoint || FILEBASE_ENDPOINT,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region ?? "us-east-1",
  });

  return {
    ...inner,
    name: "filebase",
  };
};
