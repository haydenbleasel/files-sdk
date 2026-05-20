import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface IbmCosAdapterOptions {
  /** IBM COS bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * IBM Cloud Object Storage region code, e.g. `"us-south"`, `"us-east"`,
   * `"eu-de"`, `"eu-gb"`, `"eu-es"`, `"jp-tok"`, `"jp-osa"`, `"au-syd"`,
   * `"br-sao"`, `"ca-tor"`. Drives the endpoint host
   * (`https://s3.<region>.cloud-object-storage.appdomain.cloud`); there's
   * no env-var fallback. Doubles as the SigV4 region.
   */
  region: string;
  /**
   * Override the IBM COS endpoint. When unset, defaults to the public
   * `https://s3.${region}.cloud-object-storage.appdomain.cloud`. For
   * direct (no-egress) access from inside the same IBM Cloud region, pass
   * `https://s3.direct.${region}.cloud-object-storage.appdomain.cloud`
   * (or the equivalent `private` host). IBM COS routes by Host header.
   */
  endpoint?: string;
  /**
   * HMAC access key ID. Generate HMAC credentials when creating the IBM COS
   * service credential (Advanced options → "Include HMAC Credential") —
   * separate from IBM Cloud IAM API keys. Falls back to
   * `IBM_COS_ACCESS_KEY_ID`; required if that env var isn't set.
   */
  accessKeyId?: string;
  /**
   * HMAC secret access key. Falls back to `IBM_COS_SECRET_ACCESS_KEY`;
   * required if that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for IBM COS.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For buckets with a public
   * access policy the natural value is
   * `https://${bucket}.s3.${region}.cloud-object-storage.appdomain.cloud`;
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

export type IbmCosAdapter = Adapter<S3Client>;

export const ibmCos = (opts: IbmCosAdapterOptions): IbmCosAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("IBM_COS_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("IBM_COS_SECRET_ACCESS_KEY");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'ibm-cos adapter: missing region. Pass `region` (e.g. "us-south").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "ibm-cos adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set IBM_COS_ACCESS_KEY_ID + IBM_COS_SECRET_ACCESS_KEY."
    );
  }

  const endpoint =
    opts.endpoint ??
    `https://s3.${opts.region}.cloud-object-storage.appdomain.cloud`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // IBM Cloud Object Storage's S3 compat layer is wire-compatible with S3;
    // relabel the default provider message so users don't see "S3 error".
    defaultProviderMessage: "IBM Cloud Object Storage error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "ibm-cos",
  };
};
