import type { S3Client } from "@aws-sdk/client-s3";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

export interface OracleCloudAdapterOptions {
  /** OCI bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * OCI tenancy Object Storage namespace — a tenancy-scoped string assigned
   * by Oracle. Find it under the OCI console: Profile → Tenancy → Object
   * Storage Namespace, or via `oci os ns get`. Drives the endpoint host
   * (`<namespace>.compat.objectstorage.<region>.oraclecloud.com`).
   */
  namespace: string;
  /**
   * OCI region identifier, e.g. `"us-ashburn-1"`, `"us-phoenix-1"`,
   * `"eu-frankfurt-1"`, `"uk-london-1"`, `"ap-tokyo-1"`. Drives the endpoint
   * host; there's no env-var fallback. Doubles as the SigV4 region.
   */
  region: string;
  /**
   * Override the OCI endpoint. When unset, defaults to
   * `https://${namespace}.compat.objectstorage.${region}.oraclecloud.com`.
   * The namespace prefix is part of the host, not the path — OCI's S3
   * compatibility layer scopes the bucket lookup to the namespace.
   */
  endpoint?: string;
  /**
   * Customer secret key access key ID. Generate one in the OCI console
   * under Profile → User Settings → Customer Secret Keys (these are the
   * HMAC keys used for S3-compatible access, distinct from API signing
   * keys). Falls back to `OCI_ACCESS_KEY_ID`; required if that env var
   * isn't set.
   */
  accessKeyId?: string;
  /**
   * Customer Secret Key secret. Falls back to `OCI_SECRET_ACCESS_KEY`;
   * required if that env var isn't set.
   */
  secretAccessKey?: string;
  /**
   * Use path-style addressing (`/<bucket>/<key>`) rather than virtual-hosted
   * style. Defaults to `true` for OCI — the namespace-prefixed host already
   * scopes lookups, and OCI's wildcard cert does not cover the additional
   * bucket subdomain, so virtual-hosted style typically fails TLS.
   */
  forcePathStyle?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing. For buckets with a
   * pre-authenticated request or a public visibility setting, point this
   * at the corresponding URL prefix; a custom domain via the OCI Web
   * Application Firewall / Load Balancer also works. When unset, `url()`
   * falls back to a presigned GetObject (default expiry: 1 hour).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   */
  defaultUrlExpiresIn?: number;
}

export type OracleCloudAdapter = Adapter<S3Client>;

export const oracleCloud = (
  opts: OracleCloudAdapterOptions
): OracleCloudAdapter => {
  const accessKeyId = opts.accessKeyId ?? readEnv("OCI_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("OCI_SECRET_ACCESS_KEY");

  if (!opts.namespace) {
    throw new FilesError(
      "Provider",
      "oracle-cloud adapter: missing namespace. Pass `namespace` (find it under Profile → Tenancy → Object Storage Namespace, or via `oci os ns get`)."
    );
  }
  if (!opts.region) {
    throw new FilesError(
      "Provider",
      'oracle-cloud adapter: missing region. Pass `region` (e.g. "us-ashburn-1").'
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "oracle-cloud adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set OCI_ACCESS_KEY_ID + OCI_SECRET_ACCESS_KEY."
    );
  }

  const endpoint =
    opts.endpoint ??
    `https://${opts.namespace}.compat.objectstorage.${opts.region}.oraclecloud.com`;

  const inner = s3({
    bucket: opts.bucket,
    credentials: { accessKeyId, secretAccessKey },
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    // OCI Object Storage's S3 compat layer is wire-compatible with S3;
    // relabel the default provider message so users don't see "S3 error".
    defaultProviderMessage: "Oracle Cloud error",
    endpoint,
    forcePathStyle: opts.forcePathStyle ?? true,
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
    region: opts.region,
  });

  return {
    ...inner,
    name: "oracle-cloud",
  };
};
