import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

const YANDEX_DEFAULT_ENDPOINT = "https://storage.yandexcloud.net";

export interface YandexAdapterOptions {
  bucket: string;
  /**
   * Override the Yandex Object Storage endpoint. Defaults to
   * `https://storage.yandexcloud.net` — Yandex serves a single global
   * endpoint and routes internally. Override for a private deployment or
   * proxy.
   */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * SigV4 region used for signing. Defaults to `"ru-central1"` — Yandex's
   * only public region today. The value is required by the signature but
   * doesn't drive routing (the endpoint is fixed). Leave the default unless
   * you have a reason to change it.
   */
  region?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `false` — virtual-hosted is canonical for Yandex
   * Object Storage.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For public buckets the
   * natural value is `https://${bucket}.storage.yandexcloud.net`; a custom
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

export type YandexAdapter = Adapter<S3Client>;

export const yandex = (opts: YandexAdapterOptions): YandexAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("YANDEX_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("YANDEX_SECRET_ACCESS_KEY");

  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "yandex adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set YANDEX_ACCESS_KEY_ID + YANDEX_SECRET_ACCESS_KEY."
    );
  }

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // Yandex Object Storage is wire-compatible with S3; relabel the default
    // provider message so users don't see "S3 error" from their Yandex adapter.
    defaultProviderMessage: "Yandex Cloud error",
    endpoint: opts.endpoint || YANDEX_DEFAULT_ENDPOINT,
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region ?? "ru-central1",
  });

  return {
    ...inner,
    name: "yandex",
  };
};
