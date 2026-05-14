import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

const TIGRIS_DEFAULT_ENDPOINT = "https://fly.storage.tigris.dev";

export interface TigrisAdapterOptions {
  bucket: string;
  /**
   * Override the Tigris endpoint. Defaults to
   * `https://fly.storage.tigris.dev` — Tigris serves a single global
   * endpoint and routes to the nearest region automatically. Override for
   * pinned-region testing or a private deployment.
   */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * SigV4 region used for signing. Defaults to `"auto"` — Tigris is a
   * globally-distributed object store and doesn't use the SigV4 region for
   * routing, but the signature requires *some* value. Leave the default
   * unless you have a reason to change it.
   */
  region?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for Tigris.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For public buckets the
   * natural value is `https://${bucket}.fly.storage.tigris.dev`; a custom
   * domain bound to the bucket also works. When unset, `url()` falls back
   * to a presigned GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type TigrisAdapter = Adapter<S3Client>;

export const tigris = (opts: TigrisAdapterOptions): TigrisAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("TIGRIS_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("TIGRIS_SECRET_ACCESS_KEY");

  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "tigris adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set TIGRIS_ACCESS_KEY_ID + TIGRIS_SECRET_ACCESS_KEY."
    );
  }

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Tigris is wire-compatible with S3; relabel the default provider message
    // so users don't see "S3 error" from their Tigris adapter.
    defaultProviderMessage: "Tigris error",
    endpoint: opts.endpoint || TIGRIS_DEFAULT_ENDPOINT,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    // SigV4 requires *some* region; Tigris routes globally and ignores it.
    region: opts.region ?? "auto",
  });

  return {
    ...inner,
    name: "tigris",
  };
};
