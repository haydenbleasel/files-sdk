import type {
  AdapterCapabilityDeclaration,
  SignUploadOptions,
} from "../index.js";
import { FilesError } from "../internal/errors.js";

// Rules both S3 engines apply identically: the `@aws-sdk/client-s3` engine in
// ./core.ts and the aws4fetch engine in ../internal/s3-fetch.ts. Nothing here
// imports either engine or any `@aws-sdk/*` module, so the fetch engine can
// share it without pulling the SDK (or core.ts) into a Worker bundle.

// Canonical AWS S3 hostnames. VPC / FIPS / dual-stack / GovCloud endpoints
// all live under these suffixes; S3-compatible services never do.
const AWS_HOST_SUFFIXES = ["amazonaws.com", "amazonaws.com.cn"];

/** Whether `hostname` is AWS S3 (`amazonaws.com`, `amazonaws.com.cn`, or a subdomain). */
export const isAwsHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return AWS_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
};

/**
 * Whether an endpoint URL points at AWS S3. An unparseable endpoint is not
 * AWS: the AWS-only defaults (conditional requests, S3 event records) fail
 * closed for it.
 */
export const isAwsEndpoint = (endpoint: string): boolean => {
  try {
    return isAwsHost(new URL(endpoint).hostname);
  } catch {
    return false;
  }
};

