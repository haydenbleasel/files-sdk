import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface WasabiAdapterOptions {
  /** Wasabi bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * Wasabi storage region, e.g. `"us-east-1"`, `"us-east-2"`, `"us-central-1"`,
   * `"us-west-1"`, `"ca-central-1"`, `"eu-central-1"`, `"eu-central-2"`,
   * `"eu-west-1"`, `"eu-west-2"`, `"ap-northeast-1"`, `"ap-northeast-2"`,
   * `"ap-southeast-1"`, `"ap-southeast-2"`. Drives the endpoint host
   * (`https://s3.<region>.wasabisys.com`); there's no env-var fallback.
   * Doubles as the SigV4 region. The region names mirror AWS but the
   * endpoints are Wasabi's own — buckets live in exactly one region.
   */
  region: string;
  /**
   * Override the Wasabi endpoint. When unset, defaults to
   * `https://s3.${region}.wasabisys.com`. Wasabi routes by Host header — the
   * SDK prepends the bucket subdomain for virtual-hosted style.
   */
  endpoint?: string;
  /**
   * Static access key ID. Falls back to `WASABI_ACCESS_KEY_ID`; required if
   * that env var isn't set.
   */
  accessKeyId?: string;
  /**
   * Static secret access key. Falls back to `WASABI_SECRET_ACCESS_KEY`;
   * required if that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for Wasabi.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing — for buckets with public
   * read policy, the natural value is
   * `https://${bucket}.s3.${region}.wasabisys.com`; a custom CNAME fronting
   * the bucket also works. Wasabi has no built-in CDN, so leaving this
   * unset is the common case. When unset, `url()` falls back to a presigned
   * GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type WasabiAdapter = Adapter<S3Client>;

export const wasabi = (opts: WasabiAdapterOptions): WasabiAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("WASABI_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("WASABI_SECRET_ACCESS_KEY");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'wasabi adapter: missing region. Pass `region` (e.g. "us-east-1").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "wasabi adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set WASABI_ACCESS_KEY_ID + WASABI_SECRET_ACCESS_KEY."
    );
  }

  const endpoint = opts.endpoint ?? `https://s3.${opts.region}.wasabisys.com`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Wasabi is wire-compatible with S3; relabel the default provider message
    // so users don't see "S3 error" from their Wasabi adapter.
    defaultProviderMessage: "Wasabi error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "wasabi",
  };
};
