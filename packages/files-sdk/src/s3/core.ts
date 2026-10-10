import type * as ClientS3 from "@aws-sdk/client-s3";
import type { PutObjectCommandInput, S3ClientConfig } from "@aws-sdk/client-s3";
import type * as LibStorage from "@aws-sdk/lib-storage";
import type * as PresignedPost from "@aws-sdk/s3-presigned-post";
import type * as RequestPresigner from "@aws-sdk/s3-request-presigner";

import type {
  Adapter,
  AdapterDownloadOptions,
  AdapterUploadOptions,
  Body,
  ConditionalUploadResult,
  CopyCondition,
  DeleteManyOptions,
  DeleteManyResult,
  FileInfo,
  MultipartOptions,
  OperationOptions,
  PartMeta,
  PartsResumableDriver,
  ResumableDriverOptions,
  ResumableUploadSession,
  SignedUpload,
  StoredFile,
  UploadProgress,
  UploadOptions,
  UploadResult,
} from "../index.js";
import {
  DEFAULT_URL_EXPIRES_IN,
  existsByProbe,
  httpRangeHeader,
  isMultipartRequested,
  joinPublicUrl,
  makeErrorMapper,
  normalizeBody,
  resolveUrlStrategy,
} from "../internal/core.js";
import type { ErrorExtract } from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import type { ProviderFilesErrorCode } from "../internal/errors.js";
import { isObject } from "../internal/is.js";
import { inferTypeFromName } from "../internal/mime.js";
import { reportProgress } from "../internal/resumable.js";
import { abortError } from "../internal/retry.js";
import { createStoredFile } from "../internal/stored-file.js";
import {
  S3_MAX_COPY_OBJECT_SIZE,
  SIGV4_MAX_EXPIRES_IN,
  assertHeaderSafeUploadOptions,
  assertSigV4ExpiresIn,
  copyParts,
  isAwsEndpoint,
  isAwsHost,
  isUnsatisfiableRange,
  mayBeCopySizeRefusal,
} from "./shared.js";

/**
 * The subset of the `@aws-sdk/*` modules the S3 engine is built from. This
 * module only ever imports the SDK's *types* — the runtime values arrive
 * through this bundle, so nothing here puts `@aws-sdk/*` in the static import
 * graph. `files-sdk/s3` fills it from ordinary static imports (its consumers
 * install the SDK anyway); the lazy aws-sdk engine behind r2, minio, and
 * rustfs (`internal/s3-engine.ts`) fills it from dynamic imports, because
 * consumer bundlers resolve even dynamically-reached chunks at build time and
 * hard-error on a *static* import of an absent optional peer (rolldown-vite's
 * optional-peer-dep placeholder, #105).
 */
export interface S3Sdk {
  clientS3: Pick<
    typeof ClientS3,
    | "AbortMultipartUploadCommand"
    | "CompleteMultipartUploadCommand"
    | "CopyObjectCommand"
    | "CreateMultipartUploadCommand"
    | "DeleteObjectCommand"
    | "DeleteObjectsCommand"
    | "GetObjectCommand"
    | "HeadObjectCommand"
    | "ListObjectsV2Command"
    | "ListPartsCommand"
    | "PutObjectCommand"
    | "S3Client"
    | "UploadPartCommand"
    | "UploadPartCopyCommand"
  >;
  presignedPost: Pick<typeof PresignedPost, "createPresignedPost">;
  requestPresigner: Pick<typeof RequestPresigner, "getSignedUrl">;
}

export interface S3AdapterOptions {
  /** S3 bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * AWS region the bucket lives in (e.g. `us-east-1`). Falls back to
   * `AWS_REGION`, then `AWS_DEFAULT_REGION`; required if neither is set.
   */
  region?: string;
  /**
   * Override the S3 service endpoint. Use this to point at S3-compatible
   * services (DigitalOcean Spaces, Wasabi, Backblaze B2, LocalStack, etc.).
   *
   * With an explicit endpoint the client sends request checksums, and
   * validates response checksums, only when the operation requires them
   * (`requestChecksumCalculation` / `responseChecksumValidation` set to
   * `"WHEN_REQUIRED"`), because several S3-compatible services reject the
   * `x-amz-checksum-crc32` header newer SDKs add by default. Set
   * `AWS_REQUEST_CHECKSUM_CALCULATION` / `AWS_RESPONSE_CHECKSUM_VALIDATION`
   * to override.
   */
  endpoint?: string;
  /**
   * Use path-style addressing (`https://endpoint/bucket/key`) instead of
   * virtual-hosted style (`https://bucket.endpoint/key`). Required by some
   * S3-compatible services and by LocalStack.
   */
  forcePathStyle?: boolean;
  /**
   * Whether to expose the native conditional primitives (`If-Match` /
   * `If-None-Match` create, replace, exact read, delete, and copy).
   *
   * Defaults to `true` only when the client will talk to AWS S3: no
   * `endpoint` here and no `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL`
   * redirect in the environment, or one whose hostname is `amazonaws.com` /
   * `amazonaws.com.cn` (or a subdomain of either). S3-compatible services
   * differ in which conditional headers they honor, so the adapter fails
   * closed for them rather than risk an unconditional overwrite. The same
   * test decides whether the adapter declares S3 event records
   * (`capabilities.events`).
   *
   * A shared-config `endpoint_url` (profile- or service-level) is invisible
   * at construction, so it is caught at request time instead: a conditional
   * request whose resolved hostname is not `amazonaws.com` or
   * `amazonaws.com.cn` (or a subdomain of either) fails closed before it is
   * sent. AWS-hosted endpoints (VPC, FIPS, dual-stack, GovCloud, the China
   * regions) all resolve under those suffixes and need no override.
   *
   * Set `true` to opt an S3-compatible endpoint that you have verified
   * honors `If-Match` / `If-None-Match` in — this skips both the constructor
   * check and the request-time hostname check — or `false` to disable the
   * primitives on a canonical bucket.
   */
  conditional?: boolean;
  /**
   * Static credentials. Skip to use the AWS credential chain (env vars,
   * IAM role, shared profile, EC2/ECS/EKS instance metadata).
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing — appropriate for buckets
   * fronted by a CDN, public-read policy, or custom domain. When unset,
   * `url()` falls back to a presigned `GetObject` URL (see
   * {@link defaultUrlExpiresIn}). An explicit `url(key, { expiresIn })` or
   * `responseContentDisposition` still presigns even when this is set, since a
   * permanent link can't expire or carry the override.
   *
   * A trailing slash on the base is tolerated. Each key segment is
   * URL-encoded (the `/` separators are kept), so pass raw keys; a
   * pre-encoded key would be double-encoded.
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by
   * `url()` when no per-call `expiresIn` is given. Defaults to 3600 (1 hour).
   * Per-call `url(key, { expiresIn })` overrides.
   */
  defaultUrlExpiresIn?: number;
  /**
   * Override the fallback message used when an unknown error has no
   * `message` of its own, and the label on the adapter's own errors.
   * Internal — set by the S3-compatible wrappers (r2, minio, wasabi, …) so
   * their users see "R2 error" instead of "S3 error".
   * @internal
   */
  defaultProviderMessage?: string;
}

export type S3Adapter = Adapter<ClientS3.S3Client> & {
  readonly bucket: string;
};

const stripEtag = (etag: string | undefined): string | undefined => {
  if (!etag) {
    return;
  }
  return etag.replaceAll(/^"+|"+$/gu, "");
};

