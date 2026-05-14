import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface ScalewayAdapterOptions {
  bucket: string;
  /**
   * Scaleway Object Storage region, e.g. `"fr-par"` (Paris),
   * `"nl-ams"` (Amsterdam), `"pl-waw"` (Warsaw). Drives the endpoint host
   * (`https://s3.<region>.scw.cloud`); there's no env-var fallback. Doubles
   * as the SigV4 region. Buckets live in exactly one region.
   */
  region: string;
  /**
   * Override the Scaleway endpoint. When unset, defaults to
   * `https://s3.${region}.scw.cloud`. Scaleway routes by Host header — the
   * SDK prepends the bucket subdomain for virtual-hosted style.
   */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for Scaleway.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For buckets with public
   * read, the natural value is
   * `https://${bucket}.s3.${region}.scw.cloud`; a custom domain fronting
   * the bucket also works. When unset, `url()` falls back to a presigned
   * GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type ScalewayAdapter = Adapter<S3Client>;

export const scaleway = (opts: ScalewayAdapterOptions): ScalewayAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("SCW_ACCESS_KEY");
  const secretAccessKey = opts.secretAccessKey ?? readEnv("SCW_SECRET_KEY");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'scaleway adapter: missing region. Pass `region` (e.g. "fr-par").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "scaleway adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set SCW_ACCESS_KEY + SCW_SECRET_KEY."
    );
  }

  const endpoint = opts.endpoint ?? `https://s3.${opts.region}.scw.cloud`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Scaleway Object Storage is wire-compatible with S3; relabel the default
    // provider message so users don't see "S3 error" from their Scaleway adapter.
    defaultProviderMessage: "Scaleway error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "scaleway",
  };
};
