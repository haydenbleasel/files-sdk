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
// What Node's HTTP client accepts in a header value: tab, printable ASCII,
// and the Latin-1 range above DEL. Fetch implementations reject a subset of
// the rest (anything past U+00FF, CR, LF, NUL), so this is the rule both
// engines can honor on every runtime.
const INVALID_HEADER_VALUE = /[^\t -~\u0080-ÿ]/u;

/**
 * Reject user metadata that can't travel as an `x-amz-meta-*` header before
 * any request is built. The HTTP client would refuse it anyway, but only
 * after the body was prepared, and as an unclassified error the retry policy
 * reissues. It's the caller's input that's wrong, so it's `Invalid`.
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
        `${label}: the value of metadata key ${JSON.stringify(name)} can't be sent as an HTTP header. S3 carries user metadata in x-amz-meta-* headers, which accept only Latin-1 text without control characters; encode the value first (e.g. with encodeURIComponent).`
      );
    }
  }
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