// Conditional requests accept one strong entity tag, not an HTTP list or
// wildcard. Keep the adapter boundary strict even when callers invoke the
// optional primitive directly instead of going through `Files` validation.
const CANONICAL_ETAG = /^(?!\*$)(?!W\/)[\u0021\u0023-\u002B\u002D-\u007E]+$/u;
const MAX_ETAG_LENGTH = 1024;

const assertCanonicalEtag = (etag: string): string => {
  if (etag.length > MAX_ETAG_LENGTH || !CANONICAL_ETAG.test(etag)) {
    throw new FilesError(
      "Invalid",
      "s3 adapter: conditional ETags must be canonical bare strong values"
    );
  }
  return etag;
};

const quoteCanonicalEtag = (etag: string): string =>
  `"${assertCanonicalEtag(etag)}"`;

function normalizeConditionalResponseEtag(
  etag: string | undefined,
  operation: string,
  required: true
): string;
function normalizeConditionalResponseEtag(
  etag: string | undefined,
  operation: string,
  required: false
): string | undefined;
function normalizeConditionalResponseEtag(
  etag: string | undefined,
  operation: string,
  required: boolean
): string | undefined {
  if (etag === undefined) {
    if (required) {
      throw new FilesError(
        "Provider",
        `S3 returned no ETag after ${operation}; the object may already have been committed`,
        undefined,
        { permanent: true }
      );
    }
    return;
  }
  const bare =
    etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"')
      ? etag.slice(1, -1)
      : etag;
  try {
    return assertCanonicalEtag(bare);
  } catch (error) {
    throw new FilesError(
      "Provider",
      `S3 returned an invalid ETag after ${operation}`,
      error,
      { permanent: true }
    );
  }
}

const abortOptions = (signal: AbortSignal | undefined) =>
  signal ? { abortSignal: signal } : undefined;

// Each conditional input field and the wire header it must serialize to. A
// client whose model predates the field leaves the header out, so the guard
// compares the built request against the input rather than trusting the
// peer range.
type ConditionalInputField = "CopySourceIfMatch" | "IfMatch" | "IfNoneMatch";

/** The conditional predicate fields a command input may carry. */
type ConditionalInput = Partial<Record<ConditionalInputField, string>>;

/** The HTTP request as seen at the middleware `build` step. */
interface BuiltRequest {
  headers?: Record<string, string | undefined>;
  hostname?: string;
}

const CONDITIONAL_HEADERS: readonly (readonly [
  ConditionalInputField,
  string,
])[] = [
  ["IfMatch", "if-match"],
  ["IfNoneMatch", "if-none-match"],
  ["CopySourceIfMatch", "x-amz-copy-source-if-match"],
];

/**
 * Build-step middleware that keeps a conditional request from ever going out
 * without its predicate on the wire, and — unless the caller opted in with
 * `conditional: true` — from going anywhere other than AWS. It runs after
 * serialization and endpoint resolution, so `args.request` is exactly what
 * would be sent: the resolved hostname covers an `endpoint` option, an
 * `AWS_ENDPOINT_URL*` variable, and a shared-config `endpoint_url` alike,
 * none of which the synchronous constructor can see. Generic over the
 * handler shapes so it slots into `middlewareStack.add` without pulling
 * `@smithy/types` in as a dependency.
 */
const conditionalRequestGuard =
  (allowAnyHost: boolean) =>
  <Args extends { input: unknown; request: unknown }, Result>(
    next: (args: Args) => Promise<Result>
  ) =>
  (args: Args): Promise<Result> => {
    // SAFETY: `input` is the command's typed input object; the SDK declares
    // every conditional field it may carry as an optional string.
    const input = args.input as ConditionalInput;
    const expected = CONDITIONAL_HEADERS.filter(
      ([field]) => input[field] !== undefined
    );
    // The common case: no predicate on this command, nothing to scan.
    if (expected.length === 0) {
      return next(args);
    }
    // SAFETY: this guard is registered at the `build` step, where the SDK
    // has already serialized `args.request` into its HttpRequest (headers +
    // resolved hostname).
    const request = args.request as BuiltRequest;
    if (!(allowAnyHost || isAwsHost(request.hostname ?? ""))) {
      throw new FilesError(
        "Unsupported",
        `s3 adapter: conditional requests are only sent to AWS S3, but this client resolves to ${request.hostname ?? "an unknown host"}; pass \`conditional: true\` to opt an S3-compatible endpoint in`
      );
    }
    const sent = new Set(
      Object.keys(request.headers ?? {}).map((name) => name.toLowerCase())
    );
    for (const [, header] of expected) {
      if (!sent.has(header)) {
        throw new FilesError(
          "Unsupported",
          `s3 adapter: the installed @aws-sdk/client-s3 did not serialize ${header}; conditional requests need 3.919.0 or newer`
        );
      }
    }
    return next(args);
  };

// The headers the SDK's flexible-checksums middleware adds to a PutObject.
const CHECKSUM_HEADER_PREFIX = "x-amz-checksum-";
const CHECKSUM_ALGORITHM_HEADER = "x-amz-sdk-checksum-algorithm";

/**
 * Build-step middleware for a presigned PutObject that drops the request
 * checksum headers. With the SDK's default `requestChecksumCalculation:
 * "WHEN_SUPPORTED"` the client computes a CRC32 of the request body, which
 * is empty when presigning, and the presigner hoists it into the URL
 * (`x-amz-checksum-crc32=AAAAAA==`). S3 then checks every upload through the
 * URL against the empty body's checksum and rejects real content. Registered
 * at low priority on the one command, so it runs after the checksum
 * middleware and leaves the client (and `files.raw`) untouched.
 */
const presignWithoutChecksum =
  <Args extends { request: unknown }, Result>(
    next: (args: Args) => Promise<Result>
  ) =>
  (args: Args): Promise<Result> => {
    // SAFETY: registered at the `build` step, where `args.request` is the
    // serialized HttpRequest; `headers` is read optionally all the same.
    const { headers } = args.request as BuiltRequest;
    for (const name of Object.keys(headers ?? {})) {
      const lower = name.toLowerCase();
      if (
        lower.startsWith(CHECKSUM_HEADER_PREFIX) ||
        lower === CHECKSUM_ALGORITHM_HEADER
      ) {
        // oxlint-disable-next-line typescript/no-dynamic-delete -- header names are dynamic by nature; this mutates the request built for this one presign
        delete headers?.[name];
      }
    }
    return next(args);
  };

const assertConditionalUploadOptions = (
  options: AdapterUploadOptions | undefined
): void => {
  // AdapterUploadOptions excludes both fields statically; retain a runtime
  // fail-closed guard for direct JavaScript/structural calls.
  // SAFETY: deliberately re-widens to the caller-facing UploadOptions fields
  // so an untyped caller's `control` / `multipart` are seen and rejected;
  // both reads below tolerate the fields being absent.
  const untrusted = options as
    | (AdapterUploadOptions & Pick<UploadOptions, "control" | "multipart">)
    | undefined;
  if (isMultipartRequested(untrusted?.multipart)) {
    throw new FilesError(
      "Invalid",
      "s3 adapter: conditional multipart uploads are not supported"
    );
  }
  if (untrusted?.control !== undefined) {
    throw new FilesError(
      "Invalid",
      "s3 adapter: resumable upload control is not supported for conditional uploads"
    );
  }
};

