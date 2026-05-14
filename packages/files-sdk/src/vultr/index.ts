import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface VultrAdapterOptions {
  bucket: string;
  /**
   * Vultr Object Storage region code, e.g. `"ewr"` (New Jersey),
   * `"sjc"` (Silicon Valley), `"ams"` (Amsterdam), `"blr"` (Bangalore),
   * `"del"` (Delhi), `"sgp"` (Singapore), `"lux"` (Luxembourg). Drives the
   * endpoint host (`https://<region>.vultrobjects.com`); there's no env-var
   * fallback. Doubles as the SigV4 region.
   */
  region: string;
  /**
   * Override the Vultr endpoint. When unset, defaults to
   * `https://${region}.vultrobjects.com`. Vultr routes by Host header —
   * the SDK prepends the bucket subdomain for virtual-hosted style.
   */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for Vultr.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For buckets with public
   * ACL, the natural value is
   * `https://${bucket}.${region}.vultrobjects.com`; a custom CNAME fronting
   * the bucket also works. Vultr has no built-in CDN. When unset, `url()`
   * falls back to a presigned GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type VultrAdapter = Adapter<S3Client>;

export const vultr = (opts: VultrAdapterOptions): VultrAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("VULTR_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("VULTR_SECRET_ACCESS_KEY");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'vultr adapter: missing region. Pass `region` (e.g. "ewr").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "vultr adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set VULTR_ACCESS_KEY_ID + VULTR_SECRET_ACCESS_KEY."
    );
  }

  const endpoint = opts.endpoint ?? `https://${opts.region}.vultrobjects.com`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Vultr Object Storage is wire-compatible with S3; relabel the default
    // provider message so users don't see "S3 error" from their Vultr adapter.
    defaultProviderMessage: "Vultr error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "vultr",
  };
};
