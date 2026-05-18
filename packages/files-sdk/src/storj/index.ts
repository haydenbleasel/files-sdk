import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

const STORJ_GATEWAY_MT_ENDPOINT = "https://gateway.storjshare.io";

export interface StorjAdapterOptions {
  /** Storj bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * Storj S3 gateway URL. Defaults to `https://gateway.storjshare.io`
   * (Gateway MT — Storj's hosted multi-tenant gateway). Override with a
   * self-hosted Gateway ST URL if you run your own.
   */
  endpoint?: string;
  /**
   * Static access key ID. Falls back to `STORJ_ACCESS_KEY_ID`; required if
   * that env var isn't set. This is an S3-style gateway key, not your Storj
   * access grant — the gateway translates it server-side.
   */
  accessKeyId?: string;
  /**
   * Static secret access key. Falls back to `STORJ_SECRET_ACCESS_KEY`;
   * required if that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * SigV4 region used for signing. Defaults to `us-east-1`. SigV4 requires
   * some region in the signature; the Storj gateway ignores it for routing,
   * so leave the default unless you have a reason to change it.
   */
  region?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`). Defaults to `true` for
   * Storj — the gateway routes path-style. Flip off only if you've fronted
   * the gateway with subdomain routing.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For Storj, the natural
   * value is a linksharing prefix like
   * `https://link.storjshare.io/raw/<accessGrant>/<bucket>` — generate
   * one with `uplink share --url`. When unset, `url()` falls back to a
   * presigned GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by
   * `url()` when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type StorjAdapter = Adapter<S3Client>;

export const storj = (opts: StorjAdapterOptions): StorjAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("STORJ_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("STORJ_SECRET_ACCESS_KEY");

  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "storj adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set STORJ_ACCESS_KEY_ID + STORJ_SECRET_ACCESS_KEY."
    );
  }

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Storj's gateway is wire-compatible with S3 but a separate product;
    // relabel the default provider message so users don't see "S3 error".
    defaultProviderMessage: "Storj error",
    endpoint: opts.endpoint || STORJ_GATEWAY_MT_ENDPOINT,
    // Storj's gateway routes via path style.
    forcePathStyle: opts.forcePathStyle ?? true,
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    // SigV4 requires *some* region; the Storj gateway ignores it for routing.
    region: opts.region ?? "us-east-1",
  });

  return {
    ...inner,
    name: "storj",
  };
};