// `@aws-sdk/lib-storage` is an optional peer dependency, pulled in only when an
// upload needs the multipart/progress path: `multipart`, `onProgress`, or a
// `ReadableStream` body of unknown length. Loaded lazily so it isn't required
// by callers who only do plain single-request PutObject uploads; surfaces a
// clear error when missing. `Unsupported` (so never retried): a missing module
// fails every attempt the same way, so `retries` must not re-issue the upload.
// Exported (with an injectable importer) only so the missing-peer path is
// testable.
//
// The `import()` is awaited directly inside the `try` on purpose — see
// `loadS3Sdk` in ../internal/s3-engine.ts: it is the shape that lets a bundler
// (Wrangler's esbuild, Bun, webpack) build without the peer installed.
export const loadLibStorage = async (
  importLibStorage?: () => Promise<typeof LibStorage>
): Promise<typeof LibStorage> => {
  try {
    return importLibStorage
      ? await importLibStorage()
      : await import("@aws-sdk/lib-storage");
  } catch (error) {
    throw new FilesError(
      "Unsupported",
      "Multipart, progress, and unknown-length stream uploads on S3 require the optional peer dependency '@aws-sdk/lib-storage'. Install it to use the `multipart` or `onProgress` options, or to upload a `ReadableStream` body of unknown length.",
      error
    );
  }
};

// Default parts in flight, mirroring lib-storage's own `queueSize` default.
const MULTIPART_DEFAULT_CONCURRENCY = 4;

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

type MultipartInput = boolean | MultipartOptions | undefined;

// Every multipart part except the last must be at least 5 MiB (S3 rule), so
// clamp the requested part size up to that floor.
const S3_MIN_PART_SIZE = 5 * 1024 * 1024;

// A multipart upload holds at most 10,000 parts, each at most 5 GiB.
const S3_MAX_PARTS = 10_000;
const S3_MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;

/**
 * Grow the part size so `total` bytes fit in S3's 10,000-part limit (at the
 * 5 MiB default that is only ~48.8 GiB; past it S3 rejects part 10,001 after
 * everything before it has uploaded). Capped at the 5 GiB part maximum.
 */
const fitPartSizeToTotal = (partSize: number, total: number): number =>
  Math.min(
    Math.max(partSize, Math.ceil(total / S3_MAX_PARTS)),
    S3_MAX_PART_SIZE
  );

/**
 * Translate our {@link MultipartOptions} into the lib-storage `Upload` knobs.
 * `partSize` is omitted when unset so lib-storage's own sizing applies (5 MiB,
 * grown to fit 10,000 parts when the length is known).
 */
interface LibStorageUploadKnobs {
  partSize?: number;
  queueSize: number;
}

/**
 * A caller's `partSize`, rounded into what S3 accepts: at least 5 MiB, at
 * most 5 GiB, and, when the body's length is known, large enough to fit in
 * 10,000 parts. lib-storage uses an explicit size as-is, so a 1 MiB part
 * would fail every attempt with `EntityTooSmall` and an undersized one would
 * fail at part 10,001, after ~48.8 GiB had uploaded.
 */
const resolveUploadPartSize = (
  partSize: number,
  total: number | undefined
): number => {
  const bounded = Math.min(
    Math.max(partSize, S3_MIN_PART_SIZE),
    S3_MAX_PART_SIZE
  );
  return total === undefined ? bounded : fitPartSizeToTotal(bounded, total);
};

const resolveMultipart = (
  multipart: MultipartInput,
  total: number | undefined
): LibStorageUploadKnobs => {
  const opts = isObject(multipart) ? multipart : {};
  return {
    ...(opts.partSize !== undefined && {
      partSize: resolveUploadPartSize(opts.partSize, total),
    }),
    queueSize: opts.concurrency ?? MULTIPART_DEFAULT_CONCURRENCY,
  };
};

/**
 * Upload via `@aws-sdk/lib-storage`'s `Upload`, which transparently switches to
 * multipart for large bodies and falls back to a single PutObject for small
 * ones. Used for explicit `multipart`, for progress reporting, and for
 * unknown-length streams. Returns the (quote-stripped) ETag.
 */
const runLibStorageUpload = async (
  client: ClientS3.S3Client,
  params: PutObjectCommandInput,
  multipart: MultipartInput,
  onProgress: ((progress: UploadProgress) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<string | undefined> => {
  const { Upload } = await loadLibStorage();
  const { partSize, queueSize } = resolveMultipart(
    multipart,
    params.ContentLength
  );
  const upload = new Upload({
    client,
    params,
    queueSize,
    ...(partSize !== undefined && { partSize }),
    // Abort cleanly on failure so we don't leave dangling parts behind.
    leavePartsOnError: false,
  });
  if (onProgress) {
    upload.on("httpUploadProgress", (progress) => {
      onProgress({
        loaded: progress.loaded ?? 0,
        ...(progress.total !== undefined && { total: progress.total }),
      });
    });
  }
  // The Upload runs its own requests, so wire the abort signal to its abort()
  // rather than relying on a per-command abortSignal. The signal may already
  // have flipped during the awaits that ran before this (body normalization,
  // the lazy lib-storage import) — an "abort" listener never fires for that,
  // so check up front or the object would land after the caller was told the
  // upload failed.
  if (signal?.aborted) {
    await upload.abort();
    throw abortError(signal.reason);
  }
  const onAbort = () => {
    void upload.abort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await upload.done();
    return stripEtag(result.ETag);
  } finally {
    // Detach once the upload settles: a long-lived signal (a `Files`-level
    // default) would otherwise keep every finished Upload — and the body it
    // holds — reachable until that signal aborts.
    signal?.removeEventListener("abort", onAbort);
  }
};

const resolveResumablePartSize = (multipart: MultipartInput): number => {
  const partSize = isObject(multipart) ? multipart.partSize : undefined;
  return partSize && partSize > S3_MIN_PART_SIZE ? partSize : S3_MIN_PART_SIZE;
};

/**
 * Drive a pause-able / resumable upload over S3's native multipart API
 * (`CreateMultipartUpload` → `UploadPart` → `CompleteMultipartUpload`), with
 * `ListParts` for resume and `AbortMultipartUpload` for discard. Unlike the
 * `@aws-sdk/lib-storage` path used by plain `upload()`, this exposes the
 * `UploadId` so the session survives in a serializable token.
 */
const createS3ResumableDriver = (
  sdk: S3Sdk["clientS3"],
  client: ClientS3.S3Client,
  bucket: string,
  key: string,
  driverOpts: ResumableDriverOptions,
  wrapErr: (cause: unknown) => FilesError,
  providerLabel: string
): PartsResumableDriver => {
  const {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    HeadObjectCommand,
    ListPartsCommand,
    UploadPartCommand,
  } = sdk;
  let partSize = resolveResumablePartSize(driverOpts.multipart);
  let uploadId: string | undefined;
  // The type the session was created with, known when `begin` ran in this
  // process. A resume token doesn't carry it (see `complete`).
  let contentType: string | undefined;
  const requireUploadId = (): string => {
    if (uploadId === undefined) {
      // Only reachable by driving the driver out of order (a part, probe, or
      // complete before `begin` / `adopt`): a misuse, not a provider answer.
      throw new FilesError(
        "Invalid",
        "S3 resumable upload has no session: call begin() or adopt() first."
      );
    }
    return uploadId;
  };
  return {
    adopt(session: ResumableUploadSession) {
      if (session.provider !== "s3") {
        throw new FilesError(
          "Invalid",
          `Cannot resume a ${session.provider} session on an S3 adapter.`
        );
      }
      if (session.bucket !== bucket || session.key !== key) {
        throw new FilesError(
          "Invalid",
          "Resume token does not match this upload's bucket/key."
        );
      }
      ({ uploadId } = session);
      ({ partSize } = session);
    },
    async begin(meta): Promise<ResumableUploadSession> {
      assertHeaderSafeUploadOptions(providerLabel, {
        ...driverOpts,
        contentType: meta.contentType,
      });
      ({ contentType } = meta);
      // Pinned in the token below, so a resume slices on the same boundaries.
      partSize = fitPartSizeToTotal(partSize, meta.total);
      try {
        const result = await client.send(
          new CreateMultipartUploadCommand({
            Bucket: bucket,
            ContentType: meta.contentType,
            Key: key,
            ...(driverOpts.cacheControl && {
              CacheControl: driverOpts.cacheControl,
            }),
            ...(driverOpts.metadata && { Metadata: driverOpts.metadata }),
          })
        );
        if (!result.UploadId) {
          throw new FilesError("Provider", "S3 did not return an UploadId.");
        }
        uploadId = result.UploadId;
        return { bucket, key, partSize, provider: "s3", uploadId };
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async complete(parts: PartMeta[]): Promise<UploadResult> {
      let completed: ClientS3.CompleteMultipartUploadCommandOutput;
      try {
        completed = await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            MultipartUpload: {
              Parts: parts.map((part) => ({
                ETag: part.etag,
                PartNumber: part.partNumber,
              })),
            },
            UploadId: requireUploadId(),
          })
        );
      } catch (error) {
        throw wrapErr(error);
      }
      const etag = stripEtag(completed.ETag);
      const summedSize = parts.reduce((sum, part) => sum + part.size, 0);
      // Without a type from `begin` (a resumed session), approximate it from
      // the key, as `list()` does.
      const knownType = contentType ?? inferTypeFromName(key);
      // CompleteMultipartUpload doesn't return size/contentType; head the
      // object for authoritative metadata, mirroring upload()'s stream path.
      // Best-effort: the object has committed and the upload id is gone, so
      // a principal allowed PutObject but not HeadObject (or a transient HEAD
      // failure) must not turn a finished upload into an error whose resume
      // can only hit NoSuchUpload.
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key })
        );
        return {
          contentType: head.ContentType ?? knownType,
          etag,
          key,
          lastModified: head.LastModified?.getTime(),
          size: Number(head.ContentLength ?? summedSize),
        };
      } catch {
        return { contentType: knownType, etag, key, size: summedSize };
      }
    },
    async discard() {
      if (uploadId === undefined) {
        return;
      }
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
          })
        );
      } catch (error) {
        throw wrapErr(error);
      }
    },
    mode: "parts",
    get partSize() {
      return partSize;
    },
    async probe(): Promise<{ committedParts: PartMeta[] }> {
      try {
        const id = requireUploadId();
        const committedParts: PartMeta[] = [];
        let marker: string | undefined;
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- pagination: each page uses the PartNumberMarker from the previous response
          const page = await client.send(
            new ListPartsCommand({
              Bucket: bucket,
              Key: key,
              UploadId: id,
              ...(marker !== undefined && { PartNumberMarker: marker }),
            })
          );
          for (const part of page.Parts ?? []) {
            if (part.PartNumber !== undefined) {
              committedParts.push({
                partNumber: part.PartNumber,
                size: Number(part.Size ?? 0),
                ...(part.ETag && { etag: part.ETag }),
              });
            }
          }
          if (page.IsTruncated && page.NextPartNumberMarker) {
            marker = page.NextPartNumberMarker;
          } else {
            break;
          }
        }
        return { committedParts };
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async uploadPart({ partNumber, data, signal }): Promise<PartMeta> {
      try {
        const result = await client.send(
          new UploadPartCommand({
            Body: data,
            Bucket: bucket,
            Key: key,
            PartNumber: partNumber,
            UploadId: requireUploadId(),
          }),
          signal ? { abortSignal: signal } : undefined
        );
        return {
          partNumber,
          size: data.byteLength,
          ...(result.ETag && { etag: result.ETag }),
        };
      } catch (error) {
        throw wrapErr(error);
      }
    },
  };
};

