import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface TencentAdapterOptions {
  /**
   * Tencent COS bucket name — must already include the `-<appid>` suffix
   * (e.g. `uploads-1250000000`). COS bucket names are globally namespaced
   * by `<name>-<appid>` and the S3-compatible API expects the full form.
   */
  bucket: string;
  /**
   * Tencent COS region, e.g. `"ap-guangzhou"`, `"ap-shanghai"`,
   * `"ap-beijing"`, `"ap-singapore"`, `"na-siliconvalley"`, `"eu-frankfurt"`.
   * Drives the endpoint host (`https://cos.<region>.myqcloud.com`); there's
   * no env-var fallback. Doubles as the SigV4 region. Buckets live in
   * exactly one region.
   */
  region: string;
  /**
   * Override the Tencent COS endpoint. When unset, defaults to
   * `https://cos.${region}.myqcloud.com`. COS routes by Host header — the
   * SDK prepends the bucket subdomain for virtual-hosted style.
   */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for Tencent COS.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For public buckets the
   * natural value is `https://${bucket}.cos.${region}.myqcloud.com`; a
   * CDN domain bound to the bucket also works. When unset, `url()` falls
   * back to a presigned GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type TencentAdapter = Adapter<S3Client>;

export const tencent = (opts: TencentAdapterOptions): TencentAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("TENCENT_SECRET_ID");
  const secretAccessKey = opts.secretAccessKey ?? readEnv("TENCENT_SECRET_KEY");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'tencent adapter: missing region. Pass `region` (e.g. "ap-guangzhou").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "tencent adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set TENCENT_SECRET_ID + TENCENT_SECRET_KEY."
    );
  }

  const endpoint = opts.endpoint ?? `https://cos.${opts.region}.myqcloud.com`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Tencent COS is wire-compatible with S3; relabel the default provider
    // message so users don't see "S3 error" from their Tencent adapter.
    defaultProviderMessage: "Tencent Cloud error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "tencent",
  };
};
