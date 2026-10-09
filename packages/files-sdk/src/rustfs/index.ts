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

export interface RustfsAdapterOptions {
  /** RustFS bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * RustFS server URL, e.g. `http://localhost:9000` (the S3 API port; the
   * console lives on 9001). Include the scheme — `http://` for local dev,
   * `https://` in production.
   */
  endpoint: string;
  /**
   * Static credentials. Falls back to `RUSTFS_ACCESS_KEY_ID`, then to the
   * `RUSTFS_ACCESS_KEY` variable the RustFS server itself reads (so a
   * docker-compose `.env` serves both sides); required if neither is set.
   */
  accessKeyId?: string;
  /**
   * Static credentials. Falls back to `RUSTFS_SECRET_ACCESS_KEY`, then to
   * the `RUSTFS_SECRET_KEY` variable the RustFS server itself reads;
   * required if neither is set.
   */
  secretAccessKey?: string;
  /**
   * SigV4 region used for signing. Defaults to `us-east-1`, which is also
   * the server's default (`RUSTFS_REGION`). Set it to match the server if
   * you changed that variable — RustFS rejects signatures for a different
   * region.
   */
  region?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `true` — RustFS serves path style out of the box and
   * only accepts virtual-hosted requests once `RUSTFS_SERVER_DOMAINS` and a
   * wildcard DNS record are configured.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` — appropriate for a public bucket policy or
   * a reverse proxy in front of RustFS. When unset, `url()` falls back to
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
   * Both engines keep RustFS's defaults — path-style addressing, the
   * `us-east-1` signing region, `RustFS error` labels — which is what
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

export type RustfsAdapter = Adapter<S3Client | AwsClient>;

export const rustfs = (opts: RustfsAdapterOptions): RustfsAdapter => {
  // Prefer the SDK-wide `<PROVIDER>_ACCESS_KEY_ID` convention, then accept
  // the names the RustFS server reads so one `.env` configures both sides.
  const accessKeyId =
    opts.accessKeyId ??
    readEnv("RUSTFS_ACCESS_KEY_ID") ??
    readEnv("RUSTFS_ACCESS_KEY");
  const secretAccessKey =
    opts.secretAccessKey ??
    readEnv("RUSTFS_SECRET_ACCESS_KEY") ??
    readEnv("RUSTFS_SECRET_KEY");

  if (!opts.endpoint) {
    throw new FilesError(
      "Invalid",
      "rustfs adapter: missing endpoint. Pass `endpoint` (e.g. http://localhost:9000)."
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Invalid",
      "rustfs adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set RUSTFS_ACCESS_KEY_ID + RUSTFS_SECRET_ACCESS_KEY (or the server's RUSTFS_ACCESS_KEY + RUSTFS_SECRET_KEY)."
    );
  }

  // RustFS routes via path style by default; virtual-hosted style needs
  // RUSTFS_SERVER_DOMAINS plus wildcard DNS. Allow override for users who
  // have configured it.
  const forcePathStyle = opts.forcePathStyle ?? true;
  // SigV4 requires *some* region; RustFS defaults its own to us-east-1.
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
      name: "rustfs-fetch",
      providerLabel: "RustFS error",
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
      // RustFS is wire-compatible with S3 but self-hosted; relabel the default
      // provider message so users don't see "S3 error" from their RustFS adapter.
      defaultProviderMessage: "RustFS error",
      endpoint: opts.endpoint,
      forcePathStyle,
      ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
      region,
    },
    "rustfs"
  );
};