const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

const S3_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  "NoSuchKey",
  "NotFound",
]);
// Credential failures. Most arrive as 403 and classify by status alone, but
// an expired or malformed session token is a 400 (`ExpiredToken`,
// `InvalidToken`), which would otherwise be a retried Provider error.
const S3_UNAUTH_CODES: ReadonlySet<string> = new Set([
  "AccessDenied",
  "ExpiredToken",
  "InvalidAccessKeyId",
  "InvalidToken",
  "SignatureDoesNotMatch",
]);
const S3_CONFLICT_CODES: ReadonlySet<string> = new Set(["PreconditionFailed"]);
const S3_RETRYABLE_CONDITIONAL_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "ConditionalRequestConflict",
]);
// `DeleteObjects` rejects requests with more than 1000 keys, so the bulk path
// has to chunk longer key lists into separate requests.
const S3_DELETE_BATCH_LIMIT = 1000;

/** The fields of an `@aws-sdk/client-s3` `S3ServiceException` we classify on. */
interface S3ServiceExceptionFields {
  $metadata?: { httpStatusCode?: number };
  Code?: string;
  message?: string;
  name?: string;
}

// The AWS SDK's message for an error response with no XML body to read a
// `<Message>` from: every failed HEAD, since a HEAD response has no body. It
// says nothing, so it's treated as no message at all.
const SDK_NO_BODY_MESSAGE = "UnknownError";
// What S3 puts in a GetObject 404's `NoSuchKey` body. A HEAD 404 (`head()`,
// `exists()`) has no body, so it gets the same text: a missing key reads the
// same whichever call found it. Kept in step with `internal/s3-fetch.ts`.
const S3_KEY_NOT_FOUND_MESSAGE = "The specified key does not exist.";

const ownS3Message = (
  e: S3ServiceExceptionFields | null | undefined
): string | undefined =>
  e?.message === SDK_NO_BODY_MESSAGE ? undefined : e?.message;

const extractS3Error = (cause: unknown): ErrorExtract => {
  // SAFETY: every field is read optionally; a thrown value that is not an
  // SDK exception (or not even an object) just yields no code/status/message.
  const e = cause as S3ServiceExceptionFields | null | undefined;
  const code = e?.name ?? e?.Code;
  const status = e?.$metadata?.httpStatusCode;
  const message =
    ownS3Message(e) ??
    (status === 404 && (!code || S3_NOT_FOUND_CODES.has(code))
      ? S3_KEY_NOT_FOUND_MESSAGE
      : undefined);
  return {
    ...(code && { code }),
    ...(message && { message }),
    ...(status !== undefined && { status }),
  };
};

const buildMapS3Error = (providerLabel = "S3 error") => {
  const mapDefault = makeErrorMapper({
    codes: {
      conflict: S3_CONFLICT_CODES,
      notFound: S3_NOT_FOUND_CODES,
      unauthorized: S3_UNAUTH_CODES,
    },
    extract: extractS3Error,
    providerLabel,
  });
  return (cause: unknown): FilesError => {
    if (cause instanceof FilesError) {
      return cause;
    }
    const extracted = extractS3Error(cause);
    // Unlike PreconditionFailed (412), AWS documents this 409 as a transient
    // race that clients should retry. Keep it Provider-coded so Files' retry
    // policy can safely reissue the same native conditional request.
    if (
      extracted.code &&
      S3_RETRYABLE_CONDITIONAL_CONFLICT_CODES.has(extracted.code)
    ) {
      return new FilesError(
        "Provider",
        extracted.message ?? providerLabel,
        cause
      );
    }
    // 416: the range starts past the end of the object. A provider answer,
    // so still `Provider`, but reissuing it can only fail the same way.
    if (isUnsatisfiableRange(extracted.code, extracted.status)) {
      return new FilesError(
        "Provider",
        extracted.message ?? providerLabel,
        cause,
        { permanent: true }
      );
    }
    return mapDefault(cause);
  };
};

