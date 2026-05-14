import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface ExoscaleAdapterOptions {
  bucket: string;
  /**
   * Exoscale zone code (Exoscale calls these zones rather than regions),
   * e.g. `"ch-gva-2"` (Geneva), `"ch-dk-2"` (Zurich), `"de-fra-1"`
   * (Frankfurt), `"de-muc-1"` (Munich), `"at-vie-1"` / `"at-vie-2"`
   * (Vienna), `"bg-sof-1"` (Sofia). Drives the endpoint host
   * (`https://sos-<region>.exo.io`); there's no env-var fallback. Doubles
   * as the SigV4 region.
   */
  region: string;
  /**
   * Override the Exoscale endpoint. When unset, defaults to
   * `https://sos-${region}.exo.io`. SOS routes by Host header — the SDK
   * prepends the bucket subdomain for virtual-hosted style.
   */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for SOS.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For public buckets the
   * natural value is `https://sos-${region}.exo.io/${bucket}` (path-style)
   * or `https://${bucket}.sos-${region}.exo.io`; a custom CNAME fronting
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

export type ExoscaleAdapter = Adapter<S3Client>;

export const exoscale = (opts: ExoscaleAdapterOptions): ExoscaleAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("EXOSCALE_API_KEY");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("EXOSCALE_API_SECRET");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'exoscale adapter: missing region. Pass `region` (e.g. "ch-gva-2"). Exoscale calls these "zones".'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "exoscale adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set EXOSCALE_API_KEY + EXOSCALE_API_SECRET."
    );
  }

  const endpoint = opts.endpoint ?? `https://sos-${opts.region}.exo.io`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Exoscale SOS is wire-compatible with S3; relabel the default provider
    // message so users don't see "S3 error" from their Exoscale adapter.
    defaultProviderMessage: "Exoscale error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "exoscale",
  };
};
