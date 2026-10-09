import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface OvhcloudAdapterOptions {
  /** OVHcloud bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * OVHcloud Object Storage region code, e.g. `"gra"` (Gravelines),
   * `"rbx"` (Roubaix), `"sbg"` (Strasbourg), `"de"` (Frankfurt),
   * `"uk"` (London), `"waw"` (Warsaw), `"eu-west-par"` (Paris),
   * `"bhs"` (Beauharnois), `"sgp"` (Singapore), `"ap-southeast-syd"`
   * (Sydney). Drives the endpoint host
   * (`https://s3.<region>.io.cloud.ovh.net`); there's no env-var fallback.
   * Doubles as the SigV4 region.
   */
  region: string;
  /**
   * Override the OVHcloud endpoint. When unset, defaults to
   * `https://s3.${region}.io.cloud.ovh.net`, OVHcloud's main S3 endpoint:
   * it serves every storage class and stores new objects as Standard
   * unless told otherwise. OVHcloud also keeps a legacy
   * `https://s3.${region}.perf.cloud.ovh.net` endpoint (High Performance by
   * default) and, in some regions, the Swift-backed
   * `https://s3.${region}.cloud.ovh.net`; pass either here to use it.
   * OVHcloud routes by Host header — the SDK prepends the bucket subdomain
   * for virtual-hosted style.
   */
  endpoint?: string;
  /**
   * Static credentials. Falls back to `OVH_ACCESS_KEY_ID`; required if that
   * env var isn't set.
   */
  accessKeyId?: string;
  /**
   * Static credentials. Falls back to `OVH_SECRET_ACCESS_KEY`; required if
   * that env var isn't set.
   */
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
      "Invalid",
      'ovhcloud adapter: missing region. Pass `region` (e.g. "gra").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Invalid",
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