const _defaultMapS3Error = buildMapS3Error();

/**
 * Map an `@aws-sdk/client-s3` error (or any thrown value with the same
 * shape) to a {@link FilesError} — e.g. for errors from calls made on
 * `files.raw`. The optional `messages` argument overrides the per-code
 * fallback strings used when the error carries no message of its own. (The
 * adapter itself, and the S3-compatible wrappers, relabel through
 * `defaultProviderMessage` instead.)
 */
export const mapS3Error = (
  cause: unknown,
  messages?: Partial<Record<ProviderFilesErrorCode, string>>
): FilesError => {
  if (!messages) {
    return _defaultMapS3Error(cause);
  }
  if (cause instanceof FilesError) {
    return cause;
  }
  // 2-arg form: the caller has provided per-code fallback strings.
  // Re-derive code/status, then prefer the original error's own message
  // (so server-side reasons surface) and fall back to the caller's table.
  // SAFETY: `message` is read optionally; a non-SDK (or non-object) thrown
  // value simply contributes no message of its own.
  const e = cause as S3ServiceExceptionFields | null | undefined;
  const wrapped = _defaultMapS3Error({
    ...(isObject(cause) && cause),
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined strips any spread-in message so mapping is by code only; null would be a real message value
    message: undefined,
  });
  // SAFETY: `wrapped` was built by `makeErrorMapper` from a plain object (never
  // a pass-through FilesError), and that mapper only ever assigns the four
  // provider-family codes.
  const code = wrapped.code as ProviderFilesErrorCode;
  return new FilesError(
    code,
    ownS3Message(e) ?? messages[code] ?? wrapped.message,
    cause,
    { permanent: wrapped.permanent }
  );
};

/**
 * Whether the client will talk to AWS S3. The endpoint it uses is the
 * explicit `endpoint`, else an `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL`
 * redirect (which `S3Client` honors on its own, in that order), else AWS
 * itself. An explicit AWS endpoint (regional, VPC, FIPS, dual-stack) is still
 * AWS, the same call `s3Fetch()` makes for its endpoint.
 */
const resolvesToAws = (endpoint: string | undefined): boolean => {
  const resolved =
    endpoint ?? readEnv("AWS_ENDPOINT_URL_S3") ?? readEnv("AWS_ENDPOINT_URL");
  return resolved === undefined || isAwsEndpoint(resolved);
};

