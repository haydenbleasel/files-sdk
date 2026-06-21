import type { S3Client } from "@aws-sdk/client-s3";
import type { Disk } from "disk";

import type { Adapter } from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { s3 } from "../s3/index.js";

/**
 * Regions that don't sit on the default cell and so can't be derived. New
 * regions normally need no entry here — add one only when a region lives
 * somewhere other than the default cell.
 */
const ENDPOINT_OVERRIDES: Record<string, string> = {
  "gcp-us-central1": "https://s3.blue.us-central1.gcp.prod.archil.com",
};

/**
 * Resolve an Archil region (`<cloud>-<geo>`, e.g. `aws-us-east-1`) to its
 * S3-compatible API origin. Most regions derive to
 * `https://s3.green.<geo>.<cloud>.prod.archil.com`; exceptions live in
 * `ENDPOINT_OVERRIDES`. Returns `undefined` for a value that isn't shaped like
 * `<cloud>-<geo>`.
 */
const endpointForRegion = (region: string): string | undefined => {
  if (ENDPOINT_OVERRIDES[region]) {
    return ENDPOINT_OVERRIDES[region];
  }
  const dash = region.indexOf("-");
  const cloud = dash > 0 ? region.slice(0, dash) : "";
  const geo = dash > 0 ? region.slice(dash + 1) : "";
  if (!(cloud && geo)) {
    return;
  }
  return `https://s3.green.${geo}.${cloud}.prod.archil.com`;
};

/**
 * The SigV4 signing region — the geographic part of the Archil region
 * (`aws-us-east-1` → `us-east-1`). Only the signing scope; it does not affect
 * routing.
 */
const signingRegion = (region: string): string =>
  region.replace(/^[a-z]+-/u, "");

