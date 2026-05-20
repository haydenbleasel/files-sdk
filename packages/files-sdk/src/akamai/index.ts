import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface AkamaiAdapterOptions {
  /** Akamai bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * Akamai Cloud Object Storage region/cluster code (formerly Linode Object
   * Storage). Examples: `"us-iad-1"` (Washington DC), `"us-mia-1"` (Miami),
   * `"us-ord-1"` (Chicago), `"nl-ams-1"` (Amsterdam), `"fr-par-1"` (Paris),
   * `"gb-lon-1"` (London), `"jp-osa-1"` (Osaka), plus the older
   * `"us-east-1"` / `"eu-central-1"` / `"ap-south-1"` clusters. Drives the
   * endpoint host; there's no env-var fallback. Doubles as the SigV4 region.
   */
  region: string;
  /**
   * Override the Akamai endpoint. When unset, defaults to
   * `https://${region}.linodeobjects.com`. The `linodeobjects.com` domain is
   * unchanged from the Linode era — only the product branding moved to Akamai.
   */
  endpoint?: string;
  /**
   * Static credentials. Falls back to `AKAMAI_ACCESS_KEY_ID`; required if
   * that env var isn't set.
   */
  accessKeyId?: string;
  /**
   * Static credentials. Falls back to `AKAMAI_SECRET_ACCESS_KEY`; required
   * if that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for Akamai.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For buckets with public
   * ACL, the natural value is `https://${bucket}.${region}.linodeobjects.com`;
   * a custom CNAME fronting the bucket also works. When unset, `url()` falls
   * back to a presigned GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type AkamaiAdapter = Adapter<S3Client>;

export const akamai = (opts: AkamaiAdapterOptions): AkamaiAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("AKAMAI_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("AKAMAI_SECRET_ACCESS_KEY");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'akamai adapter: missing region. Pass `region` (e.g. "us-iad-1").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "akamai adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set AKAMAI_ACCESS_KEY_ID + AKAMAI_SECRET_ACCESS_KEY."
    );
  }

  const endpoint = opts.endpoint ?? `https://${opts.region}.linodeobjects.com`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Akamai Cloud Object Storage is wire-compatible with S3; relabel the
    // default provider message so users don't see "S3 error" from theirs.
    defaultProviderMessage: "Akamai error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "akamai",
  };
};
