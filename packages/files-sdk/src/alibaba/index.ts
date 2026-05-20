import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface AlibabaAdapterOptions {
  /** Alibaba OSS bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * Alibaba Cloud OSS region, e.g. `"cn-hangzhou"`, `"cn-shanghai"`,
   * `"cn-beijing"`, `"ap-southeast-1"` (Singapore), `"us-east-1"` (Virginia),
   * `"eu-central-1"` (Frankfurt). Drives the endpoint host
   * (`https://oss-<region>.aliyuncs.com`); there's no env-var fallback.
   * Doubles as the SigV4 region (pass the bare region, not the
   * `oss-`-prefixed form). Buckets live in exactly one region.
   */
  region: string;
  /**
   * Override the Alibaba OSS endpoint. When unset, defaults to
   * `https://oss-${region}.aliyuncs.com`. OSS routes by Host header — the
   * SDK prepends the bucket subdomain for virtual-hosted style.
   */
  endpoint?: string;
  /**
   * Static credentials. Falls back to `ALIBABA_ACCESS_KEY_ID`; required if
   * that env var isn't set.
   */
  accessKeyId?: string;
  /**
   * Static credentials. Falls back to `ALIBABA_ACCESS_KEY_SECRET`; required
   * if that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for Alibaba OSS.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For public buckets the
   * natural value is `https://${bucket}.oss-${region}.aliyuncs.com`; a
   * custom domain bound to the bucket also works. When unset, `url()`
   * falls back to a presigned GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type AlibabaAdapter = Adapter<S3Client>;

export const alibaba = (opts: AlibabaAdapterOptions): AlibabaAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("ALIBABA_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("ALIBABA_ACCESS_KEY_SECRET");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'alibaba adapter: missing region. Pass `region` (e.g. "cn-hangzhou").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "alibaba adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set ALIBABA_ACCESS_KEY_ID + ALIBABA_ACCESS_KEY_SECRET."
    );
  }

  const endpoint = opts.endpoint ?? `https://oss-${opts.region}.aliyuncs.com`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Alibaba OSS is wire-compatible with S3; relabel the default provider
    // message so users don't see "S3 error" from their Alibaba adapter.
    defaultProviderMessage: "Alibaba Cloud error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "alibaba",
  };
};
