import type { AwsClient } from "aws4fetch";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3FetchAdapter } from "../internal/s3-fetch.js";

// The public home of the aws4fetch-signed S3 engine that also powers r2()'s
// `client: "fetch"` mode and hybrid signing. `files-sdk/s3` statically imports
// `@aws-sdk/client-s3` by design (#105), and that SDK's XML parsing needs
// `DOMParser` on browser-targeted bundles — absent on Cloudflare Workers — so
// Workers, Deno Deploy, and browser-adjacent runtimes talking to AWS S3, MinIO,
// Tigris, or any other S3-compatible endpoint reach for this entry instead.
// Same coverage and trade-offs as r2's fetch client: single-PUT uploads,
// no multipart/resumable, per-key bulk deletes, no presigned POST policies.

export interface S3FetchAdapterOptions {
  /** Bucket name. All operations are scoped to it. */
  bucket: string;
  /**
   * Service endpoint origin, e.g. `https://s3.us-east-1.amazonaws.com`,
   * `http://localhost:9000`, or `https://t3.storage.dev`. Only the origin is
   * used — a path component is dropped, so front the service with a host, not
   * a route prefix.
   */
  endpoint: string;
  /**
   * SigV4 signing region. Falls back to `AWS_REGION` / `AWS_DEFAULT_REGION`,
   * then `us-east-1`. Every S3-compatible service needs *some* region in the
   * signature; most ignore it for routing.
   */
  region?: string;
  /**
   * Static credentials. Falls back to `AWS_ACCESS_KEY_ID`; required if that
   * env var isn't set. No credential chain — there is no IAM role, shared
   * profile, or SSO resolution here, which is what keeps this engine
   * `@aws-sdk/*`-free.
   */
  accessKeyId?: string;
  /**
   * Static credentials. Falls back to `AWS_SECRET_ACCESS_KEY`; required if
   * that env var isn't set.
   */
  secretAccessKey?: string;
  /** Session token for temporary credentials. Falls back to `AWS_SESSION_TOKEN`. */
  sessionToken?: string;
  /**
   * Use path-style addressing (`https://endpoint/bucket/key`) instead of the
   * default virtual-hosted style (`https://bucket.endpoint/key`). Set it for
   * MinIO and other self-hosted services without per-bucket DNS, and for
   * bucket names containing dots (virtual-hosted TLS breaks on them).
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` — for a public bucket policy or a CDN in front
   * of it. When unset, `url()` falls back to a presigned GetObject.
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
  /**
   * Override the `fetch` implementation used for every request — for tests,
   * or runtimes that hand out a bound/instrumented fetch. Defaults to
   * `globalThis.fetch`.
   */
  fetch?: (request: Request) => Promise<Response>;
}

export type S3FetchAdapter = Adapter<AwsClient> & { readonly bucket: string };

export const s3Fetch = (opts: S3FetchAdapterOptions): S3FetchAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("AWS_SECRET_ACCESS_KEY");
  const sessionToken = opts.sessionToken ?? readEnv("AWS_SESSION_TOKEN");
  const region =
    opts.region ?? readEnv("AWS_REGION") ?? readEnv("AWS_DEFAULT_REGION");

  if (!opts.endpoint) {
    throw new FilesError(
      "Provider",
      "s3-fetch adapter: missing endpoint. Pass `endpoint` (e.g. https://s3.us-east-1.amazonaws.com)."
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "s3-fetch adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (there is no credential chain on this client)."
    );
  }

  return s3FetchAdapter({
    accessKeyId,
    bucket: opts.bucket,
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    endpoint: opts.endpoint,
    ...(opts.fetch && { fetch: opts.fetch }),
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    name: "s3-fetch",
    providerLabel: "S3 error",
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    ...(region && { region }),
    secretAccessKey,
    ...(sessionToken && { sessionToken }),
  });
};