export const createS3Adapter = (
  sdk: S3Sdk,
  opts: S3AdapterOptions
): S3Adapter => {
  const {
    clientS3: {
      AbortMultipartUploadCommand,
      CompleteMultipartUploadCommand,
      CopyObjectCommand,
      CreateMultipartUploadCommand,
      DeleteObjectCommand,
      DeleteObjectsCommand,
      GetObjectCommand,
      HeadObjectCommand,
      ListObjectsV2Command,
      PutObjectCommand,
      S3Client,
      UploadPartCopyCommand,
    },
    presignedPost: { createPresignedPost },
    requestPresigner: { getSignedUrl },
  } = sdk;
  const region =
    opts.region ?? readEnv("AWS_REGION") ?? readEnv("AWS_DEFAULT_REGION");
  if (!region) {
    throw new FilesError(
      "Invalid",
      "s3 adapter: missing region. Pass `region` or set AWS_REGION."
    );
  }

  // `@aws-sdk/client-s3` 3.729+ computes a CRC32 checksum for every
  // PutObject / UploadPart (and puts `x-amz-checksum-crc32` on presigned PUT
  // URLs) by default. Several S3-compatible services reject the header, so
  // for an explicit `endpoint` fall back to the pre-3.729 behavior: checksums
  // only where the operation requires one. The standard env vars still win.
  const checksumsWhenRequired = Boolean(opts.endpoint);
  const config: S3ClientConfig = {
    region,
    ...(opts.endpoint && { endpoint: opts.endpoint }),
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.credentials && { credentials: opts.credentials }),
    ...(checksumsWhenRequired &&
      readEnv("AWS_REQUEST_CHECKSUM_CALCULATION") === undefined && {
        requestChecksumCalculation: "WHEN_REQUIRED",
      }),
    ...(checksumsWhenRequired &&
      readEnv("AWS_RESPONSE_CHECKSUM_VALIDATION") === undefined && {
        responseChecksumValidation: "WHEN_REQUIRED",
      }),
  };

  const client = new S3Client(config);
  // A no-op unless the command carries a conditional input. Two gaps it
  // closes at the last moment before the wire: the SDK-version gap (the peer
  // floor is advisory, and a `@aws-sdk/client-s3` predating a conditional
  // input field — CopyObject `IfMatch` / `IfNoneMatch` arrived in 3.919.0 —
  // accepts the field and silently omits the header), and the endpoint gap
  // (a shared-config `endpoint_url` redirects the client to a service whose
  // conditional support is unknown, and only the resolved request shows it).
  client.middlewareStack.add(
    conditionalRequestGuard(opts.conditional === true),
    {
      name: "filesSdkConditionalRequestGuard",
      step: "build",
    }
  );
  const { bucket } = opts;
  const { publicBaseUrl } = opts;
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;
  const wrapErr = opts.defaultProviderMessage
    ? buildMapS3Error(opts.defaultProviderMessage)
    : mapS3Error;
  const providerLabel = opts.defaultProviderMessage ?? "S3 error";
  // Canonical AWS only, unless the caller says otherwise: an endpoint that
  // isn't an AWS host points at a service whose conditional-header support is
  // unknown, so the primitives stay off and every conditional call fails
  // closed before provider I/O. The same trust decides whether a multipart
  // copy pins its parts to the source's ETag.
  const canonicalAws = resolvesToAws(opts.endpoint);
  const nativeConditional = opts.conditional ?? canonicalAws;

  const signGet = (
    key: string,
    expiresIn: number,
    responseContentDisposition?: string
  ): Promise<string> =>
    getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(responseContentDisposition && {
          ResponseContentDisposition: responseContentDisposition,
        }),
      }),
      { expiresIn }
    );

  // One request builder per verb, shared by the ordinary method and its
  // conditional twin so a predicate is the *only* thing that differs on the
  // wire — a header added, a metadata encoding fixed, a Content-Length
  // fallback changed on one path reaches the other automatically.
  const putParams = (
    key: string,
    normalized: Awaited<ReturnType<typeof normalizeBody>>,
    options: AdapterUploadOptions | undefined
  ) => ({
    Body: normalized.data,
    Bucket: bucket,
    ContentType: normalized.contentType,
    Key: key,
    ...(options?.cacheControl && { CacheControl: options.cacheControl }),
    ...(options?.metadata && { Metadata: options.metadata }),
    ...(normalized.contentLength !== undefined && {
      ContentLength: normalized.contentLength,
    }),
  });

  const getObject = (
    key: string,
    downloadOpts: AdapterDownloadOptions | undefined,
    predicate?: { IfMatch: string }
  ) =>
    client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...predicate,
        // S3 replies 206 with ContentLength set to the slice length and a
        // ranged body, so the size/byte handling below needs no special
        // casing — the range just rides along on the GET.
        ...(downloadOpts?.range && {
          Range: httpRangeHeader(downloadOpts.range),
        }),
      }),
      abortOptions(downloadOpts?.signal)
    );

  // Turn a GetObject response into a StoredFile: a lazy stream that trusts
  // S3's ContentLength (falling back to 0 only if the header is missing,
  // which is rare in practice), or a buffer whose size is the real byte
  // length so what we surface always matches what the caller can read.
  const toStoredFile = async (
    result: ClientS3.GetObjectCommandOutput,
    meta: { etag: string | undefined; key: string },
    downloadOpts: AdapterDownloadOptions | undefined
  ): Promise<StoredFile> => {
    const baseMeta = {
      ...meta,
      contentType: result.ContentType ?? DEFAULT_CONTENT_TYPE,
      lastModified: result.LastModified?.getTime(),
      metadata: result.Metadata,
    };
    if (downloadOpts?.as === "stream") {
      const stream = result.Body?.transformToWebStream();
      return createStoredFile(
        { ...baseMeta, size: Number(result.ContentLength ?? 0) },
        { factory: () => stream ?? emptyStream(), kind: "stream" }
      );
    }
    const bytes =
      (await result.Body?.transformToByteArray()) ?? new Uint8Array();
    return createStoredFile(
      { ...baseMeta, size: bytes.byteLength },
      { data: bytes, kind: "buffer" }
    );
  };

  // CopySource must be URL-encoded per
  // https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html.
  // S3 bucket naming rules don't require encoding in practice, but we
  // encode both halves defensively in case a custom endpoint (e.g.
  // MinIO) accepts looser names. `Key:` is passed unencoded — the SDK
  // signs and serializes it as part of the request, not as a URL value.
  const copySource = (from: string): string =>
    `${encodeURIComponent(bucket)}/${encodeURIComponent(from)}`;

  const copyObject = (
    from: string,
    to: string,
    operationOpts: OperationOptions | undefined,
    predicate?: Pick<
      ClientS3.CopyObjectCommandInput,
      "CopySourceIfMatch" | "IfMatch" | "IfNoneMatch"
    >
  ) =>
    client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: copySource(from),
        Key: to,
        ...predicate,
      }),
      abortOptions(operationOpts?.signal)
    );

  /**
   * After a failed `CopyObject`: the source's HEAD when the failure was S3
   * refusing a source over CopyObject's 5 GiB ceiling, else `undefined` (the
   * original error stands). The refusal's code is ambiguous, so the HEAD
   * confirms the size; it runs only on that failure path.
   */
  const oversizedCopySource = async (
    from: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever CopyObject rejected with
    error: unknown,
    operationOpts: OperationOptions | undefined
  ): Promise<ClientS3.HeadObjectCommandOutput | undefined> => {
    const { code, status } = extractS3Error(error);
    if (!mayBeCopySizeRefusal(code, status)) {
      return;
    }
    let head: ClientS3.HeadObjectCommandOutput;
    try {
      head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: from }),
        abortOptions(operationOpts?.signal)
      );
    } catch {
      return;
    }
    return Number(head.ContentLength ?? 0) > S3_MAX_COPY_OBJECT_SIZE
      ? head
      : undefined;
  };

  /**
   * Copy a source over CopyObject's 5 GiB ceiling with S3's multipart copy:
   * CreateMultipartUpload carrying the headers and user metadata CopyObject
   * would have copied (object tags are not carried), one UploadPartCopy per
   * range, then CompleteMultipartUpload. Where conditional headers are
   * trusted (AWS, or `conditional: true`), every part is pinned to the HEAD's
   * ETag, so a source overwritten mid-copy fails as `Conflict` instead of
   * splicing two versions. Any failure aborts the upload so no parts linger.
   */
  const multipartCopy = async (
    from: string,
    to: string,
    source: ClientS3.HeadObjectCommandOutput,
    operationOpts: OperationOptions | undefined
  ): Promise<void> => {
    const abortOpt = abortOptions(operationOpts?.signal);
    const created = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: to,
        ...(source.CacheControl && { CacheControl: source.CacheControl }),
        ...(source.ContentDisposition && {
          ContentDisposition: source.ContentDisposition,
        }),
        ...(source.ContentEncoding && {
          ContentEncoding: source.ContentEncoding,
        }),
        ...(source.ContentLanguage && {
          ContentLanguage: source.ContentLanguage,
        }),
        ...(source.ContentType && { ContentType: source.ContentType }),
        ...(source.Expires && { Expires: source.Expires }),
        ...(source.Metadata && { Metadata: source.Metadata }),
      }),
      abortOpt
    );
    const uploadId = created.UploadId;
    if (!uploadId) {
      throw new FilesError(
        "Provider",
        `${providerLabel}: CreateMultipartUpload returned no UploadId for the multipart copy`
      );
    }
    const pin =
      nativeConditional && source.ETag
        ? { CopySourceIfMatch: source.ETag }
        : undefined;
    try {
      const parts: ClientS3.CompletedPart[] = [];
      for (const part of copyParts(Number(source.ContentLength))) {
        // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- sequential part copies, so a failure stops the copy and the abort below leaves no part in flight
        const result = await client.send(
          new UploadPartCopyCommand({
            Bucket: bucket,
            CopySource: copySource(from),
            CopySourceRange: `bytes=${part.start}-${part.end}`,
            Key: to,
            PartNumber: part.partNumber,
            UploadId: uploadId,
            ...pin,
          }),
          abortOpt
        );
        parts.push({
          ETag: result.CopyPartResult?.ETag,
          PartNumber: part.partNumber,
        });
      }
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: to,
          MultipartUpload: { Parts: parts },
          UploadId: uploadId,
        }),
        abortOpt
      );
    } catch (error) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: to,
            UploadId: uploadId,
          })
        );
      } catch {
        // Best-effort: the copy's own failure is the one to report, and an
        // unaborted upload is reclaimed by the bucket's lifecycle rules.
      }
      throw error;
    }
  };

  const deleteObject = (
    key: string,
    operationOpts: OperationOptions | undefined,
    predicate?: { IfMatch: string }
  ) =>
    client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key, ...predicate }),
      abortOptions(operationOpts?.signal)
    );

  const conditionalUpload = async (
    key: string,
    body: Body,
    condition: { type: "create" } | { type: "replace"; etag: string },
    options?: AdapterUploadOptions
  ): Promise<ConditionalUploadResult> => {
    assertConditionalUploadOptions(options);
    assertHeaderSafeUploadOptions(providerLabel, options);
    const predicate =
      condition.type === "create"
        ? { IfNoneMatch: "*" }
        : { IfMatch: quoteCanonicalEtag(condition.etag) };
    const normalized = await normalizeBody(body, options?.contentType);
    // `normalizeBody` never sizes a stream, so this rejects every stream
    // body: PutObject with a predicate needs Content-Length up front, and
    // there is no multipart fallback for conditional writes.
    if (
      normalized.data instanceof ReadableStream &&
      normalized.contentLength === undefined
    ) {
      throw new FilesError(
        "Invalid",
        "s3 adapter: conditional uploads do not accept stream bodies; buffer to a Blob or Uint8Array first"
      );
    }
    const total = normalized.contentLength ?? 0;
    reportProgress(options?.onProgress, { loaded: 0, total });
    try {
      const result = await client.send(
        new PutObjectCommand({
          ...putParams(key, { ...normalized, contentLength: total }, options),
          ...predicate,
        }),
        abortOptions(options?.signal)
      );
      const etag = normalizeConditionalResponseEtag(
        result.ETag,
        "a conditional upload",
        true
      );
      reportProgress(options?.onProgress, { loaded: total, total });
      return { contentType: normalized.contentType, etag, key, size: total };
    } catch (error) {
      throw wrapErr(error);
    }
  };

  const conditionalDownload = async (
    key: string,
    etag: string,
    downloadOpts?: AdapterDownloadOptions
  ): Promise<StoredFile> => {
    const canonicalEtag = assertCanonicalEtag(etag);
    try {
      const result = await getObject(key, downloadOpts, {
        IfMatch: quoteCanonicalEtag(canonicalEtag),
      });
      const responseEtag = normalizeConditionalResponseEtag(
        result.ETag,
        "an exact read",
        false
      );
      if (responseEtag !== undefined && responseEtag !== canonicalEtag) {
        throw new FilesError(
          "Provider",
          "S3 returned an ETag that did not match the exact-read predicate",
          undefined,
          { permanent: true }
        );
      }
      // S3 validated If-Match even when a test double/proxy omits ETag from
      // the response, so retain the exact canonical predicate as provenance.
      return await toStoredFile(
        result,
        { etag: responseEtag ?? canonicalEtag, key },
        downloadOpts
      );
    } catch (error) {
      throw wrapErr(error);
    }
  };

  const conditional: S3Adapter["conditional"] = nativeConditional
    ? {
        copy: {
          atomicSourceDestination: true,
          destinationCreate: true,
          destinationReplace: true,
          async run(
            from: string,
            to: string,
            condition: CopyCondition,
            operationOpts
          ): Promise<void> {
            const destinationPredicate =
              condition.destination.type === "create"
                ? { IfNoneMatch: "*" }
                : {
                    IfMatch: quoteCanonicalEtag(condition.destination.etag),
                  };
            try {
              await copyObject(from, to, operationOpts, {
                CopySourceIfMatch: quoteCanonicalEtag(condition.source.etag),
                ...destinationPredicate,
              });
            } catch (error) {
              // A multipart copy can't carry the destination predicate in the
              // one atomic request this primitive promises, so a source over
              // CopyObject's 5 GiB ceiling is refused rather than copied.
              if (await oversizedCopySource(from, error, operationOpts)) {
                throw new FilesError(
                  "Unsupported",
                  `${providerLabel}: a conditional copy is one CopyObject request, which S3 limits to 5 GiB sources; "${from}" is larger. Copy it without a condition (a multipart copy), or check the condition yourself first.`,
                  error
                );
              }
              throw wrapErr(error);
            }
          },
          sourceEtag: true,
        },
        create(key, body, options) {
          return conditionalUpload(key, body, { type: "create" }, options);
        },
        async delete(key, etag, operationOpts): Promise<void> {
          try {
            await deleteObject(key, operationOpts, {
              IfMatch: quoteCanonicalEtag(etag),
            });
          } catch (error) {
            throw wrapErr(error);
          }
        },
        exactRead: conditionalDownload,
        replace(key, body, etag, options) {
          return conditionalUpload(
            key,
            body,
            { etag, type: "replace" },
            options
          );
        },
      }
    : undefined;

  return {
    bucket,
    capabilities: {
      cacheControl: true,
      delimiter: "any",
      // AWS S3 notifications (Lambda, SQS, SNS, EventBridge) are S3
      // `Records[]`. An S3-compatible endpoint may or may not send that shape,
      // so a wrapper that's verified to declares it itself.
      events: canonicalAws ? { format: "s3" } : false,
      metadata: true,
      // A plain `url(key)` returns the permanent `publicBaseUrl` link when one
      // is configured; an explicit `expiresIn` still signs.
      publicUrl: Boolean(publicBaseUrl),
      rangeRead: true,
      // `copy()` issues a CopyObject — server-side, no body round-trip.
      serverSideCopy: true,
      // A `maxSize` switches `signedUploadUrl()` to a presigned POST whose
      // policy enforces `content-length-range` (and binds `Content-Type`); the
      // presigned PUT signs `Content-Type` too, and a positive `minSize`
      // without `maxSize` throws. Both throw past SigV4's one-week ceiling.
      signedUpload: {
        contentType: true,
        maxExpiresIn: SIGV4_MAX_EXPIRES_IN,
        maxSize: true,
        supported: true,
      },
      // `url()` SigV4-signs a GetObject request. SigV4 caps a presigned URL's
      // lifetime at 604800s (7 days) and the SDK's presigner enforces it in
      // code for every endpoint, AWS or S3-compatible, so it's a hard ceiling.
      // `responseContentDisposition` is bound as `response-content-disposition`.
      signedUrl: {
        disposition: true,
        expiry: "exact",
        maxExpiresIn: SIGV4_MAX_EXPIRES_IN,
        supported: true,
      },
      // `upload()` reports byte-level progress through lib-storage's `Upload`
      // whenever `onProgress` is set.
      uploadProgress: true,
    },
    ...(conditional && { conditional }),
    async copy(from, to, operationOpts) {
      try {
        await copyObject(from, to, operationOpts);
      } catch (error) {
        // CopyObject copies at most 5 GiB; past that, S3 needs the multipart
        // copy API, which keeps the copy server-side.
        const source = await oversizedCopySource(from, error, operationOpts);
        if (!source) {
          throw wrapErr(error);
        }
        try {
          await multipartCopy(from, to, source, operationOpts);
        } catch (copyError) {
          throw wrapErr(copyError);
        }
      }
    },
    async delete(key, operationOpts) {
      try {
        await deleteObject(key, operationOpts);
      } catch (error) {
        throw wrapErr(error);
      }
    },
    // oxlint-disable-next-line sonarjs/cognitive-complexity -- two well-separated paths (stopOnError sequential vs chunked batch merge), each test-covered; splitting would obscure the shared result shape
    async deleteMany(
      keys: string[],
      deleteOpts?: DeleteManyOptions
    ): Promise<DeleteManyResult> {
      if (keys.length === 0) {
        return { results: [] };
      }
      if (deleteOpts?.stopOnError) {
        const deleted: string[] = [];
        const errors: NonNullable<DeleteManyResult["errors"]> = [];
        for (const key of keys) {
          try {
            // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- stopOnError: sequential deletes that early-exit on the first failure
            await client.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: key })
            );
            deleted.push(key);
          } catch (error) {
            errors.push({ error: wrapErr(error), key });
            return { errors, results: deleted };
          }
        }
        return { results: deleted };
      }
      const deletedKeys = new Set<string>();
      const errors: NonNullable<DeleteManyResult["errors"]> = [];
      // `DeleteObjects` caps each request at 1000 keys; send in chunks and
      // merge the per-key results so callers see one combined result.
      for (let start = 0; start < keys.length; start += S3_DELETE_BATCH_LIMIT) {
        const batch = keys.slice(start, start + S3_DELETE_BATCH_LIMIT);
        try {
          // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- chunked batch deletes merged into shared result accumulators in request order
          const result = await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: batch.map((key) => ({ Key: key })) },
            })
          );
          for (const item of result.Deleted ?? []) {
            if (item.Key !== undefined) {
              deletedKeys.add(item.Key);
            }
          }
          for (const item of result.Errors ?? []) {
            errors.push({
              error: wrapErr({
                Code: item.Code,
                message: item.Message ?? item.Code ?? "Delete failed",
                name: item.Code,
              }),
              key: item.Key ?? "",
            });
          }
        } catch (error) {
          // The whole batch failed — S3 doesn't tell us which keys, so map
          // the error onto every key in this batch and keep going.
          const mapped = wrapErr(error);
          for (const key of batch) {
            errors.push({ error: mapped, key });
          }
        }
      }
      const deleted = keys.filter((key) => deletedKeys.has(key));
      if (errors.length === 0) {
        return { results: deleted };
      }
      return { errors, results: deleted };
    },
    async download(key, downloadOpts) {
      try {
        const result = await getObject(key, downloadOpts);
        return await toStoredFile(
          result,
          { etag: stripEtag(result.ETag), key },
          downloadOpts
        );
      } catch (error) {
        throw wrapErr(error);
      }
    },
    exists(key, operationOpts) {
      return existsByProbe(
        () =>
          client.send(
            new HeadObjectCommand({ Bucket: bucket, Key: key }),
            operationOpts?.signal
              ? { abortSignal: operationOpts.signal }
              : undefined
          ),
        wrapErr
      );
    },
    async head(key, operationOpts) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
          operationOpts?.signal
            ? { abortSignal: operationOpts.signal }
            : undefined
        );
        return {
          contentType: result.ContentType ?? DEFAULT_CONTENT_TYPE,
          etag: stripEtag(result.ETag),
          key,
          lastModified: result.LastModified?.getTime(),
          metadata: result.Metadata,
          size: Number(result.ContentLength ?? 0),
        };
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async list(options) {
      try {
        const result = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ...(options?.prefix && { Prefix: options.prefix }),
            ...(options?.limit !== undefined && { MaxKeys: options.limit }),
            ...(options?.cursor && { ContinuationToken: options.cursor }),
            ...(options?.delimiter && { Delimiter: options.delimiter }),
          }),
          options?.signal ? { abortSignal: options.signal } : undefined
        );
        const items: FileInfo[] = (result.Contents ?? []).map((obj) => {
          const objKey = obj.Key ?? "";
          return {
            // `ListObjectsV2` carries no `Content-Type`, so approximate it
            // from the key rather than labelling every object as a binary
            // blob. Unknown extensions still fall back to
            // `DEFAULT_CONTENT_TYPE`.
            contentType: inferTypeFromName(objKey),
            etag: stripEtag(obj.ETag),
            key: objKey,
            lastModified: obj.LastModified?.getTime(),
            size: Number(obj.Size ?? 0),
          };
        });
        const prefixes = (result.CommonPrefixes ?? [])
          .map((p) => p.Prefix)
          .filter((p): p is string => p !== undefined);
        return {
          cursor: result.IsTruncated ? result.NextContinuationToken : undefined,
          items,
          ...(prefixes.length && { prefixes }),
        };
      } catch (error) {
        throw wrapErr(error);
      }
    },
    name: "s3",
    raw: client,
    resumableUpload(key, resumableOpts) {
      return createS3ResumableDriver(
        sdk.clientS3,
        client,
        bucket,
        key,
        resumableOpts,
        wrapErr,
        providerLabel
      );
    },
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      // Both the presigned POST and the presigned PUT are SigV4, so both hit
      // the one-week ceiling.
      assertSigV4ExpiresIn(providerLabel, signOpts.expiresIn);
      // The presigned PUT signs `Content-Type` as a header, which the
      // uploader must then send byte-for-byte.
      assertHeaderSafeUploadOptions(providerLabel, {
        contentType: signOpts.contentType,
      });
      // A size floor rides on the POST policy's `content-length-range`, which
      // only `maxSize` selects. A presigned PUT has no size condition at all,
      // so a positive `minSize` on its own can't be enforced. (`0` asks for
      // nothing, so it holds trivially.)
      if (
        signOpts.maxSize === undefined &&
        signOpts.minSize !== undefined &&
        signOpts.minSize > 0
      ) {
        throw new FilesError(
          "Unsupported",
          `${providerLabel}: \`minSize\` is enforced only by the presigned POST policy that \`maxSize\` selects; a presigned PUT has no size condition. Pass \`maxSize\` as well, or omit \`minSize\`.`
        );
      }
      try {
        if (signOpts.maxSize !== undefined) {
          const minSize = signOpts.minSize ?? 1;
          const conditions: NonNullable<
            PresignedPost.PresignedPostOptions["Conditions"]
          > = [["content-length-range", minSize, signOpts.maxSize]];
          if (signOpts.contentType) {
            conditions.push(["eq", "$Content-Type", signOpts.contentType]);
          }
          const post = await createPresignedPost(client, {
            Bucket: bucket,
            Conditions: conditions,
            Expires: signOpts.expiresIn,
            Key: key,
            ...(signOpts.contentType && {
              Fields: { "Content-Type": signOpts.contentType },
            }),
          });
          return { fields: post.fields, method: "POST", url: post.url };
        }
        const command = new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(signOpts.contentType && { ContentType: signOpts.contentType }),
        });
        command.middlewareStack.add(presignWithoutChecksum, {
          name: "filesSdkPresignWithoutChecksum",
          priority: "low",
          step: "build",
        });
        // The presigner always adds `content-type` to its unsignable set, so
        // without an override the URL is signed over `host` alone and the
        // Content-Type is advisory: a client could PUT any type. Opting it into
        // `signableHeaders` (which wins over the unsignable set in
        // `@smithy/signature-v4`) binds it, so a mismatched type gets a 403 —
        // matching the fetch engine, whose `allHeaders` signs it too.
        const url = await getSignedUrl(client, command, {
          expiresIn: signOpts.expiresIn,
          ...(signOpts.contentType && {
            signableHeaders: new Set(["content-type"]),
          }),
        });
        return {
          headers: signOpts.contentType
            ? { "Content-Type": signOpts.contentType }
            : undefined,
          method: "PUT",
          url,
        };
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async upload(key, body, options) {
      const { multipart, onProgress, signal } = options ?? {};
      assertHeaderSafeUploadOptions(providerLabel, options);
      const normalized = await normalizeBody(body, options?.contentType);
      const { data, contentType, contentLength } = normalized;
      const params = putParams(key, normalized, options);
      // lib-storage's Upload is the path for explicit multipart, for progress
      // reporting, and for unknown-length streams — a single PutObject can't
      // reliably send a stream without a Content-Length, so auto-engage there.
      const isUnsizedStream =
        data instanceof ReadableStream && contentLength === undefined;
      const useUpload =
        Boolean(onProgress) ||
        isMultipartRequested(multipart) ||
        isUnsizedStream;
      const abortOpt = signal ? { abortSignal: signal } : undefined;
      try {
        let etag: string | undefined;
        if (useUpload) {
          etag = await runLibStorageUpload(
            client,
            params,
            multipart,
            onProgress,
            signal
          );
        } else {
          const result = await client.send(
            new PutObjectCommand(params),
            abortOpt
          );
          etag = stripEtag(result.ETag);
        }
        let size = contentLength;
        let lastModified: number | undefined;
        // Stream bodies have no locally computed length; PutObject's response
        // doesn't carry size either. Do a follow-up head() to surface the
        // authoritative size and lastModified instead of silently returning 0.
        if (size === undefined) {
          try {
            const head = await client.send(
              new HeadObjectCommand({ Bucket: bucket, Key: key }),
              abortOpt
            );
            size = Number(head.ContentLength ?? 0);
            lastModified = head.LastModified?.getTime();
          } catch {
            size = 0;
          }
        }
        return {
          contentType,
          etag,
          key,
          lastModified,
          size,
        } satisfies UploadResult;
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async url(key, urlOpts) {
      const strategy = resolveUrlStrategy({
        expiresIn: urlOpts?.expiresIn,
        publicBaseUrl,
        responseContentDisposition: urlOpts?.responseContentDisposition,
      });
      if (strategy === "public" && publicBaseUrl) {
        return joinPublicUrl(publicBaseUrl, key);
      }
      const expiresIn = urlOpts?.expiresIn ?? defaultUrlExpiresIn;
      assertSigV4ExpiresIn(providerLabel, expiresIn);
      try {
        return await signGet(
          key,
          expiresIn,
          urlOpts?.responseContentDisposition
        );
      } catch (error) {
        throw wrapErr(error);
      }
    },
  };
};
