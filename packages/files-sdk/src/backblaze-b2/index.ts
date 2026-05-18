import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface BackblazeB2AdapterOptions {
  /** B2 bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * Backblaze B2 cluster code, e.g. `"us-west-000"`, `"us-west-001"`,
   * `"us-west-002"`, `"us-east-004"`, `"us-east-005"`, `"eu-central-003"`.
   * Drives the endpoint host (`https://s3.<region>.backblazeb2.com`); there's
   * no env-var fallback. Doubles as the SigV4 region. The cluster a bucket
   * lives in is shown in the B2 console; pick the wrong one and you'll see
   * a `301` redirect from B2.
   */
  region: string;
  /**
   * Override the B2 endpoint. When unset, defaults to
   * `https://s3.${region}.backblazeb2.com`. B2 routes by Host header — the
   * SDK prepends the bucket subdomain for virtual-hosted style.
   */
  endpoint?: string;
  /**
   * Static credentials — B2 application key ID. Falls back to
   * `B2_APPLICATION_KEY_ID`; required if that env var isn't set.
   */
  accessKeyId?: string;
  /**
   * Static credentials — B2 application key. Falls back to
   * `B2_APPLICATION_KEY`; required if that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for B2.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For public buckets the
   * natural value is the friendly download URL prefix
   * `https://f<NNN>.backblazeb2.com/file/<bucket>` (look it up in the B2
   * console under your bucket → "Endpoint"), or a custom domain proxied
   * through Cloudflare. When unset, `url()` falls back to a presigned
   * GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type BackblazeB2Adapter = Adapter<S3Client>;

export const backblazeB2 = (
  opts: BackblazeB2AdapterOptions
): BackblazeB2Adapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("B2_APPLICATION_KEY_ID");
  const secretAccessKey = opts.secretAccessKey ?? readEnv("B2_APPLICATION_KEY");

  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'backblaze-b2 adapter: missing region. Pass `region` (e.g. "us-west-002").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "backblaze-b2 adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set B2_APPLICATION_KEY_ID + B2_APPLICATION_KEY."
    );
  }

  const endpoint = opts.endpoint ?? `https://s3.${opts.region}.backblazeb2.com`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // B2's S3-compatible API is wire-compatible with S3; relabel the default
    // provider message so users don't see "S3 error" from their B2 adapter.
    defaultProviderMessage: "Backblaze B2 error",
    endpoint,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "backblaze-b2",
  };
};
