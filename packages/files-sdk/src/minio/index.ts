import type { S3Client } from "@aws-sdk/client-s3";
import type { AwsClient } from "aws4fetch";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { lazyS3Adapter, resolveS3Engine } from "../internal/s3-engine.js";
import { s3FetchAdapter } from "../internal/s3-fetch.js";
// Note: the s3 engine is *not* imported here. The aws-sdk path loads it via
// `lazyS3Adapter` on first use so that a Worker bundle on the fetch path
// never pulls in @aws-sdk/client-s3 (~500KB+) — see #155.

export interface MinioAdapterOptions {
  /** MinIO bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * MinIO server URL, e.g. `http://localhost:9000`. Include the scheme —
   * `http://` for local dev, `https://` in production.
   */
  endpoint: string;
  /**
   * Static credentials. Falls back to `MINIO_ACCESS_KEY_ID`; required if
   * that env var isn't set.
   */
  accessKeyId?: string;
  /**
   * Static credentials. Falls back to `MINIO_SECRET_ACCESS_KEY`; required if
   * that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * SigV4 region used for signing. Defaults to `us-east-1`. SigV4 requires
   * some region in the signature, but MinIO ignores it for routing — leave
   * the default unless you've configured per-region buckets.
   */
  region?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `true` for MinIO; flip off only if you've set up
   * per-bucket subdomain routing in front of your server.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` — appropriate for a public bucket policy or
   * a reverse proxy in front of MinIO. When unset, `url()` falls back to
   * a presigned GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by
   * `url()` when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
  /**
   * Which HTTP engine backs the adapter.
   *
   * Defaults to `"aws-sdk"`, except on Cloudflare Workers (detected via
   * `navigator.userAgent === "Cloudflare-Workers"`, or the workerd-only
   * `WebSocketPair` global when `navigator` is disabled), where it defaults
   * to `"fetch"` — the aws-sdk engine's XML parsing needs `DOMParser`, which
   * workerd doesn't provide. A Worker that polyfills `DOMParser` keeps the
   * `"aws-sdk"` default. Note the `"fetch"` engine's narrower surface below
   * before relying on the default in a Worker.
   *
   * - `"aws-sdk"`: `@aws-sdk/client-s3` — the full surface, including
   *   multipart/resumable uploads, byte-level upload progress, and batched
   *   `deleteMany`. Requires the `@aws-sdk/*` optional peer dependencies.
   *   Loaded lazily on first use, so `raw` is `undefined` until a method
   *   has run.
   * - `"fetch"`: SigV4-signed `fetch` via `aws4fetch` (~2.5 KB) — no
   *   `@aws-sdk/*` install needed, ideal for Workers and other edge
   *   runtimes. Covers upload, download (+ ranges), head, exists, delete,
   *   list (+ delimiter), server-side copy, presigned `url()`, and
   *   `signedUploadUrl()`. Trade-offs: `ReadableStream` bodies are buffered
   *   before the single PUT, `multipart`/`control` uploads throw, bulk
   *   deletes fan out per-key instead of batching, `signedUploadUrl` rejects
   *   `maxSize`, keys with `.`/`..` segments are rejected, and `raw` is an
   *   aws4fetch `AwsClient`.
   *
   * Both engines keep MinIO's defaults — path-style addressing, the
   * `us-east-1` signing region, `MinIO error` labels — which is what
   * reaching for the generic `s3Fetch()` instead would drop.
   */
  client?: "aws-sdk" | "fetch";
  /**
   * Override the `fetch` implementation used by the `"fetch"` client — for
   * tests, or runtimes that hand out a bound/instrumented fetch. Defaults to
   * `globalThis.fetch`. Ignored by the `"aws-sdk"` client.
   */
  fetch?: (request: Request) => Promise<Response>;
}

export type MinioAdapter = Adapter<S3Client | AwsClient>;

export const minio = (opts: MinioAdapterOptions): MinioAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("MINIO_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("MINIO_SECRET_ACCESS_KEY");

  if (!opts.endpoint) {
    throw new FilesError(
      "Provider",
      "minio adapter: missing endpoint. Pass `endpoint` (e.g. http://localhost:9000)."
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "minio adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set MINIO_ACCESS_KEY_ID + MINIO_SECRET_ACCESS_KEY."
    );
  }

  // MinIO routes via path style by default (virtual-hosted style requires
  // per-bucket DNS setup). Allow override for users who've configured it.
  const forcePathStyle = opts.forcePathStyle ?? true;
  // SigV4 requires *some* region; MinIO ignores it for routing.
  const region = opts.region ?? "us-east-1";

  // The lightweight engine: aws4fetch-signed fetch, no @aws-sdk/* anywhere.
  if (resolveS3Engine(opts.client) === "fetch") {
    return s3FetchAdapter({
      accessKeyId,
      bucket: opts.bucket,
      ...(opts.defaultUrlExpiresIn !== undefined && {
        defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
      }),
      endpoint: opts.endpoint,
      ...(opts.fetch && { fetch: opts.fetch }),
      forcePathStyle,
      name: "minio-fetch",
      providerLabel: "MinIO error",
      ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
      region,
      secretAccessKey,
    });
  }

  return lazyS3Adapter(
    {
      bucket: opts.bucket,
      credentials: { accessKeyId, secretAccessKey },
      ...(opts.defaultUrlExpiresIn !== undefined && {
        defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
      }),
      // MinIO is wire-compatible with S3 but self-hosted; relabel the default
      // provider message so users don't see "S3 error" from their MinIO adapter.
      defaultProviderMessage: "MinIO error",
      endpoint: opts.endpoint,
      forcePathStyle,
      ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
      region,
    },
    "minio"
  );
};