// An HTTP field name is an RFC 9110 token.
const HTTP_TOKEN = /^[\w!#$%&'*+.^`|~-]+$/u;
// Tab and printable ASCII: the only header-value bytes every S3 path sends
// and signs the same way. Node and fetch put a Latin-1 character (U+0080 to
// U+00FF) on the wire as its single byte, but both SigV4 signers (the AWS
// SDK's and aws4fetch) hash the value as UTF-8, two bytes, so the server's
// signature never matches and the request fails as `SignatureDoesNotMatch`.
// Past U+00FF, and for CR, LF, and NUL, the HTTP client refuses outright.
const INVALID_HEADER_VALUE = /[^\t -~]/u;

const HEADER_VALUE_RULE =
  "which accept only printable ASCII without control characters; encode the value first (e.g. with encodeURIComponent)";

/**
 * Reject user metadata that can't travel as an `x-amz-meta-*` header before
 * any request is built. Sent anyway, it fails as a signature mismatch
 * (`Unauthorized`) or an unclassified client error the retry policy
 * reissues, and only after the body was prepared. It's the caller's input
 * that's wrong, so it's `Invalid`.
 */
export const assertHeaderSafeMetadata = (
  label: string,
  metadata: Record<string, string> | undefined
): void => {
  for (const [name, value] of Object.entries(metadata ?? {})) {
    if (!HTTP_TOKEN.test(name)) {
      throw new FilesError(
        "Invalid",
        `${label}: metadata key ${JSON.stringify(name)} can't be sent as an HTTP header name. S3 carries user metadata in x-amz-meta-* headers, so keys must be HTTP tokens (letters, digits, and !#$%&'*+-.^_\`|~).`
      );
    }
    if (INVALID_HEADER_VALUE.test(value)) {
      throw new FilesError(
        "Invalid",
        `${label}: the value of metadata key ${JSON.stringify(name)} can't be sent as an HTTP header. S3 carries user metadata in x-amz-meta-* headers, ${HEADER_VALUE_RULE}.`
      );
    }
  }
};

/** The upload options that travel as S3 request headers. */
export interface HeaderBoundUploadOptions {
  cacheControl?: string;
  contentType?: string;
  metadata?: Record<string, string>;
}

const HEADER_BOUND_FIELDS = [
  ["contentType", "Content-Type"],
  ["cacheControl", "Cache-Control"],
] as const;

/**
 * {@link assertHeaderSafeMetadata}, plus the same value rule for the
 * `contentType` and `cacheControl` options, which S3 carries in the
 * `Content-Type` and `Cache-Control` request headers. A CR/LF or non-ASCII
 * value otherwise fails as a retried transport error or a signature mismatch
 * on one engine, and is stored mangled on the other (the fetch engine doesn't
 * sign `Content-Type`).
 */
export const assertHeaderSafeUploadOptions = (
  label: string,
  options: HeaderBoundUploadOptions | undefined
): void => {
  for (const [field, header] of HEADER_BOUND_FIELDS) {
    const value = options?.[field];
    if (value !== undefined && INVALID_HEADER_VALUE.test(value)) {
      throw new FilesError(
        "Invalid",
        `${label}: \`${field}\` can't be sent as an HTTP header. S3 carries it in the ${header} request header, ${HEADER_VALUE_RULE}.`
      );
    }
  }
  assertHeaderSafeMetadata(label, options?.metadata);
};

/**
 * SigV4 caps a presigned URL's `X-Amz-Expires` at one week. A longer value
 * signs fine but every SigV4 service rejects the URL when it's used.
 */
export const SIGV4_MAX_EXPIRES_IN = 604_800;

/**
 * The refusal for a presigned URL lifetime outside a whole number of seconds
 * from 1 to {@link SIGV4_MAX_EXPIRES_IN}, or `undefined` when it's valid. A
 * longer one is refused by every SigV4 service when the URL is used, and a
 * zero, negative, fractional, or NaN one mints a URL that is dead on arrival
 * (or one the presigner rejects with a bare string). Covers both a per-call
 * `expiresIn` and an adapter's `defaultUrlExpiresIn`, so direct adapter
 * callers get the same check `Files` applies.
 */
export const sigV4ExpiresInError = (
  label: string,
  expiresIn: number
): FilesError | undefined => {
  if (expiresIn > SIGV4_MAX_EXPIRES_IN) {
    return new FilesError(
      "Invalid",
      `${label}: presigned URLs must expire within ${SIGV4_MAX_EXPIRES_IN} seconds (7 days), the SigV4 limit; got expiresIn ${expiresIn}.`
    );
  }
  if (!(Number.isInteger(expiresIn) && expiresIn >= 1)) {
    return new FilesError(
      "Invalid",
      `${label}: a presigned URL's expiry must be a whole number of seconds, at least 1; got expiresIn ${expiresIn}.`
    );
  }
  return undefined;
};

/** {@link sigV4ExpiresInError}, thrown. */
export const assertSigV4ExpiresIn = (
  label: string,
  expiresIn: number
): void => {
  const error = sigV4ExpiresInError(label, expiresIn);
  if (error) {
    throw error;
  }
};

/**
 * Whether an S3 error is `416 Range Not Satisfiable` (`InvalidRange`): a
 * `range` that starts at or past the end of the object. The same request
 * fails the same way every time, so the caller maps it to a permanent
 * `Provider` error rather than one `retries` reissues.
 */
export const isUnsatisfiableRange = (
  code: string | undefined,
  status: number | undefined
): boolean => code === "InvalidRange" || status === 416;

/** CopyObject's ceiling: a single request copies a source of at most 5 GiB. */
export const S3_MAX_COPY_OBJECT_SIZE = 5 * 1024 * 1024 * 1024;

/**
 * Whether a failed `CopyObject` might be S3's refusal of a source over
 * {@link S3_MAX_COPY_OBJECT_SIZE} (AWS: `400 InvalidRequest`, "The specified
 * copy source is larger than the maximum allowable size for a copy source";
 * some S3-compatible services answer `EntityTooLarge`). The code alone is
 * ambiguous, so the caller confirms with a HEAD of the source before falling
 * back to a multipart copy.
 */
export const mayBeCopySizeRefusal = (
  code: string | undefined,
  status: number | undefined
): boolean =>
  (status === undefined || status === 400) &&
  (code === "InvalidRequest" || code === "EntityTooLarge");

// Server-side part copies move no bytes through this process, so they can be
// far larger than upload parts: fewer requests, none of them long-running.
// At S3's 5 TiB object maximum, 512 MiB is just over the 10,000-part limit,
// so `copyParts` grows it there.
const COPY_PART_SIZE = 512 * 1024 * 1024;
const S3_MAX_PARTS = 10_000;

/** One `UploadPartCopy` request: a part number and its inclusive byte range. */
export interface CopyPart {
  end: number;
  partNumber: number;
  start: number;
}

/**
 * Split a `size`-byte source into `UploadPartCopy` ranges: 512 MiB parts,
 * grown when needed to fit S3's 10,000-part limit.
 */
export const copyParts = (size: number): CopyPart[] => {
  const partSize = Math.max(COPY_PART_SIZE, Math.ceil(size / S3_MAX_PARTS));
  const parts: CopyPart[] = [];
  for (let start = 0; start < size; start += partSize) {
    parts.push({
      end: Math.min(start + partSize, size) - 1,
      partNumber: parts.length + 1,
      start,
    });
  }
  return parts;
};

/**
 * For an S3-compatible provider that doesn't implement POST Object (browser
 * POST uploads): reject the `signedUploadUrl()` options only a presigned POST
 * policy can enforce, before signing. The `s3()` engine would route `maxSize`
 * to `createPresignedPost`, handing back a form the provider refuses at upload
 * time, and a positive `minSize` needs the same `content-length-range`
 * condition. `minSize: 0` asks for nothing, so it passes.
 */
export const assertNoPostPolicy = (
  label: string,
  provider: string,
  signOpts: Pick<SignUploadOptions, "maxSize" | "minSize">
): void => {
  if (signOpts.maxSize !== undefined) {
    throw new FilesError(
      "Unsupported",
      `${label}: \`maxSize\` is not supported. ${provider} does not implement the S3 POST Object API (browser POST uploads), so it has no server-enforced upload size limit equivalent to S3's content-length-range policy. Enforce the limit at your application gateway before issuing the URL, or omit \`maxSize\` and accept the unbounded presigned PUT.`
    );
  }
  if (signOpts.minSize !== undefined && signOpts.minSize > 0) {
    throw new FilesError(
      "Unsupported",
      `${label}: \`minSize\` is not supported. ${provider} does not implement the S3 POST Object API (browser POST uploads), so a presigned PUT has no server-enforced minimum size. Reject small uploads at your application gateway, or omit \`minSize\`.`
    );
  }
};

/**
 * The engine's signed-upload declaration with `maxSize` forced off, for a
 * wrapper that runs {@link assertNoPostPolicy} before every signing call.
 */
export const withoutPostPolicy = (
  declared: AdapterCapabilityDeclaration["signedUpload"]
): NonNullable<AdapterCapabilityDeclaration["signedUpload"]> => ({
  ...declared,
  maxSize: false,
  supported: declared?.supported === true,
});