export interface ArchilAdapterOptions {
  /** Archil S3 access key id. Falls back to `ARCHIL_S3_ACCESS_KEY_ID`. */
  accessKeyId?: string;
  /**
   * The disk id to scope operations to — Archil's equivalent of a bucket.
   * Optional only when a `disk` instance is passed instead.
   */
  bucket?: string;
  /**
   * Scope every operation to a branch of the disk instead of its main view.
   * Archil selects the branch via the bucket, so the entire unified surface —
   * `upload`, `download`, `list`, `url`, presigned uploads — transparently
   * reads and writes that branch. Omit for the disk's default branch. Must be
   * non-empty and contain no `/`.
   */
  branch?: string;
  /**
   * Default expiry, in seconds, for presigned URLs from `url()` when
   * `publicBaseUrl` is not set. Defaults to 3600.
   */
  defaultUrlExpiresIn?: number;
  /**
   * An Archil {@link Disk} (from the `disk` package). When provided, `bucket`
   * and `region` default to the instance's `id` and `region`, and it is
   * exposed at {@link ArchilAdapter.disk} — the door to Archil-native
   * operations (`exec`, `grep`, `appendObject`, `share`) that the S3 `raw`
   * client can't reach. Requires the optional `disk` peer dependency.
   */
  disk?: Disk;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` unsigned; otherwise `url()` mints a SigV4
   * presigned GetObject.
   */
  publicBaseUrl?: string;
  /**
   * Archil region, e.g. `aws-us-east-1` or `gcp-us-central1`. Defaults to the
   * `disk` instance's region when one is passed, else falls back to
   * `ARCHIL_REGION`. Selects which Archil endpoint the adapter talks to.
   */
  region?: string;
  /** Archil S3 secret access key. Falls back to `ARCHIL_S3_SECRET_ACCESS_KEY`. */
  secretAccessKey?: string;
}

export type ArchilAdapter = Adapter<S3Client> & {
  /** The branch this adapter is scoped to, if any. */
  readonly branch?: string;
  /**
   * The underlying Archil {@link Disk}, present only when the adapter was
   * constructed with a `disk` instance. The door to Archil-native operations
   * that aren't object storage — `exec`, `grep`, `mount`, `appendObject`,
   * `share` — which `raw` (the `S3Client`) can't reach:
   * `files.adapter.disk?.exec("ls -R /")`.
   */
  readonly disk?: Disk;
  /** The disk id this adapter is scoped to (without any branch suffix). */
  readonly diskId: string;
};

interface ResolvedConfig {
  accessKeyId: string;
  bucket: string;
  diskId: string;
  endpoint: string;
  region: string;
  secretAccessKey: string;
}

/** Resolve and validate options into the values the `s3()` adapter needs. */
const resolveConfig = (opts: ArchilAdapterOptions): ResolvedConfig => {
  const diskId = opts.bucket ?? opts.disk?.id;
  const region = opts.region ?? opts.disk?.region ?? readEnv("ARCHIL_REGION");
  const accessKeyId = opts.accessKeyId ?? readEnv("ARCHIL_S3_ACCESS_KEY_ID");
  const secretAccessKey =
    opts.secretAccessKey ?? readEnv("ARCHIL_S3_SECRET_ACCESS_KEY");

  if (!diskId) {
    throw new FilesError(
      "Provider",
      "archil adapter: missing `bucket` (disk id) or a `disk` instance."
    );
  }
  if (!region) {
    throw new FilesError(
      "Provider",
      "archil adapter: missing `region`. Pass `region` (e.g. aws-us-east-1), a `disk` instance, or set ARCHIL_REGION."
    );
  }
  const endpoint = endpointForRegion(region);
  if (!endpoint) {
    throw new FilesError(
      "Provider",
      `archil adapter: unknown region "${region}". Expected the form <cloud>-<geo>, e.g. aws-us-east-1.`
    );
  }
  if (!(accessKeyId && secretAccessKey)) {
    throw new FilesError(
      "Provider",
      "archil adapter: missing credentials. Pass `accessKeyId` + `secretAccessKey` or set ARCHIL_S3_ACCESS_KEY_ID + ARCHIL_S3_SECRET_ACCESS_KEY."
    );
  }
  const { branch } = opts;
  if (branch !== undefined && (branch === "" || branch.includes("/"))) {
    throw new FilesError(
      "Provider",
      `archil adapter: invalid branch ${JSON.stringify(branch)} (must be non-empty and contain no "/").`
    );
  }
  // Archil routes to a branch via the bucket name: `<diskId>.<branch>`.
  const bucket = branch ? `${diskId}.${branch}` : diskId;
  return { accessKeyId, bucket, diskId, endpoint, region, secretAccessKey };
};

/**
 * An Archil disk via its S3-compatible API. A thin wrapper around the `s3()`
 * adapter: the disk id is the path-style bucket, the endpoint is derived from
 * the Archil region, and SigV4 signs every request (so byte ranges, multipart,
 * presigned `url()`, and presigned `signedUploadUrl()` all work). Auto-loads
 * `ARCHIL_S3_ACCESS_KEY_ID` / `ARCHIL_S3_SECRET_ACCESS_KEY` / `ARCHIL_REGION`.
 *
 * Pass a `disk` instance (from the `disk` package) to infer `bucket`/`region`
 * and expose Archil-native operations at `adapter.disk`. Set `branch` to scope
 * the whole surface to a branch of the disk.
 */
export const archil = (opts: ArchilAdapterOptions): ArchilAdapter => {
  const { accessKeyId, bucket, diskId, endpoint, region, secretAccessKey } =
    resolveConfig(opts);

  const inner = s3({
    bucket,
    credentials: { accessKeyId, secretAccessKey },
    defaultProviderMessage: "Archil error",
    endpoint,
    // The bucket (disk id, optionally `.branch`) is path-addressed
    // (`/<bucket>/<key>`), so virtual-hosted style would break routing.
    forcePathStyle: true,
    region: signingRegion(region),
    ...(opts.defaultUrlExpiresIn !== undefined && {
      defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    }),
    ...(opts.publicBaseUrl && { publicBaseUrl: opts.publicBaseUrl }),
  });

  return {
    ...inner,
    diskId,
    name: "archil",
    ...(opts.branch && { branch: opts.branch }),
    ...(opts.disk && { disk: opts.disk }),
  };
};
