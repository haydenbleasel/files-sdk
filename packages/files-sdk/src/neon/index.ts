import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface NeonAdapterOptions {
  /** Neon object-storage bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * The branch's S3-compatible endpoint URL. Falls back to
   * `AWS_ENDPOINT_URL_S3` — the variable `neon dev` / `neon env pull` inject
   * for the linked branch. Required if that env var isn't set.
   */
  endpoint?: string;
  /**
   * SigV4 region used for signing. Falls back to `AWS_REGION`, then
   * `NEON_STORAGE_REGION` (Neon injects the region under both names), then
   * defaults to `"us-east-1"`. Neon normalizes the region server-side and does
   * not use it for routing, but the signature requires *some* value.
   */
  region?: string;
  /**
   * Static access key ID. Skip to use the AWS credential chain, which reads
   * the `AWS_ACCESS_KEY_ID` that `neon dev` / `neon env pull` inject for the
   * branch credential.
   */
  accessKeyId?: string;
  /**
   * Static secret access key. Skip to use the AWS credential chain, which
   * reads the `AWS_SECRET_ACCESS_KEY` Neon injects for the branch credential.
   */
  secretAccessKey?: string;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing — appropriate for a bucket
   * fronted by a CDN or custom domain. When unset, `url()` falls back to a
   * presigned `GetObject` URL (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type NeonAdapter = Adapter<S3Client> & {
  readonly bucket: string;
};

const NEON_DEFAULT_REGION = "us-east-1";

export const neon = (opts: NeonAdapterOptions): NeonAdapter => {
  const endpoint = opts.endpoint ?? readEnv("AWS_ENDPOINT_URL_S3");
  if (!endpoint) {
    throw new FilesError(
      "Provider",
      "neon adapter: missing endpoint. Pass `endpoint` or set AWS_ENDPOINT_URL_S3 (injected by `neon dev` / `neon env pull`)."
    );
  }

  const region =
    opts.region ??
    readEnv("AWS_REGION") ??
    readEnv("NEON_STORAGE_REGION") ??
    NEON_DEFAULT_REGION;

  const inner = s3({
    bucket: opts.bucket,
    ...(opts.accessKeyId &&
      opts.secretAccessKey && {
        credentials: {
          accessKeyId: opts.accessKeyId,
          secretAccessKey: opts.secretAccessKey,
        },
      }),
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Neon is wire-compatible with S3; relabel the default provider message so
    // users don't see "S3 error" from their Neon adapter.
    defaultProviderMessage: "Neon error",
    endpoint,
    // Neon object storage requires path-style addressing — the wildcard TLS
    // cert covers one subdomain level, occupied by the branch id, so the bucket
    // name must travel in the request path. Always on; not configurable.
    forcePathStyle: true,
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region,
  });

  return {
    ...inner,
    name: "neon",
  };
};
