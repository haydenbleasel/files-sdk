// oxlint-disable-next-line sonarjs/no-wildcard-import -- @vercel/blob's API is namespaced (blob.put/head/list/del/...); a flat named import would be noisier.
import * as blob from "@vercel/blob";

import type {
  Adapter,
  Body,
  FileInfo,
  ListResult,
  PartMeta,
  PartsResumableDriver,
  ResumableUploadSession,
  SignedUpload,
  UploadResult,
} from "../index.js";
import {
  assertRangeHonored,
  assertSlashDelimiter,
  DEFAULT_URL_EXPIRES_IN,
  existsByProbe,
  joinPublicUrl,
  rangeRequestHeaders,
  rangedResponseSize,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError, dispositionUnsupported } from "../internal/errors.js";
import type { ProviderFilesErrorCode } from "../internal/errors.js";
import { isFunction, isNumber, isObject, isString } from "../internal/is.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface VercelBlobAdapterOptions {
  /**
   * Read-write token (or client token). Passed here, it wins over every
   * other credential, OIDC included, matching `@vercel/blob`.
   *
   * Without this option the adapter falls back to
   * `process.env.BLOB_READ_WRITE_TOKEN`, but only as the last resort: with
   * a store id configured, an OIDC token found for the call is used first.
   * Environment credentials are resolved on every operation, so changes made
   * after construction are honored. On Vercel, prefer OIDC and leave this
   * unset.
   */
  token?: string;
  /**
   * Vercel OIDC token. Usually left unset: with a store id (`storeId` or
   * `BLOB_STORE_ID`) and no `token`, `@vercel/blob` looks the token up on
   * every call, the way it does when called directly. On Vercel Functions
   * the token arrives per request in the `x-vercel-oidc-token` header, not
   * in `process.env`; elsewhere it comes from `VERCEL_OIDC_TOKEN` (set
   * during Vercel builds, and written to `.env.local` by `vercel env pull`).
   * `@vercel/blob` 2.5 and later refresh an expired local token in a
   * project linked with `vercel link`.
   *
   * OIDC tokens are short-lived and auto-rotated, so they remove the risk
   * that a long-lived `BLOB_READ_WRITE_TOKEN` leaks from your codebase
   * or environment.
   *
   * Pass `oidcToken` explicitly only when you obtain the token yourself, for
   * example when your framework doesn't load `.env.local` into
   * `process.env` (Vite, etc.). A token passed here is used as given, never
   * refreshed, and needs a store id: without one the adapter throws rather
   * than falling back to the read-write token.
   */
  oidcToken?: string;
  /**
   * Blob store id, used with OIDC. Defaults to `process.env.BLOB_STORE_ID`.
   * Accepted in either `store_<id>` or `<id>` form (mirrors the SDK).
   *
   * Independently powers the `url()` fast path: when a `storeId` is known
   * (from option, env, or derived from a `vercel_blob_rw_<storeId>_…`
   * token), public URLs are synthesized without a round trip if
   * `addRandomSuffix: false`.
   */
  storeId?: string;
  /**
   * Whether blobs uploaded by this adapter are public or private.
   *
   * - `"public"` (default): blobs are uploaded with `access: "public"` and
   *   reachable via their CDN URL without authentication. `url()` returns a
   *   permanent public URL; `url(key, { expiresIn })` throws `Unsupported`.
   * - `"private"`: blobs are uploaded with `access: "private"`. They cannot
   *   be fetched by their plain URL — `download()` instead routes through
   *   `blob.get(key, { access: "private" })`, which uses whichever
   *   credentials the adapter resolved (read-write token or OIDC). `url()` mints a presigned GET URL
   *   (Vercel Signed URLs) that expires after `expiresIn` seconds.
   *
   * `signedUploadUrl()` mints a presigned PUT URL in either mode.
   *
   * The setting is fixed at construction so a single `Files` instance is
   * unambiguously one or the other. If you need both, instantiate two
   * adapters.
   */
  access?: "public" | "private";
  /**
   * Default expiry, in seconds, for the presigned URLs `url()` mints in
   * `access: "private"` mode. Defaults to 3600 (1 hour). Per-call
   * `url(key, { expiresIn })` overrides. Vercel caps signed-URL lifetime at
   * 7 days server-side. Ignored in `"public"` mode, where `url()` returns
   * the permanent CDN URL.
   */
  defaultUrlExpiresIn?: number;
  /**
   * Add a random suffix to uploaded keys (Vercel default).
   *
   * When `false`, the resulting pathname matches the key 1:1, which keeps
   * the API consistent with S3/R2 where callers expect to control the key.
   * Defaults to `false`.
   */
  addRandomSuffix?: boolean;
  /**
   * Allow overwriting existing keys on upload. Defaults to `true` so that the
   * "predictable keys" behavior (`addRandomSuffix: false`) actually works —
   * Vercel rejects same-pathname uploads otherwise.
   *
   * **Trade-off:** with the defaults, an `upload(key, ...)` call silently
   * clobbers any existing object at `key`. If keys are derived from
   * untrusted input or your callers expect "create-only" semantics, set
   * `allowOverwrite: false` and handle the resulting Conflict (Vercel
   * reports the existing blob as a bad request, which the adapter maps to
   * `Conflict`). Applies to `upload()` (including resumable/multipart
   * uploads), `copy()`, and `signedUploadUrl()`.
   */
  allowOverwrite?: boolean;
  /**
   * Timeout in milliseconds for the public-URL fetches and private
   * `blob.get` reads issued by `download()`. A hung CDN response would
   * otherwise leak a fetch that never resolves.
   *
   * Defaults to 300_000 (5 minutes). Pass `0` to disable the timeout (not
   * recommended in server contexts — a stuck request will pin a connection
   * until the runtime tears it down).
   */
  downloadTimeoutMs?: number;
}

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const PROVIDER = "vercel-blob" as const;

