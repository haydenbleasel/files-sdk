import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface OvhcloudAdapterOptions {
  bucket: string;
  /**
   * OVHcloud Object Storage region code, e.g. `"gra"` (Gravelines),
   * `"sbg"` (Strasbourg), `"bhs"` (Beauharnois), `"de"` (Frankfurt),
   * `"uk"` (London), `"waw"` (Warsaw), `"sgp"` (Singapore),
   * `"syd"` (Sydney). Drives the endpoint host
   * (`https://s3.<region>.io.cloud.ovh.net`, the High Performance S3 API);
   * there's no env-var fallback. Doubles as the SigV4 region.
   */
  region: string;
  /**
   * Override the OVHcloud endpoint. When unset, defaults to
   * `https://s3.${region}.io.cloud.ovh.net` — OVHcloud's High Performance
   * S3 endpoint. For the Standard tier (Swift-backed), pass
   * `https://s3.${region}.cloud.ovh.net` explicitly. OVHcloud routes by
   * Host header — the SDK prepends the bucket subdomain for virtual-hosted
   * style.
   */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for OVHcloud.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For public containers the
   * natural value is `https://${bucket}.s3.${region}.io.cloud.ovh.net`;
   * a custom CNAME fronting the bucket also works. When unset, `url()`
   * falls back to a presigned GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type OvhcloudAdapter = Adapter<S3Client>;

export const ovhcloud = (opts: OvhcloudAdapterOptions): OvhcloudAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("OVH_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("OVH_SECRET_ACCESS_KEY");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'ovhcloud adapter: missing region. Pass `region` (e.g. "gra").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "ovhcloud adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set OVH_ACCESS_KEY_ID + OVH_SECRET_ACCESS_KEY."
    );
  }

  const endpoint =
    opts.endpoint ?? `https://s3.${opts.region}.io.cloud.ovh.net`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // OVHcloud Object Storage is wire-compatible with S3; relabel the default
    // provider message so users don't see "S3 error" from their OVHcloud adapter.
    defaultProviderMessage: "OVHcloud error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "ovhcloud",
  };
};
