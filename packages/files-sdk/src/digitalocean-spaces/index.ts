import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface DigitalOceanSpacesAdapterOptions {
  /** Spaces name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * Spaces datacenter region, e.g. `"nyc3"`, `"sfo3"`, `"ams3"`, `"fra1"`,
   * `"sgp1"`, `"syd1"`, `"blr1"`, `"tor1"`, `"lon1"`. Drives the endpoint
   * host; there's no env-var fallback (no `DO_REGION` convention).
   */
  region: string;
  /**
   * Override the Spaces endpoint. When unset, defaults to
   * `https://${region}.digitaloceanspaces.com`. Spaces routes by Host header
   * — the SDK prepends the bucket subdomain for virtual-hosted style.
   */
  endpoint?: string;
  /**
   * Static credentials. Falls back to `DO_SPACES_KEY`; required if that env
   * var isn't set.
   */
  accessKeyId?: string;
  /**
   * Static credentials. Falls back to `DO_SPACES_SECRET`; required if that
   * env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for Spaces.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing — typical values are the
   * Spaces CDN host (`https://${bucket}.${region}.cdn.digitaloceanspaces.com`)
   * or a custom CNAME. When unset, `url()` falls back to a presigned
   * GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type DigitalOceanSpacesAdapter = Adapter<S3Client>;

export const digitaloceanSpaces = (
  opts: DigitalOceanSpacesAdapterOptions
): DigitalOceanSpacesAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("DO_SPACES_KEY");
  const secretAccessKey = opts.secretAccessKey ?? readEnv("DO_SPACES_SECRET");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'digitalocean-spaces adapter: missing region. Pass `region` (e.g. "nyc3").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "digitalocean-spaces adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set DO_SPACES_KEY + DO_SPACES_SECRET."
    );
  }

  const endpoint =
    opts.endpoint ?? `https://${opts.region}.digitaloceanspaces.com`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Spaces is wire-compatible with S3; relabel the default provider message
    // so users don't see "S3 error" from their DigitalOcean Spaces adapter.
    defaultProviderMessage: "Spaces error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "digitalocean-spaces",
  };
};
