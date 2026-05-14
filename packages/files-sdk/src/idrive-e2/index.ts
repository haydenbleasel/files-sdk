import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface IdriveE2AdapterOptions {
  bucket: string;
  /**
   * iDrive e2 endpoint URL. Required — iDrive e2 hostnames are tied to the
   * storage region/cluster your bucket was provisioned in and don't follow
   * a public pattern; copy the endpoint from the iDrive e2 dashboard
   * (Access Keys → Endpoint). Example: `https://q9z7.va.idrivee2-NN.com`.
   */
  endpoint: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * SigV4 region. Defaults to `"us-east-1"`. iDrive e2 ignores it for
   * routing (the endpoint host carries the region info), but the SigV4
   * signature still needs *some* value.
   */
  region?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — iDrive e2 supports virtual-hosted style on
   * the bucket subdomain.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. iDrive e2 has no built-in
   * CDN, so this is typically a custom CNAME or reverse proxy fronting the
   * bucket. When unset, `url()` falls back to a presigned GetObject (default
   * expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type IdriveE2Adapter = Adapter<S3Client>;

export const idriveE2 = (opts: IdriveE2AdapterOptions): IdriveE2Adapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("IDRIVE_E2_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("IDRIVE_E2_SECRET_ACCESS_KEY");

  if (!opts.endpoint) {
    throw new FilesError(
      "Provider",
      "idrive-e2 adapter: missing endpoint. Pass `endpoint` (copy it from the iDrive e2 dashboard under Access Keys → Endpoint)."
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "idrive-e2 adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set IDRIVE_E2_ACCESS_KEY_ID + IDRIVE_E2_SECRET_ACCESS_KEY."
    );
  }

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // iDrive e2 is wire-compatible with S3; relabel the default provider
    // message so users don't see "S3 error" from their iDrive e2 adapter.
    defaultProviderMessage: "iDrive e2 error",
    endpoint: opts.endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region ?? "us-east-1",
  });

  return {
    ...inner,
    name: "idrive-e2",
  };
};