const withTimeoutSignal = (
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal | undefined => {
  if (timeoutMs <= 0) {
    return signal;
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
};

const fetchWithTimeout = (
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  headers?: Record<string, string>
): Promise<Response> => {
  const mergedSignal = withTimeoutSignal(signal, timeoutMs);
  const init: RequestInit = {
    ...(headers && { headers }),
    ...(mergedSignal && { signal: mergedSignal }),
  };
  return fetch(url, init);
};

export type VercelBlobClient = typeof blob;

export type VercelBlobAdapter = Adapter<VercelBlobClient>;

const sizeOf = (body: Body): number | undefined => {
  if (isString(body)) {
    return new TextEncoder().encode(body).byteLength;
  }
  if (body instanceof Uint8Array) {
    return body.byteLength;
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  if (body instanceof Blob) {
    return body.size;
  }
  return undefined;
};

const parseCacheControlMaxAge = (header: string): number | undefined => {
  const match = /max-age=(?<maxAge>\d+)/u.exec(header);
  return match?.[1] ? Number(match[1]) : undefined;
};

// Vercel Blob stores a single `cacheControlMaxAge` (seconds) and writes the
// rest of the header itself. A value with no `max-age` directive (e.g.
// "no-store") has nothing to map to, so throw rather than drop it.
const cacheControlMaxAge = (header: string): number => {
  const maxAge = parseCacheControlMaxAge(header);
  if (maxAge === undefined) {
    throw new FilesError(
      "Unsupported",
      `vercel-blob: \`cacheControl\` "${header}" cannot be represented. Vercel Blob only stores a max-age (\`cacheControlMaxAge\`), so pass a value with a \`max-age=<seconds>\` directive, e.g. "public, max-age=3600".`
    );
  }
  return maxAge;
};

interface BlobErrorClassification {
  code: ProviderFilesErrorCode;
  aborted?: boolean;
  permanent?: boolean;
}

type BlobErrorClass = abstract new (...args: never[]) => Error;

// Each class is read off the namespace at call time and checked before use,
// so a peer build (or test double) that lacks one simply doesn't match.
const isInstance = (
  cause: unknown,
  ctor: BlobErrorClass | undefined
): boolean => isFunction(ctor) && cause instanceof ctor;

// With `allowOverwrite: false`, an existing pathname comes back as a
// `bad_request`, which the SDK surfaces as a bare `BlobError` carrying the
// server's "This blob already exists, use `allowOverwrite: true` …" message.
const BLOB_EXISTS_RE = /blob already exists/iu;

// `@vercel/blob` errors are `BlobError` subclasses with no `status`, and their
// `name` stays "Error" (only the constructor differs), so classify them by
// class. Returns `undefined` for anything that isn't a known SDK error.
const classifyBlobErrorClass = (
  cause: unknown
): BlobErrorClassification | undefined => {
  if (isInstance(cause, blob.BlobNotFoundError)) {
    return { code: "NotFound" };
  }
  if (
    isInstance(cause, blob.BlobAccessError) ||
    isInstance(cause, blob.BlobClientTokenExpiredError) ||
    isInstance(cause, blob.BlobPathnameMismatchError) ||
    isInstance(cause, blob.BlobStoreSuspendedError)
  ) {
    return { code: "Unauthorized" };
  }
  if (isInstance(cause, blob.BlobPreconditionFailedError)) {
    return { code: "Conflict" };
  }
  if (isInstance(cause, blob.BlobRequestAbortedError)) {
    return { aborted: true, code: "Provider" };
  }
  // Deterministic rejections: re-sending the same request fails the same way,
  // so flag them permanent to keep `retries` from re-issuing them. A missing
  // store is a configuration error, not a missing key.
  if (
    isInstance(cause, blob.BlobContentTypeNotAllowedError) ||
    isInstance(cause, blob.BlobFileTooLargeError) ||
    isInstance(cause, blob.BlobStoreNotFoundError)
  ) {
    return { code: "Provider", permanent: true };
  }
  if (
    isInstance(cause, blob.BlobError) &&
    cause instanceof Error &&
    BLOB_EXISTS_RE.test(cause.message)
  ) {
    return { code: "Conflict" };
  }
  return undefined;
};

// Fallback for errors that aren't `@vercel/blob` classes (e.g. a transport
// error that carries a status, or a differently-bundled copy of the SDK):
// HTTP status first, then error-name substrings.
const classifyBlobError = (
  status: number | undefined,
  name: string
): ProviderFilesErrorCode => {
  if (status === 404 || name.includes("NotFound")) {
    return "NotFound";
  }
  if (
    status === 401 ||
    status === 403 ||
    name.includes("Forbidden") ||
    name.includes("Unauthorized")
  ) {
    return "Unauthorized";
  }
  if (status === 409 || status === 412 || name.includes("Precondition")) {
    return "Conflict";
  }
  return "Provider";
};

const DEFAULT_BLOB_MESSAGES: Record<ProviderFilesErrorCode, string> = {
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: "vercel-blob error",
  Unauthorized: "Unauthorized",
};

const MISSING_CREDENTIALS_MESSAGE =
  "vercelBlob adapter: missing credentials. Pass `token`, or `oidcToken` + `storeId`, or set BLOB_READ_WRITE_TOKEN, or set BLOB_STORE_ID for OIDC (the token comes from the request's x-vercel-oidc-token header on Vercel Functions, or from VERCEL_OIDC_TOKEN).";

// Nothing to authenticate with. Flagged permanent: re-sending the request
// can't produce a credential, so `retries` must not re-issue it.
const missingCredentials = (cause?: unknown): FilesError =>
  new FilesError("Invalid", MISSING_CREDENTIALS_MESSAGE, cause);

// `@vercel/blob` throws a bare `BlobError` with this message when its own
// lookup finds no credential at call time (unchanged from 2.4 through 2.8).
const NO_BLOB_CREDENTIALS_RE = /No blob credentials found/u;

const mapBlobError = (cause: unknown): FilesError => {
  if (cause instanceof FilesError) {
    return cause;
  }
  // The OIDC token can only be looked for per call (see `resolveAuth`), so
  // this is where "no credentials" surfaces for an adapter that has a store
  // id but no token. Report it as the adapter's own missing-credentials
  // error, the one thrown when nothing is configured at all.
  if (
    isInstance(cause, blob.BlobError) &&
    cause instanceof Error &&
    NO_BLOB_CREDENTIALS_RE.test(cause.message)
  ) {
    return missingCredentials(cause);
  }
  const message =
    isObject(cause) && "message" in cause && isString(cause.message)
      ? cause.message
      : undefined;
  const classified = classifyBlobErrorClass(cause);
  if (classified) {
    const { code, ...flags } = classified;
    return new FilesError(
      code,
      message ?? DEFAULT_BLOB_MESSAGES[code],
      cause,
      flags
    );
  }
  // Transport errors may carry a status or only a name/message. Read each
  // field only once its type is established.
  const status =
    isObject(cause) && "status" in cause && isNumber(cause.status)
      ? cause.status
      : undefined;
  const name =
    isObject(cause) && "name" in cause && isString(cause.name)
      ? cause.name
      : "";
  const code = classifyBlobError(status, name);
  return new FilesError(code, message ?? DEFAULT_BLOB_MESSAGES[code], cause);
};

// `BLOB_READ_WRITE_TOKEN` format is `vercel_blob_rw_<storeId>_<random>`.
// We use the storeId to synthesize public URLs without a round trip when
// the pathname is predictable (i.e. `addRandomSuffix: false`).
//
// Parse defensively: require the exact `vercel_blob_rw_` prefix and a
// segment shaped like a real storeId (alphanumeric, ≥8 chars — real ones
// are ~24). If Vercel ever inserts a version segment (e.g.
// `vercel_blob_rw_v2_<storeId>_<random>`), changes separators, or
// shortens the storeId, the candidate fails the shape check and we fall
// through to `undefined` — `url()` then does a real head() call instead
// of building a URL pointing at the wrong (or someone else's) store.
const TOKEN_PREFIX = "vercel_blob_rw_";
const STORE_ID_PREFIX = "store_";
const STORE_ID_RE = /^[A-Za-z0-9]{8,}$/u;

const deriveStoreIdFromToken = (rwToken: string): string | undefined => {
  if (!rwToken.startsWith(TOKEN_PREFIX)) {
    return undefined;
  }
  const afterPrefix = rwToken.slice(TOKEN_PREFIX.length);
  const sep = afterPrefix.indexOf("_");
  const candidate = sep === -1 ? afterPrefix : afterPrefix.slice(0, sep);
  return candidate && STORE_ID_RE.test(candidate) ? candidate : undefined;
};

// `BLOB_STORE_ID` is documented as accepting either `store_<id>` or
// `<id>` form. The CDN URL uses the bare id, so strip the prefix if
// present before validating shape.
const normalizeExplicitStoreId = (id: string): string | undefined => {
  const candidate = id.startsWith(STORE_ID_PREFIX)
    ? id.slice(STORE_ID_PREFIX.length)
    : id;
  return STORE_ID_RE.test(candidate) ? candidate : undefined;
};

// Credentials passed to every `@vercel/blob` call. Mirrors `BlobCommandOptions`
// (the upstream interface shared across put/get/head/del/copy/list).
interface BlobAuthOptions {
  token?: string;
  oidcToken?: string;
  storeId?: string;
}

export const vercelBlob = (
  config: VercelBlobAdapterOptions = {}
): VercelBlobAdapter => {
  const explicitToken = config.token;
  const explicitOidcToken = config.oidcToken;
  const explicitStoreId = config.storeId;
  // The credentials handed to `@vercel/blob` for one operation. Mirrors its
  // own resolution order (`resolveBlobAuth`):
  //   1. explicit `token` (RW or client token): wins over OIDC
  //   2. OIDC: the `oidcToken` option, or the token `@vercel/blob` finds
  //      itself (request header, then `VERCEL_OIDC_TOKEN`), paired with the
  //      `storeId` option or `BLOB_STORE_ID`
  //   3. `BLOB_READ_WRITE_TOKEN` env
  const resolveAuth = (): BlobAuthOptions => {
    if (explicitToken) {
      return { token: explicitToken };
    }
    const resolvedStoreId = explicitStoreId ?? readEnv("BLOB_STORE_ID");
    if (explicitOidcToken) {
      if (resolvedStoreId) {
        return { oidcToken: explicitOidcToken, storeId: resolvedStoreId };
      }
      // An explicit `oidcToken` option (vs one picked up from the env) is an
      // unambiguous request for OIDC. With no resolvable `storeId`, don't fall
      // through to `BLOB_READ_WRITE_TOKEN` — that would silently swap the auth
      // scheme out from under the caller. Upstream `resolveBlobAuth` throws here
      // too, ahead of its own read-write-token fallback.
      throw new FilesError(
        "Invalid",
        "vercelBlob adapter: `oidcToken` was passed but no `storeId` was found. Pass `storeId` or set BLOB_STORE_ID to use OIDC."
      );
    }
    // Implicit OIDC: hand over just the store id and let `@vercel/blob` pick
    // the credential on each call. Whether an OIDC token exists is only
    // knowable then: on Vercel Functions it arrives per request in the
    // `x-vercel-oidc-token` header, not `process.env`; elsewhere it is
    // `VERCEL_OIDC_TOKEN`, which `@vercel/blob` 2.5+ refreshes once expired
    // in a `vercel link`ed project. The SDK reads those in that order and,
    // finding none, falls back to `BLOB_READ_WRITE_TOKEN` itself. So a
    // read-write token in the env must not be passed here: as an explicit
    // `token` it would outrank the request's OIDC token.
    if (resolvedStoreId) {
      return { storeId: resolvedStoreId };
    }
    // No store id, so no OIDC (the SDK skips an OIDC token it can't pair with
    // a store): the read-write token is the only credential left.
    const envToken = readEnv("BLOB_READ_WRITE_TOKEN");
    if (envToken) {
      return { token: envToken };
    }
    throw missingCredentials();
  };

  // Fail fast on what construction can already decide: an explicit
  // `oidcToken` with no store id, or neither a store id nor a read-write
  // token (OIDC needs a store id, so no request header could rescue that).
  // A store id with no token in sight is deliberately not checked here: on
  // Vercel Functions the OIDC token exists only inside a request, so
  // checking would make a module-scope `vercelBlob()` throw at import. For
  // that path the check moves to first use, where `@vercel/blob`'s "No blob
  // credentials found" becomes the same missing-credentials error (see
  // `mapBlobError`). Every operation re-resolves, so env changes made after
  // construction are honored.
  resolveAuth();

  const access = config.access ?? "public";
  const addRandomSuffix = config.addRandomSuffix ?? false;
  const allowOverwrite = config.allowOverwrite ?? true;
  const downloadTimeoutMs =
    config.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const defaultUrlExpiresIn =
    config.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

  // Vercel Signed URLs are a two-step affair: `issueSignedToken()` asks the
  // control API for delegation material (one network round trip), then
  // `presignUrl()` HMAC-signs a concrete URL locally. Issue one token per
  // call, scoped to exactly this pathname and operation and expiring with
  // the URL, so a leaked signing key can only ever do what the URL could,
  // and the caller's `expiresIn` is never silently capped by a longer-lived
  // cached token.
  const issueScopedToken = async (
    pathname: string,
    operation: "get" | "put",
    expiresIn: number,
    signal: AbortSignal | undefined,
    constraints: {
      allowedContentTypes?: string[];
      maximumSizeInBytes?: number;
    } = {}
  ) => {
    const validUntil = Date.now() + expiresIn * 1000;
    const token = await blob.issueSignedToken({
      operations: [operation],
      pathname,
      validUntil,
      ...constraints,
      ...(signal && { abortSignal: signal }),
      ...resolveAuth(),
    });
    return { token, validUntil };
  };

  // For private blobs the public URL field returned by head()/list() requires
  // authentication to fetch — a plain `fetch(url)` would 401. Route body reads
  // through `blob.get(...)` instead, which uses whichever credentials the
  // adapter resolved. Returns a stream and a content type; callers can buffer
  // or pipe it.
  const getPrivateBody = async (
    key: string,
    signal?: AbortSignal
  ): Promise<{
    contentType: string | undefined;
    size: number | undefined;
    stream: ReadableStream<Uint8Array>;
  }> => {
    const abortSignal = withTimeoutSignal(signal, downloadTimeoutMs);
    const got = await blob.get(key, {
      access: "private",
      ...resolveAuth(),
      ...(abortSignal && { abortSignal }),
    });
    if (!got || got.statusCode !== 200) {
      throw new FilesError(
        "NotFound",
        `vercel-blob: private blob not found: ${key}`
      );
    }
    return {
      contentType: got.blob.contentType,
      size: got.blob.size,
      stream: got.stream,
    };
  };

  // A public URL is built from the store id and the key alone, so it needs no
  // OIDC token, which may only exist inside a request. Prefer the store id
  // from the option or `BLOB_STORE_ID` (whatever the active auth scheme),
  // then fall back to deriving it from a read-write token (the only
  // credential shape that embeds one) so token-only setups keep the
  // no-round-trip fast path. `resolveAuth()` still runs, so an adapter with
  // nothing to authenticate with fails loudly here too.
  const resolveStoreId = (): string | undefined => {
    const auth = resolveAuth();
    const resolvedStoreId = explicitStoreId ?? readEnv("BLOB_STORE_ID");
    if (resolvedStoreId) {
      const normalizedStoreId = normalizeExplicitStoreId(resolvedStoreId);
      if (normalizedStoreId) {
        return normalizedStoreId;
      }
    }
    return auth.token ? deriveStoreIdFromToken(auth.token) : undefined;
  };

  const headRaw = async (key: string, signal?: AbortSignal) => {
    try {
      return await blob.head(key, {
        ...(signal && { abortSignal: signal }),
        ...resolveAuth(),
      });
    } catch (error) {
      throw mapBlobError(error);
    }
  };

  return {
    capabilities: {
      // Vercel Blob maps `cacheControl` to its `cacheControlMaxAge` (a value
      // with no `max-age` directive throws); there is no arbitrary
      // user-metadata primitive, so `metadata` stays unset and a non-empty
      // `metadata` hits the gate's loud throw.
      cacheControl: true,
      // `list()` folds on "/" only (`mode: "folded"`); other delimiters throw.
      delimiter: "slash",
      // Public blobs' `url()` is their permanent CDN URL.
      publicUrl: access === "public",
      // Range rides on the standard-HTTP fetch of the public blob URL. Private
      // blobs read through `blob.get`, which has no range primitive, so they
      // fall through to the gate's loud throw.
      rangeRead: access !== "private",
      // `copy()` is a server-side `blob.copy` — no body round-trip.
      serverSideCopy: true,
      // `signedUploadUrl()` mints a presigned PUT in both access modes; the CDN
      // enforces `allowedContentTypes` and `maximumSizeInBytes`, so
      // `contentType` and `maxSize` are real constraints. Vercel's 7-day
      // ceiling is enforced by the control API, not here, so no `maxExpiresIn`.
      signedUpload: { contentType: true, maxSize: true, supported: true },
      // Public blobs return their permanent CDN URL from `url()`, which is no
      // more than a public link, so an explicit `expiresIn` is refused by the
      // core gate. Private blobs mint a presigned GET that honors it. Neither
      // URL carries a Content-Disposition override (`url()` throws on one).
      // Vercel's 7-day ceiling is enforced by the control API, not here, so
      // no `maxExpiresIn`.
      signedUrl: {
        disposition: false,
        expiry: "exact",
        supported: access === "private",
      },
      uploadProgress: true,
    },
    async copy(from, to, operationOpts) {
      try {
        await blob.copy(from, to, {
          access,
          addRandomSuffix,
          allowOverwrite,
          ...(operationOpts?.signal && {
            abortSignal: operationOpts.signal,
          }),
          ...resolveAuth(),
        });
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    async delete(key, operationOpts) {
      try {
        await blob.del(key, {
          ...(operationOpts?.signal && {
            abortSignal: operationOpts.signal,
          }),
          ...resolveAuth(),
        });
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    async download(key, downloadOpts) {
      const result = await headRaw(key, downloadOpts?.signal);
      try {
        const meta = {
          contentType: result.contentType ?? DEFAULT_CONTENT_TYPE,
          etag: result.etag,
          key: result.pathname,
          lastModified: result.uploadedAt?.getTime(),
        };
        if (access === "private") {
          const got = await getPrivateBody(key, downloadOpts?.signal);
          if (downloadOpts?.as === "stream") {
            return createStoredFile(
              { ...meta, size: result.size },
              { factory: () => got.stream, kind: "stream" }
            );
          }
          const bytes = new Uint8Array(
            await new Response(got.stream).arrayBuffer()
          );
          return createStoredFile(
            { ...meta, size: bytes.byteLength },
            { data: bytes, kind: "buffer" }
          );
        }
        const range = downloadOpts?.range;
        const res = await fetchWithTimeout(
          result.url,
          downloadTimeoutMs,
          downloadOpts?.signal,
          rangeRequestHeaders(range)
        );
        if (!res.ok) {
          throw new FilesError(
            res.status === 404 ? "NotFound" : "Provider",
            `vercel-blob download failed: ${res.status} ${res.statusText}`
          );
        }
        if (range) {
          assertRangeHonored(res.status, PROVIDER);
        }
        if (downloadOpts?.as === "stream" && res.body) {
          const stream = res.body;
          return createStoredFile(
            {
              ...meta,
              size: range
                ? rangedResponseSize(
                    res.headers.get("content-length"),
                    result.size,
                    range
                  )
                : result.size,
            },
            { factory: () => stream, kind: "stream" }
          );
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        return createStoredFile(
          { ...meta, size: bytes.byteLength },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    exists(key, operationOpts) {
      return existsByProbe(
        () => headRaw(key, operationOpts?.signal),
        mapBlobError
      );
    },
    async head(key, operationOpts) {
      const result = await headRaw(key, operationOpts?.signal);
      return {
        contentType: result.contentType ?? DEFAULT_CONTENT_TYPE,
        etag: result.etag,
        key: result.pathname,
        lastModified: result.uploadedAt?.getTime(),
        size: result.size,
      };
    },
    async list(options): Promise<ListResult> {
      try {
        if (options?.delimiter) {
          assertSlashDelimiter(PROVIDER, options.delimiter);
        }
        const result = await blob.list({
          ...(options?.signal && { abortSignal: options.signal }),
          ...resolveAuth(),
          ...(options?.prefix && { prefix: options.prefix }),
          ...(options?.limit !== undefined && { limit: options.limit }),
          ...(options?.cursor && { cursor: options.cursor }),
          ...(options?.delimiter && { mode: "folded" as const }),
        });
        const items: FileInfo[] = result.blobs.map((b) => ({
          contentType: DEFAULT_CONTENT_TYPE,
          etag: b.etag,
          key: b.pathname,
          lastModified: b.uploadedAt?.getTime(),
          size: b.size,
        }));
        // `mode: "folded"` is only sent alongside a delimiter; an expanded
        // listing carries no `folders`, so read it as optional despite the
        // folded result type the conditional spread selects.
        const prefixes: string[] | undefined = result.folders;
        return {
          cursor: result.hasMore ? result.cursor : undefined,
          items,
          ...(prefixes?.length && { prefixes }),
        };
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    name: PROVIDER,
    raw: blob,
    resumableUpload(key, resumableOpts): PartsResumableDriver {
      // Vercel Blob has no list-parts or abort primitive, so the session token
      // carries the parts completed so far; the driver appends to it as each
      // part lands, keeping `toJSON()` resumable across a pause.
      let session:
        | Extract<ResumableUploadSession, { provider: "vercel-blob" }>
        | undefined;
      const requireSession = () => {
        if (!session) {
          throw new FilesError(
            "Invalid",
            "vercel-blob: resumable upload not started."
          );
        }
        return session;
      };
      const minPart = 5 * 1024 * 1024;
      const requestedPart = isObject(resumableOpts.multipart)
        ? resumableOpts.multipart.partSize
        : undefined;
      // Pinned in the token by `begin()` and re-read by `adopt()`, so a resume
      // slices on the same boundaries as the parts the token already holds.
      let partSize =
        requestedPart && requestedPart > minPart ? requestedPart : minPart;
      // Same write options as a plain `upload()`: the overwrite policy and the
      // cache max-age ride on both the create and the complete request.
      const writeOptions = {
        allowOverwrite,
        ...(resumableOpts.cacheControl && {
          cacheControlMaxAge: cacheControlMaxAge(resumableOpts.cacheControl),
        }),
      };
      return {
        adopt(adopted: ResumableUploadSession) {
          if (adopted.provider !== PROVIDER) {
            throw new FilesError(
              "Invalid",
              `Cannot resume a ${adopted.provider} session on a vercel-blob adapter.`
            );
          }
          if (adopted.key !== key) {
            throw new FilesError(
              "Invalid",
              "Resume token does not match this upload's key."
            );
          }
          session = adopted;
          ({ partSize } = adopted);
        },
        async begin(meta): Promise<ResumableUploadSession> {
          try {
            const created = await blob.createMultipartUpload(key, {
              access,
              addRandomSuffix,
              ...writeOptions,
              ...resolveAuth(),
              contentType: meta.contentType,
            });
            session = {
              contentType: meta.contentType,
              key,
              partSize,
              parts: [],
              provider: PROVIDER,
              storageKey: created.key,
              uploadId: created.uploadId,
            };
            return session;
          } catch (error) {
            throw mapBlobError(error);
          }
        },
        async complete(parts: PartMeta[]): Promise<UploadResult> {
          const active = requireSession();
          try {
            const result = await blob.completeMultipartUpload(
              key,
              parts.map((part) => ({
                etag: part.etag ?? "",
                partNumber: part.partNumber,
              })),
              {
                access,
                key: active.storageKey,
                uploadId: active.uploadId,
                ...writeOptions,
                ...resolveAuth(),
              }
            );
            return {
              contentType:
                result.contentType ??
                active.contentType ??
                DEFAULT_CONTENT_TYPE,
              etag: result.etag,
              key: result.pathname,
              lastModified: Date.now(),
              size: parts.reduce((sum, part) => sum + part.size, 0),
            };
          } catch (error) {
            throw mapBlobError(error);
          }
        },
        discard() {
          // Vercel Blob has no abort-multipart primitive; an abandoned session
          // expires on its own. Nothing to clean up.
          return Promise.resolve();
        },
        mode: "parts",
        get partSize() {
          return partSize;
        },
        probe(): Promise<{ committedParts: PartMeta[] }> {
          return Promise.resolve({ committedParts: requireSession().parts });
        },
        async uploadPart({ partNumber, data, signal }): Promise<PartMeta> {
          const active = requireSession();
          try {
            // SAFETY: the SDK hands a non-stream body to `fetch` untouched
            // (sizing it via `byteLength`), so a typed array is a valid body
            // at runtime; its `PutBody` type just omits plain views. `Buffer`
            // is the declared member a `Uint8Array` is comparable to.
            const part = await blob.uploadPart(key, data as Buffer, {
              access,
              key: active.storageKey,
              partNumber,
              uploadId: active.uploadId,
              ...resolveAuth(),
              ...(signal && { abortSignal: signal }),
            });
            const meta: PartMeta = {
              etag: part.etag,
              partNumber,
              size: data.byteLength,
            };
            active.parts.push(meta);
            return meta;
          } catch (error) {
            throw mapBlobError(error);
          }
        },
      };
    },
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      // A presigned PUT enforces `allowedContentTypes` and
      // `maximumSizeInBytes` at the CDN, so `contentType` and `maxSize` are
      // real constraints here. There is no minimum-size counterpart: a
      // positive `minSize` cannot be honored, so fail closed rather than
      // hand out a URL that accepts the empty upload the caller asked to
      // reject. `0` (and the default) ask for nothing we can't deliver.
      if (signOpts.minSize !== undefined && signOpts.minSize > 0) {
        throw new FilesError(
          "Unsupported",
          "vercel-blob: `minSize` is not supported. Vercel presigned uploads enforce a maximum size (`maxSize`) but have no minimum-size constraint; pass `minSize: 0` or omit it, and reject empty uploads at your application gateway."
        );
      }
      const constraints = {
        ...(signOpts.contentType && {
          allowedContentTypes: [signOpts.contentType],
        }),
        ...(signOpts.maxSize !== undefined && {
          maximumSizeInBytes: signOpts.maxSize,
        }),
      };
      try {
        const { token, validUntil } = await issueScopedToken(
          key,
          "put",
          signOpts.expiresIn,
          signOpts.signal,
          constraints
        );
        const { presignedUrl } = await blob.presignUrl(token, {
          access,
          addRandomSuffix,
          allowOverwrite,
          operation: "put",
          pathname: key,
          validUntil,
          ...constraints,
        });
        return {
          method: "PUT",
          url: presignedUrl,
          ...(signOpts.contentType && {
            headers: { "Content-Type": signOpts.contentType },
          }),
        };
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    async upload(key, body, options) {
      try {
        // SAFETY: `Body`'s typed-array members are missing from the SDK's
        // `PutBody`, but the SDK forwards any non-stream body to `fetch`
        // untouched (sizing it via `byteLength`), so every `Body` shape is a
        // valid body at runtime. The cast only bridges the declared unions.
        const result = await blob.put(key, body as Blob | string, {
          access,
          addRandomSuffix,
          allowOverwrite,
          ...(options?.signal && { abortSignal: options.signal }),
          ...resolveAuth(),
          ...(options?.contentType && { contentType: options.contentType }),
          ...(options?.cacheControl && {
            cacheControlMaxAge: cacheControlMaxAge(options.cacheControl),
          }),
          // Vercel's event already carries both loaded and total.
          ...(options?.onProgress && {
            onUploadProgress: (e: { loaded: number; total: number }) =>
              options.onProgress?.({ loaded: e.loaded, total: e.total }),
          }),
        });
        // Vercel's PutBlobResult has no size; for stream bodies we can't compute
        // it locally, so fall back to a follow-up head() to get the authoritative
        // size (and lastModified). For known-size bodies, skip the extra round trip.
        const localSize = sizeOf(body);
        let size = localSize;
        let lastModified = Date.now();
        if (size === undefined) {
          const { size: headSize, uploadedAt } = await blob.head(result.url, {
            ...(options?.signal && { abortSignal: options.signal }),
            ...resolveAuth(),
          });
          size = headSize;
          lastModified = uploadedAt?.getTime() ?? lastModified;
        }
        return {
          contentType:
            result.contentType ?? options?.contentType ?? DEFAULT_CONTENT_TYPE,
          etag: result.etag,
          key: result.pathname,
          lastModified,
          size,
        } satisfies UploadResult;
      } catch (error) {
        throw mapBlobError(error);
      }
    },
    async url(key, urlOpts) {
      // `responseContentDisposition` is a security knob (force download for
      // user-uploaded HTML/SVG to prevent stored XSS). Neither the public
      // CDN URL nor a Vercel presigned URL can carry a Content-Disposition
      // override, so silently dropping it would be a regression — throw.
      if (urlOpts?.responseContentDisposition) {
        throw dispositionUnsupported(
          "vercel-blob: `responseContentDisposition` is not supported. Vercel Blob URLs (public and presigned) carry no Content-Disposition override, so the header that prevents stored XSS on user-uploaded HTML/SVG cannot be applied. Use a different provider for buckets with untrusted content."
        );
      }
      // Private blobs have no permanent public URL — the `url` field
      // returned by head()/list() 401s without credentials. Mint a presigned
      // GET instead: scoped to this pathname, expiring after `expiresIn`.
      if (access === "private") {
        const expiresIn = urlOpts?.expiresIn ?? defaultUrlExpiresIn;
        try {
          const { token, validUntil } = await issueScopedToken(
            key,
            "get",
            expiresIn,
            urlOpts?.signal
          );
          const { presignedUrl } = await blob.presignUrl(token, {
            access: "private",
            operation: "get",
            pathname: key,
            validUntil,
          });
          return presignedUrl;
        } catch (error) {
          throw mapBlobError(error);
        }
      }
      // Public blobs: the permanent CDN URL. They can't mint an expiring
      // link, so `Files` refuses an explicit `expiresIn` before reaching here
      // (`signedUrl.supported` is `false`); called directly, it's ignored.
      //
      // Fast path: with a known storeId and predictable keys, derive the
      // URL without an API call. `addRandomSuffix: true` makes the actual
      // pathname unknowable in advance, so we have to head() in that case.
      if (!addRandomSuffix) {
        const storeId = resolveStoreId();
        if (storeId) {
          return joinPublicUrl(
            `https://${storeId}.public.blob.vercel-storage.com`,
            key
          );
        }
      }
      const result = await headRaw(key, urlOpts?.signal);
      if (!result.url) {
        throw new FilesError("Provider", "vercel-blob: missing public URL");
      }
      return result.url;
    },
  };
};
