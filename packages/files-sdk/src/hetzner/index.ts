import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface HetznerAdapterOptions {
  /** Hetzner bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * Hetzner Object Storage location code, e.g. `"fsn1"` (Falkenstein),
   * `"nbg1"` (Nuremberg), `"hel1"` (Helsinki). Drives the endpoint host;
   * there's no env-var fallback. Doubles as the SigV4 region — Hetzner
   * ignores it for routing but the signature requires *some* value.
   */
  region: string;
  /**
   * Override the Hetzner endpoint. When unset, defaults to
   * `https://${region}.your-objectstorage.com`. Hetzner routes by Host header
   * — the SDK prepends the bucket subdomain for virtual-hosted style.
   */
  endpoint?: string;
  /**
   * Static credentials. Falls back to `HCLOUD_ACCESS_KEY_ID`; required if
   * that env var isn't set.
   */
  accessKeyId?: string;
  /**
   * Static credentials. Falls back to `HCLOUD_SECRET_ACCESS_KEY`; required
   * if that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for Hetzner.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing — typical values are a
   * custom CNAME or reverse proxy fronting the bucket. Hetzner Object
   * Storage has no built-in CDN, so leaving this unset is the common case.
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

export type HetznerAdapter = Adapter<S3Client>;

export const hetzner = (opts: HetznerAdapterOptions): HetznerAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("HCLOUD_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("HCLOUD_SECRET_ACCESS_KEY");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'hetzner adapter: missing region. Pass `region` (e.g. "fsn1").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "hetzner adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set HCLOUD_ACCESS_KEY_ID + HCLOUD_SECRET_ACCESS_KEY."
    );
  }

  const endpoint =
    opts.endpoint ?? `https://${opts.region}.your-objectstorage.com`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Hetzner Object Storage is wire-compatible with S3; relabel the default
    // provider message so users don't see "S3 error" from their Hetzner adapter.
    defaultProviderMessage: "Hetzner error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "hetzner",
  };
};
