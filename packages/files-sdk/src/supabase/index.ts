import { Buffer } from "node:buffer";

import { StorageClient } from "@supabase/storage-js";
import type { FileMetadata } from "@supabase/storage-js";

import type {
  Adapter,
  Body,
  FileInfo,
  ListResult,
  OffsetResumableDriver,
  ResumableDriverOptions,
  ResumableUploadSession,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  assertSlashDelimiter,
  DEFAULT_URL_EXPIRES_IN,
  deleteManyWithFallback,
  existsByProbe,
  joinPublicUrl,
  makeErrorMapper,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError, dispositionUnsupported } from "../internal/errors.js";
import { isFunction, isNumber, isObject, isString } from "../internal/is.js";
import { isJsonArray, isJsonObject } from "../internal/json.js";
import type { JsonObject, JsonValue } from "../internal/json.js";
import {
  assertSessionDiscarded,
  statusError,
} from "../internal/resumable-offset-http.js";
import { sameOriginSessionUrl } from "../internal/resumable-session-url.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface SupabaseAdapterOptions {
  /**
   * Supabase storage bucket. Must already exist (this SDK does not create
   * buckets). Surfaced as `bucket` on the returned adapter for cross-adapter
   * API consistency (S3/R2/GCS/MinIO/Azure all expose `bucket`).
   */
  bucket: string;
  /**
   * Existing client instance. Highest precedence. Pass either:
   *  - a `StorageClient` (from `@supabase/storage-js`), or
   *  - a `SupabaseClient` (from `@supabase/supabase-js`) — the adapter will
   *    pick `client.storage` automatically.
   *
   * Useful when the consumer already constructs a Supabase client for auth
   * or postgrest and wants to share it with the storage adapter.
   */
  client?: StorageClient | { storage: StorageClient };
  /**
   * Supabase project URL (e.g. `https://xxxx.supabase.co`). Required if
   * `client` is not provided. The adapter appends `/storage/v1` automatically
   * when constructing a `StorageClient`. Falls back to `SUPABASE_URL`, then
   * `NEXT_PUBLIC_SUPABASE_URL`.
   */
  url?: string;
  /**
   * Supabase API key. The service role key is required for write operations
   * on RLS-protected buckets; the anon key works for public buckets. Falls
   * back to `SUPABASE_SERVICE_ROLE_KEY`, then `SUPABASE_KEY`, then
   * `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   */
  key?: string;
  /**
   * Set to `true` if the bucket is configured as a public bucket. `url()`
   * will then return `getPublicUrl()` results — a permanent, unsigned URL —
   * instead of minting a signed read URL. Passing `expiresIn` or
   * `responseContentDisposition` still signs.
   *
   * Supabase exposes no API to detect bucket visibility from the client; if
   * `public: true` is set on a private bucket, the returned URL will 4xx
   * when fetched.
   */
  public?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips both signing and `getPublicUrl()` —
   * appropriate when a CDN sits in front of the Supabase project. Implies
   * `public: true`. Passing `expiresIn` or `responseContentDisposition`
   * still signs.
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the signed read URLs returned by
   * `url()` when neither `public` nor `publicBaseUrl` is set. Defaults to
   * 3600 (1 hour). Per-call `url(key, { expiresIn })` overrides.
   */
  defaultUrlExpiresIn?: number;
}

export type SupabaseAdapter = Adapter<StorageClient> & {
  readonly bucket: string;
};

const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const TUS_CHUNK_SIZE = 6 * 1024 * 1024;
// storage-js's default `cacheControl` (seconds) when an upload names none.
const DEFAULT_CACHE_SECONDS = "3600";
// Supabase Storage refuses a bulk delete of more than 1000 objects.
const DELETE_BATCH_SIZE = 1000;

const SUPABASE_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  "NotFound",
  "NoSuchKey",
  "not_found",
]);
// `InvalidKey` is deliberately absent: Supabase uses it for a malformed
// *object* key (HTTP 400), not a bad API key.
const SUPABASE_UNAUTH_CODES: ReadonlySet<string> = new Set([
  "InvalidJWT",
  "Unauthorized",
  "AccessDenied",
]);
const SUPABASE_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "Duplicate",
  "AlreadyExists",
  "ResourceAlreadyExists",
  "KeyAlreadyExists",
]);

// A numeric-looking status carried in the response body (`"404"`).
const NUMERIC_STATUS = /^\d{3}$/u;

interface SupabaseStatusCode {
  /** The real status, from a numeric body `statusCode` ("404"). */
  bodyStatus?: number;
  /** A non-numeric `statusCode` ("NoSuchKey", older servers' "NotFound"). */
  codeName?: string;
}

// Split `StorageApiError.statusCode`: a numeric string ("404") is the real
// status from the response body; anything else is a code name.
const splitStatusCode = (
  statusCode: string | number | undefined
): SupabaseStatusCode => {
  if (isNumber(statusCode)) {
    return { bodyStatus: statusCode };
  }
  if (statusCode === undefined) {
    return {};
  }
  return NUMERIC_STATUS.test(statusCode)
    ? { bodyStatus: Number(statusCode) }
    : { codeName: statusCode };
};

const _supabaseErrorMapper = makeErrorMapper({
  codes: {
    conflict: SUPABASE_CONFLICT_CODES,
    notFound: SUPABASE_NOT_FOUND_CODES,
    unauthorized: SUPABASE_UNAUTH_CODES,
  },
  extract: (err) => {
    if (!isObject(err)) {
      return {};
    }
    // Supabase Storage answers most errors with HTTP 400 and puts the real
    // status in the JSON body: `{ statusCode: "404", code: "NoSuchKey" }`.
    // storage-js's `StorageApiError` keeps the HTTP status on `status`, the
    // body's `statusCode` (or, without one, the body's `code`, or the HTTP
    // status as a string) on `statusCode`, and the body's `code` on `code`.
    // So a numeric `statusCode` is the authoritative status and wins over
    // `status`; a non-numeric one is a code name (older servers).
    const { bodyStatus, codeName } = splitStatusCode(
      "statusCode" in err &&
        (isString(err.statusCode) || isNumber(err.statusCode))
        ? err.statusCode
        : undefined
    );
    const bodyCode = "code" in err && isString(err.code) ? err.code : undefined;
    // `error` is the legacy body's code field ("not_found", "Duplicate"),
    // seen when a raw response body is mapped directly.
    const legacyCode =
      "error" in err && isString(err.error) ? err.error : undefined;
    const code = bodyCode ?? legacyCode ?? codeName;
    const httpStatus =
      "status" in err && isNumber(err.status) ? err.status : undefined;
    const status = bodyStatus ?? httpStatus;
    const message =
      "message" in err && isString(err.message) ? err.message : undefined;
    return {
      ...(code && { code }),
      ...(message && { message }),
      ...(status !== undefined && { status }),
    };
  },
  providerLabel: "Supabase error",
});

// `mapSupabaseError(undefined)` was a documented shape (the SDK can return
// `error: null` and a few call sites pass it straight through). Preserve
// the optional-arg signature.
export const mapSupabaseError = (cause?: unknown): FilesError =>
  _supabaseErrorMapper(cause);

const stripEtag = (etag: string | undefined): string | undefined => {
  if (!etag) {
    return;
  }
  return etag.replaceAll(/^"+|"+$/gu, "");
};

// `@supabase/storage-js` accepts a trailing `FetchParameters` (which carries
// `signal`) on `download` and `list` — and only those. Forward the
// operation's AbortSignal there; return `undefined` when there's no signal so
// the call is unchanged. (Requests the adapter sends itself take the signal
// directly.)
const fetchParams = (
  signal: AbortSignal | undefined
): { signal: AbortSignal } | undefined => (signal ? { signal } : undefined);

const normalizeBody = async (
  body: Body,
  contentTypeHint?: string
): Promise<{
  data: Uint8Array | ReadableStream<Uint8Array> | Blob;
  contentType: string;
  contentLength?: number;
  isBlob: boolean;
}> => {
  if (isString(body)) {
    const data = new TextEncoder().encode(body);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? "text/plain; charset=utf-8",
      data,
      isBlob: false,
    };
  }
  if (body instanceof Uint8Array) {
    return {
      contentLength: body.byteLength,
      contentType: contentTypeHint ?? DEFAULT_CONTENT_TYPE,
      data: body,
      isBlob: false,
    };
  }
  if (body instanceof ArrayBuffer) {
    const data = new Uint8Array(body);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? DEFAULT_CONTENT_TYPE,
      data,
      isBlob: false,
    };
  }
  if (ArrayBuffer.isView(body)) {
    const data = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? DEFAULT_CONTENT_TYPE,
      data,
      isBlob: false,
    };
  }
  if (body instanceof Blob) {
    // Supabase sends Blob/File as multipart and uses the Blob's own
    // `type` for the part — `FileOptions.contentType` is ignored. To make
    // the caller's `contentType` honored consistently, drain the Blob to
    // a Uint8Array when an override is set; otherwise pass it through and
    // let the Blob's type win.
    if (contentTypeHint && contentTypeHint !== body.type) {
      const buf = new Uint8Array(await body.arrayBuffer());
      return {
        contentLength: buf.byteLength,
        contentType: contentTypeHint,
        data: buf,
        isBlob: false,
      };
    }
    return {
      contentLength: body.size,
      contentType: contentTypeHint ?? (body.type || DEFAULT_CONTENT_TYPE),
      data: body,
      isBlob: true,
    };
  }
  return {
    contentType: contentTypeHint ?? DEFAULT_CONTENT_TYPE,
    data: body,
    isBlob: false,
  };
};

/**
 * Map a full `Content-Disposition` header value (the SDK-wide
 * `responseContentDisposition` contract) onto Supabase's `download` option.
 * Supabase's `download: string` means "attachment **named** this", not a raw
 * header — passing the header value through verbatim served a file literally
 * named `attachment` (or a garbled name embedding the whole header). Bare
 * `attachment` maps to `download: true` (server-chosen filename), a
 * `filename=` parameter maps to that name, and anything else (e.g. `inline`)
 * throws — Supabase cannot express it, and silently dropping a disposition
 * override would be a stored-XSS hazard on user-uploaded content.
 */
const downloadOptionFor = (disposition: string): true | string => {
  const [typePart, ...params] = disposition.split(";");
  if ((typePart ?? "").trim().toLowerCase() !== "attachment") {
    throw dispositionUnsupported(
      `supabase: responseContentDisposition "${disposition}" is not supported — Supabase signed URLs can only force an attachment ("attachment" or 'attachment; filename="…"').`
    );
  }
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (param.slice(0, eq).trim().toLowerCase() === "filename") {
      const raw = param.slice(eq + 1).trim();
      return raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
        ? raw.slice(1, -1)
        : raw;
    }
  }
  return true;
};

const MAX_AGE_DIRECTIVE = /^max-age=(?<seconds>\d+)$/u;
const BARE_SECONDS = /^\d+$/u;

/**
 * Map the SDK-wide `cacheControl` (a full `Cache-Control` header value) onto
 * Supabase's `cacheControl`, which is a number of **seconds**: storage-js and
 * the Storage server wrap it as `max-age=<seconds>` themselves, so passing
 * the header through stored `max-age=public, max-age=60`. Supabase can only
 * store a `max-age`, so `max-age=<n>` (alongside an optional `public`, which
 * Supabase-served objects don't carry) maps to `"<n>"`, a bare integer is
 * taken as seconds, and anything else (`no-store`, `immutable`, `private`,
 * `s-maxage`, …) throws rather than being silently dropped.
 */
const cacheControlSeconds = (value: string): string => {
  const trimmed = value.trim();
  if (BARE_SECONDS.test(trimmed)) {
    return trimmed;
  }
  let seconds: string | undefined;
  for (const part of trimmed.split(",")) {
    const directive = part.trim().toLowerCase();
    const maxAge = MAX_AGE_DIRECTIVE.exec(directive)?.groups?.seconds;
    if (maxAge !== undefined && seconds === undefined) {
      seconds = maxAge;
    } else if (directive !== "public" && directive !== "") {
      seconds = undefined;
      break;
    }
  }
  if (seconds === undefined) {
    throw new FilesError(
      "Unsupported",
      `supabase: cacheControl "${value}" is not supported — Supabase stores only a max-age. Pass "max-age=<seconds>" (optionally with "public").`
    );
  }
  return seconds;
};

const isStorageClientLike = (
  candidate: unknown
): candidate is { storage: StorageClient } =>
  isObject(candidate) && "storage" in candidate && isObject(candidate.storage);

const buildClient = (opts: SupabaseAdapterOptions): StorageClient => {
  if (opts.client) {
    return isStorageClientLike(opts.client) ? opts.client.storage : opts.client;
  }
  const url =
    opts.url ?? readEnv("SUPABASE_URL") ?? readEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key =
    opts.key ??
    readEnv("SUPABASE_SERVICE_ROLE_KEY") ??
    readEnv("SUPABASE_KEY") ??
    readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!url || !key) {
    throw new FilesError(
      "Invalid",
      "supabase adapter: missing credentials. Pass `client` (an existing SupabaseClient or StorageClient), or `url` + `key`. Env fallbacks: SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY / SUPABASE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end -= 1;
  }
  const trimmed = url.slice(0, end);
  const storageUrl = trimmed.endsWith("/storage/v1")
    ? trimmed
    : `${trimmed}/storage/v1`;
  return new StorageClient(storageUrl, {
    Authorization: `Bearer ${key}`,
    apikey: key,
  });
};

const b64 = (value: string): string => Buffer.from(value).toString("base64");

interface TusConfig {
  endpoint: string;
  key: string;
}

// Resolve the resumable (TUS) endpoint + key the same way `buildClient`
// resolves the storage URL. Returns `undefined` when only a pre-built `client`
// was supplied (no URL/key to reach the upload endpoint with).
const resolveTusConfig = (
  opts: SupabaseAdapterOptions
): TusConfig | undefined => {
  if (opts.client) {
    return;
  }
  const url =
    opts.url ?? readEnv("SUPABASE_URL") ?? readEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key =
    opts.key ??
    readEnv("SUPABASE_SERVICE_ROLE_KEY") ??
    readEnv("SUPABASE_KEY") ??
    readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!(url && key)) {
    return;
  }
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end -= 1;
  }
  const trimmed = url.slice(0, end);
  const storageUrl = trimmed.endsWith("/storage/v1")
    ? trimmed
    : `${trimmed}/storage/v1`;
  return { endpoint: `${storageUrl}/upload/resumable`, key };
};

// The system metadata block on a listing row. The SDK declares every field
// required, but older deployments omit some, so they are read as optional.
interface SupabaseListItemMetadata {
  eTag?: string;
  size?: number;
  mimetype?: string;
  cacheControl?: string;
  lastModified?: string | number | Date;
  contentLength?: number;
}

// A `listV2` row. `metadata` is the SDK-typed system block; `user_metadata`
// is not declared by the SDK and only returned by some deployments, so it
// arrives as untyped JSON.
interface SupabaseV2Row {
  metadata?: FileMetadata | null;
  user_metadata?: JsonValue;
  key?: string;
  name: string;
}

interface SupabaseInfoLike {
  size?: number;
  contentType?: string;
  etag?: string;
  lastModified?: string | number | Date;
  cacheControl?: string;
  metadata?: JsonObject | null;
}

const toMs = (
  // oxlint-disable-next-line sonarjs/max-union-size -- Supabase returns timestamps as string, number, or Date; all three shapes are handled here.
  value: string | number | Date | undefined
): number | undefined => {
  if (value === undefined || value === null) {
    return;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (isNumber(value)) {
    return value;
  }
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : undefined;
};

const stringifyMetadata = (
  metadata: JsonObject | null | undefined
): Record<string, string> | undefined => {
  if (!metadata) {
    return;
  }
  const out: Record<string, string> = {};
  let any = false;
  for (const [k, v] of Object.entries(metadata)) {
    if (v === undefined || v === null) {
      continue;
    }
    out[k] = isString(v) ? v : JSON.stringify(v);
    any = true;
  }
  return any ? out : undefined;
};

const blobToUint8 = async (blob: Blob): Promise<Uint8Array> =>
  new Uint8Array(await blob.arrayBuffer());

type StorageFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Request options for {@link StorageFetch}, plus `duplex` for stream bodies. */
type StorageRequestInit = RequestInit & {
  duplex?: "half";
  headers?: Record<string, string>;
};

/**
 * The parts of a storage-js `StorageFileApi` needed to call Storage endpoints
 * directly: its storage base URL, default headers, and fetch. The fetch
 * matters — supabase-js passes a wrapper that injects the signed-in user's
 * JWT, so going around it would drop the caller's auth.
 *
 * Every request that puts an object key in its URL goes through this rather
 * than storage-js, which interpolates the key into the path unencoded: a `#`
 * started a fragment and a `?` a query, so `report #1.pdf` addressed (and
 * overwrote) `report `.
 */
interface StorageRequestContext {
  fetch: StorageFetch;
  headers: Record<string, string>;
  url: string;
}

/**
 * Read the request context off a bucket client. The fields are `protected`
 * in storage-js's types but always present at runtime on a real
 * `StorageFileApi`; a duck-typed stand-in may lack them, so they're probed.
 */
const requestContextOf = (
  bucketRef: ReturnType<StorageClient["from"]>
): StorageRequestContext | undefined => {
  // Widened so the `protected` fields can be probed by name.
  const ref: object = bucketRef;
  if (!("url" in ref && "headers" in ref && "fetch" in ref)) {
    return;
  }
  const { url, headers, fetch: fetcher } = ref;
  if (!(isString(url) && isObject(headers) && isFunction(fetcher))) {
    return;
  }
  const stringHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isString(value)) {
      stringHeaders[name] = value;
    }
  }
  return {
    // SAFETY: storage-js types `BaseApiClient#fetch` as its `Fetch`
    // (`typeof fetch`), built by `resolveFetch` as an arrow wrapper, so it
    // takes a URL string + RequestInit and needs no `this`.
    fetch: fetcher as StorageFetch,
    headers: stringHeaders,
    url,
  };
};

/** A response's JSON body, or `undefined` when it isn't JSON. */
const readJson = async (res: Response): Promise<JsonValue | undefined> => {
  try {
    const parsed: JsonValue = await res.json();
    return parsed;
  } catch {
    // An error page or empty body: classified by its HTTP status alone.
  }
};

/** Map the object-info endpoint's snake_case body onto {@link SupabaseInfoLike}. */
const fromRawInfo = (body: JsonValue | undefined): SupabaseInfoLike => {
  if (!isJsonObject(body)) {
    return {};
  }
  const { size } = body;
  const contentType = body["content_type"];
  const { etag } = body;
  const lastModified = body["last_modified"] ?? body["updated_at"];
  const { metadata } = body;
  return {
    ...(isNumber(size) && { size }),
    ...(isString(contentType) && { contentType }),
    ...(isString(etag) && { etag }),
    ...((isString(lastModified) || isNumber(lastModified)) && {
      lastModified,
    }),
    ...(isJsonObject(metadata) && { metadata }),
  };
};

/**
 * Percent-encode each path segment of a key (keeping `/` literal, and
 * dropping leading slashes as storage-js does). The Storage server decodes
 * each segment back, so `?`, `#`, `%`, spaces and non-ASCII reach it as part
 * of the key instead of ending the path or being decoded twice.
 */
const encodeObjectPath = (key: string): string =>
  key.replace(/^\/+/u, "").split("/").map(encodeURIComponent).join("/");

/**
 * storage-js's upload-path normalisation (`_removeEmptyFolders`): one leading
 * and one trailing slash dropped, runs of slashes collapsed. Mirrored so an
 * upload stores the same key it did when storage-js built the request.
 */
const normalizeUploadKey = (key: string): string =>
  key.replaceAll(/^\/|\/$/gu, "").replaceAll(/\/+/gu, "/");

const TOKEN_PARAM = "?token=";

/**
 * The token from a server-built signed path (`/object/…/<key>?token=<jwt>`).
 * The key itself may contain `?token=`, so the last occurrence is the token.
 */
const tokenFrom = (signedPath: string): string | undefined => {
  const at = signedPath.lastIndexOf(TOKEN_PARAM);
  return at === -1 ? undefined : signedPath.slice(at + TOKEN_PARAM.length);
};

/** The token in a signed-upload response: `token`, or parsed from `url`. */
const uploadTokenOf = (body: JsonValue | undefined): string | undefined => {
  if (!isJsonObject(body)) {
    return;
  }
  if (isString(body.token)) {
    return body.token;
  }
  return isString(body.url) ? tokenFrom(body.url) : undefined;
};

/**
 * Send a request through the client's own URL, headers and fetch. A non-2xx
 * answer is mapped like storage-js's `StorageApiError`: the HTTP status plus
 * the body's `statusCode` / `code` / `error` / `message`.
 */
const send = async (
  ctx: StorageRequestContext,
  path: string,
  init: StorageRequestInit
): Promise<Response> => {
  try {
    const res = await ctx.fetch(`${ctx.url}${path}`, {
      ...init,
      headers: { ...ctx.headers, ...init.headers },
    });
    if (!res.ok) {
      const body = await readJson(res);
      throw mapSupabaseError({
        ...(isJsonObject(body) && body),
        status: res.status,
      });
    }
    return res;
  } catch (error) {
    throw mapSupabaseError(error);
  }
};

/** Release a response body the caller has no use for. */
const discard = async (res: Response): Promise<void> => {
  await res.body?.cancel();
};

interface DirectUploadOptions {
  cacheSeconds: string | undefined;
  contentType: string;
  metadata: Record<string, string> | undefined;
  signal: AbortSignal | undefined;
}

/**
 * The request storage-js's `upload()` sends (`POST /object/{bucket}/{key}`
 * with `x-upsert: true`), built with an encoded key. A Blob goes multipart
 * with the cache seconds and metadata as form fields; any other body is sent
 * raw with them as headers.
 */
const directUploadInit = (
  data: Uint8Array | ReadableStream<Uint8Array> | Blob,
  opts: DirectUploadOptions
): StorageRequestInit => {
  const cacheSeconds = opts.cacheSeconds ?? DEFAULT_CACHE_SECONDS;
  const base = {
    method: "POST",
    ...(opts.signal && { signal: opts.signal }),
  };
  if (data instanceof Blob) {
    const form = new FormData();
    form.append("cacheControl", cacheSeconds);
    if (opts.metadata) {
      form.append("metadata", JSON.stringify(opts.metadata));
    }
    form.append("", data);
    return { ...base, body: form, headers: { "x-upsert": "true" } };
  }
  return {
    ...base,
    // SAFETY: `BodyInit` pins a view to `ArrayBuffer` backing (TS 5.7
    // widened typed arrays to `ArrayBufferLike`); `normalizeBody` only
    // produces views over the caller's ordinary buffers or fresh encodes.
    body: data as BodyInit,
    ...(data instanceof ReadableStream && { duplex: "half" as const }),
    headers: {
      "cache-control": `max-age=${cacheSeconds}`,
      "content-type": opts.contentType,
      "x-upsert": "true",
      ...(opts.metadata && {
        "x-metadata": b64(JSON.stringify(opts.metadata)),
      }),
    },
  };
};

/**
 * Supabase's TUS endpoint as an offset-mode resumable driver. Only attached
 * when the adapter resolved a project URL + key to reach `/upload/resumable`
 * with — a pre-built `client` carries neither.
 */
const tusDriver = (
  tus: TusConfig,
  bucket: string,
  key: string,
  resumableOpts: ResumableDriverOptions
): OffsetResumableDriver => {
  // Supabase's TUS endpoint reads `cacheControl` as seconds and user
  // metadata as a JSON string under `metadata` (its `user_metadata`).
  // Validate the cache-control mapping up front, before any request.
  const cacheSeconds =
    resumableOpts.cacheControl === undefined
      ? undefined
      : cacheControlSeconds(resumableOpts.cacheControl);
  const extraMetadata = [
    ...(cacheSeconds === undefined
      ? []
      : [`cacheControl ${b64(cacheSeconds)}`]),
    ...(resumableOpts.metadata
      ? [`metadata ${b64(JSON.stringify(resumableOpts.metadata))}`]
      : []),
  ];
  let uri: string | undefined;
  let contentType = DEFAULT_CONTENT_TYPE;
  let lastOffset = 0;
  const requireUri = () => {
    if (!uri) {
      throw new FilesError(
        "Invalid",
        "supabase: resumable upload has no session."
      );
    }
    return uri;
  };
  const authHeaders = () => ({
    Authorization: `Bearer ${tus.key}`,
    "Tus-Resumable": "1.0.0",
    apikey: tus.key,
  });
  return {
    adopt(session: ResumableUploadSession) {
      if (session.provider !== "supabase") {
        throw new FilesError(
          "Invalid",
          `Cannot resume a ${session.provider} session on a supabase adapter.`
        );
      }
      if (session.key !== key) {
        throw new FilesError(
          "Invalid",
          "Resume token does not match this upload's key."
        );
      }
      uri = sameOriginSessionUrl(
        session.uri,
        tus.endpoint,
        "supabase resumable session URL"
      );
      ({ contentType } = session);
    },
    async begin(meta): Promise<ResumableUploadSession> {
      ({ contentType } = meta);
      const { endpoint } = tus;
      const res = await fetch(endpoint, {
        headers: {
          ...authHeaders(),
          "Upload-Length": String(meta.total),
          "Upload-Metadata": [
            `bucketName ${b64(bucket)}`,
            `objectName ${b64(key)}`,
            `contentType ${b64(meta.contentType)}`,
            ...extraMetadata,
          ].join(","),
          "x-upsert": "true",
        },
        method: "POST",
      });
      if (res.status !== 201) {
        throw statusError(
          res.status,
          "supabase: resumable session init failed"
        );
      }
      const location = res.headers.get("location");
      if (!location) {
        throw new FilesError(
          "Provider",
          "supabase: resumable session response missing Location header"
        );
      }
      uri = sameOriginSessionUrl(
        location,
        endpoint,
        "supabase resumable session URL"
      );
      return { contentType, key, provider: "supabase", uri };
    },
    complete(): Promise<UploadResult> {
      return Promise.resolve({ contentType, key, size: lastOffset });
    },
    async discard() {
      if (!uri) {
        return;
      }
      try {
        const res = await fetch(uri, {
          headers: authHeaders(),
          method: "DELETE",
        });
        // A refused or failed cancel leaves the session live, so it throws
        // (401/403 Unauthorized, 5xx retryable); 404/410 mean it's gone.
        assertSessionDiscarded(res, "supabase: upload session cancel failed");
      } catch (error) {
        throw mapSupabaseError(error);
      }
    },
    mode: "offset",
    // Supabase's TUS endpoint requires exactly 6 MiB chunks ("must be set
    // to 6MB, do not change it"), so a caller's `multipart.partSize` is
    // rounded to that one valid size rather than forwarded.
    partSize: TUS_CHUNK_SIZE,
    async probe(): Promise<{ nextOffset: number }> {
      const res = await fetch(requireUri(), {
        headers: authHeaders(),
        method: "HEAD",
      });
      if (!res.ok) {
        // An expired or terminated TUS upload answers 404/410 (NotFound).
        throw statusError(res.status, "supabase: resume status check failed");
      }
      lastOffset = Number(res.headers.get("upload-offset") ?? 0);
      return { nextOffset: lastOffset };
    },
    async uploadAt({ offset, data, signal }): Promise<{ nextOffset: number }> {
      // SAFETY: `BodyInit` pins the view to `ArrayBuffer` backing (TS 5.7
      // widened typed arrays to `ArrayBufferLike`); the orchestrator
      // slices each chunk from the upload body into a fresh view, never
      // shared memory.
      const chunk = data as BodyInit;
      const res = await fetch(requireUri(), {
        body: chunk,
        headers: {
          ...authHeaders(),
          "Content-Type": "application/offset+octet-stream",
          "Upload-Offset": String(offset),
        },
        method: "PATCH",
        ...(signal && { signal }),
      });
      if (!res.ok) {
        // A TUS offset mismatch answers 409 (Conflict): re-sending the
        // same chunk can only fail the same way, so it isn't retried.
        throw statusError(res.status, "supabase: chunk upload failed");
      }
      lastOffset = Number(
        res.headers.get("upload-offset") ?? offset + data.byteLength
      );
      return { nextOffset: lastOffset };
    },
  };
};

export const supabase = (opts: SupabaseAdapterOptions): SupabaseAdapter => {
  const { bucket, public: isPublic, publicBaseUrl } = opts;
  if (!bucket) {
    throw new FilesError(
      "Invalid",
      "supabase adapter: missing bucket. Pass `bucket`."
    );
  }
  const client = buildClient(opts);
  const bucketRef = client.from(bucket);
  const requestContext = requestContextOf(bucketRef);
  const tus = resolveTusConfig(opts);
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;
  const bucketPath = encodeURIComponent(bucket);
  /** `{bucket}/{key}` for a Storage URL, each segment percent-encoded. */
  const objectPath = (key: string): string =>
    `${bucketPath}/${encodeObjectPath(key)}`;

  /**
   * Fetch an object's info (size, type, etag, last-modified, user metadata).
   * storage-js's `info()` runs the response through `recursiveToCamel`,
   * which rewrites every nested key — user metadata included — so
   * `fsenc_dek_iv` came back as `fsencDekIv` and the encryption, compression,
   * and dedup plugins couldn't find their fields. Call the same
   * `/object/info/{bucket}/{key}` endpoint directly, through the client's own
   * URL, headers, and fetch, so keys come back exactly as stored.
   */
  const objectInfo = async (
    key: string,
    signal?: AbortSignal
  ): Promise<SupabaseInfoLike> => {
    if (!requestContext) {
      // A stand-in client without storage-js internals: only `info()` is
      // reachable.
      const { data, error } = await bucketRef.info(key);
      if (error) {
        throw mapSupabaseError(error);
      }
      return data;
    }
    const res = await send(requestContext, `/object/info/${objectPath(key)}`, {
      method: "GET",
      ...(signal && { signal }),
    });
    return fromRawInfo(await readJson(res));
  };

  /**
   * An object's bytes (`GET /object/{bucket}/{key}`, what storage-js's
   * `download()` requests), with the key encoded.
   */
  const fetchObject = (
    ctx: StorageRequestContext,
    key: string,
    signal: AbortSignal | undefined
  ): Promise<Response> =>
    send(ctx, `/object/${objectPath(key)}`, {
      method: "GET",
      ...(signal && { signal }),
    });

  /**
   * A signed read URL. The single-object sign endpoint signs the request
   * path after only `decodeURI`, so an encoded `?`, `+`, `&`, `=`, … stays
   * encoded in the token and never matches the decoded key when the URL is
   * fetched. The batch endpoint takes the key in its JSON body and signs it
   * verbatim; the URL is then built here with the key encoded, which the
   * server decodes back to that same key when verifying.
   */
  const signedReadUrl = async (
    ctx: StorageRequestContext,
    key: string,
    expiresIn: number,
    download: true | string | undefined
  ): Promise<string> => {
    const res = await send(ctx, `/object/sign/${bucketPath}`, {
      body: JSON.stringify({ expiresIn, paths: [key] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await readJson(res);
    const entry = isJsonArray(body) ? body[0] : undefined;
    const signed =
      isJsonObject(entry) && isString(entry.signedURL)
        ? entry.signedURL
        : undefined;
    if (!signed) {
      // A missing (or unreadable) object comes back as a per-path error.
      throw mapSupabaseError({
        error: "not_found",
        message:
          isJsonObject(entry) && isString(entry.error)
            ? entry.error
            : "Object not found",
        statusCode: "404",
      });
    }
    const token = tokenFrom(signed);
    if (!token) {
      throw new FilesError(
        "Provider",
        "supabase: the signed URL response carried no token"
      );
    }
    const query = new URLSearchParams({ token });
    if (download !== undefined) {
      query.set("download", download === true ? "" : download);
    }
    return `${ctx.url}/object/sign/${objectPath(key)}?${query.toString()}`;
  };

  /**
   * Object info for a download, settled rather than thrown so it can run
   * alongside the body request. The body is already in hand, so a NotFound
   * (the object was deleted between the two requests, or a self-hosted
   * deployment predates the info endpoint) degrades to a file without
   * metadata. Any other failure is kept to throw: returning the body without
   * its metadata would hand the encryption plugin ciphertext it can't
   * recognise.
   */
  const settledDownloadInfo = async (
    key: string,
    signal: AbortSignal | undefined
  ): Promise<
    { meta: SupabaseInfoLike | undefined } | { error: FilesError }
  > => {
    try {
      return { meta: await objectInfo(key, signal) };
    } catch (error) {
      const mapped = mapSupabaseError(error);
      return mapped.code === "NotFound"
        ? { meta: undefined }
        : { error: mapped };
    }
  };

  /**
   * Fetch the body and its info concurrently. The body's error wins: a
   * missing object reports the download's NotFound, not the info lookup's.
   */
  const withInfo = async <T>(
    key: string,
    signal: AbortSignal | undefined,
    fetchBody: () => Promise<T>
  ): Promise<{ body: T; meta: SupabaseInfoLike | undefined }> => {
    const pending = settledDownloadInfo(key, signal);
    const body = await fetchBody();
    const settled = await pending;
    if ("error" in settled) {
      throw settled.error;
    }
    return { body, meta: settled.meta };
  };

  const downloadAsStreamFile = async (
    key: string,
    signal?: AbortSignal
  ): Promise<StoredFile> => {
    // Supabase's download response carries no user metadata, so the info
    // endpoint supplies size/type/etag/metadata alongside the body.
    const { body: stream, meta } = await withInfo(key, signal, async () => {
      if (requestContext) {
        const res = await fetchObject(requestContext, key, signal);
        return res.body ?? new Blob().stream();
      }
      const { data, error } = await bucketRef
        .download(key, undefined, fetchParams(signal))
        .asStream();
      if (error) {
        throw mapSupabaseError(error);
      }
      const body: ReadableStream<Uint8Array> = data;
      return body;
    });
    return createStoredFile(
      {
        contentType: meta?.contentType ?? DEFAULT_CONTENT_TYPE,
        ...(meta?.etag && { etag: stripEtag(meta.etag) }),
        key,
        ...(meta?.lastModified && {
          lastModified: toMs(meta.lastModified),
        }),
        ...(meta?.metadata && {
          metadata: stringifyMetadata(meta.metadata),
        }),
        size: meta?.size ?? 0,
      },
      {
        factory: () => stream,
        kind: "stream",
      }
    );
  };

  const downloadAsBufferFile = async (
    key: string,
    signal?: AbortSignal
  ): Promise<StoredFile> => {
    // The download response carries no user metadata (nor, reliably, an
    // etag), so the info endpoint is always consulted alongside it.
    const { body: blob, meta } = await withInfo(key, signal, async () => {
      if (requestContext) {
        const res = await fetchObject(requestContext, key, signal);
        return await res.blob();
      }
      const { data, error } = await bucketRef.download(
        key,
        undefined,
        fetchParams(signal)
      );
      if (error) {
        throw mapSupabaseError(error);
      }
      const body: Blob = data;
      return body;
    });
    const bytes = await blobToUint8(blob);
    // The served Content-Type wins; Blob.type is empty only when Supabase
    // didn't echo one, and then the stored type from info() fills in.
    const type = blob.type || meta?.contentType || DEFAULT_CONTENT_TYPE;
    const etag = stripEtag(meta?.etag);
    const lastModified = toMs(meta?.lastModified);
    const metadata = stringifyMetadata(meta?.metadata);
    return createStoredFile(
      {
        contentType: type,
        ...(etag && { etag }),
        key,
        ...(lastModified !== undefined && { lastModified }),
        ...(metadata && { metadata }),
        size: bytes.byteLength,
      },
      { data: bytes, kind: "buffer" }
    );
  };

  const deleteOne = async (key: string): Promise<void> => {
    // `remove()` is idempotent in Supabase — it returns an empty array
    // (not an error) when the key doesn't exist, matching the
    // silent-on-missing behavior of S3/Azure.
    const { error } = await bucketRef.remove([key]);
    if (error) {
      throw mapSupabaseError(error);
    }
  };

  return {
    bucket,
    capabilities: {
      cacheControl: true,
      // `list()` folds on "/" only (`with_delimiter`); other delimiters throw.
      delimiter: "slash",
      // Database Webhooks on `storage.objects`.
      events: { format: "supabase" },
      metadata: true,
      // A plain `url()` returns a permanent link with `publicBaseUrl` or
      // `public: true` (`getPublicUrl()`).
      publicUrl: Boolean(publicBaseUrl) || Boolean(isPublic),
      // `copy()` is a server-side Storage copy.
      serverSideCopy: true,
      // `signedUploadUrl()` mints a `createSignedUploadUrl` token, which binds
      // neither a size limit nor a Content-Type (so `maxSize` / `contentType`
      // throw). Supabase fixes its TTL at 2 hours and ignores `expiresIn`.
      signedUpload: { contentType: false, maxSize: false, supported: true },
      // `url()` mints a `createSignedUrl` (or a public URL when configured
      // and neither `expiresIn` nor `responseContentDisposition` is passed).
      // An attachment disposition is bound via the signed URL's `download`
      // option; `inline` and other types throw.
      signedUrl: { disposition: true, expiry: "exact", supported: true },
    },
    async copy(from, to, copyOpts) {
      if (requestContext) {
        // storage-js's `copy()` sends no `x-upsert`, and without it the
        // server refuses an existing destination (KeyAlreadyExists) — so a
        // copy or move onto a key that exists failed instead of replacing
        // it, as every other adapter's copy does.
        await discard(
          await send(requestContext, "/object/copy", {
            body: JSON.stringify({
              bucketId: bucket,
              destinationKey: to,
              sourceKey: from,
            }),
            headers: { "content-type": "application/json", "x-upsert": "true" },
            method: "POST",
            ...(copyOpts?.signal && { signal: copyOpts.signal }),
          })
        );
        return;
      }
      const { error } = await bucketRef.copy(from, to);
      if (error) {
        throw mapSupabaseError(error);
      }
    },
    delete: deleteOne,
    async deleteMany(keys, deleteOpts) {
      if (keys.length === 0) {
        return { results: [] };
      }
      if (deleteOpts?.stopOnError) {
        return deleteManyWithFallback(
          keys,
          deleteOne,
          deleteOpts,
          mapSupabaseError
        );
      }
      // Supabase Storage caps a bulk delete at 1000 objects, so the keys go
      // out in batches of that size. On success `remove()` doesn't report
      // which keys actually existed; like `delete()`, a missing key counts as
      // deleted.
      const results: string[] = [];
      const errors: { error: FilesError; key: string }[] = [];
      for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
        const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
        // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- batches go one at a time so a large delete doesn't fan out into many concurrent requests
        const { error } = await bucketRef.remove(batch);
        if (error) {
          // `remove()` surfaces a single batch-level error rather than
          // per-key failures, so map it onto every key in the batch.
          const mapped = mapSupabaseError(error);
          for (const key of batch) {
            errors.push({ error: mapped, key });
          }
        } else {
          results.push(...batch);
        }
      }
      return { ...(errors.length > 0 && { errors }), results };
    },
    download(key, downloadOpts) {
      if (downloadOpts?.as === "stream") {
        return downloadAsStreamFile(key, downloadOpts?.signal);
      }
      return downloadAsBufferFile(key, downloadOpts?.signal);
    },
    exists(key, existsOpts) {
      return existsByProbe(
        () => objectInfo(key, existsOpts?.signal),
        mapSupabaseError
      );
    },
    async head(key, headOpts) {
      const info = await objectInfo(key, headOpts?.signal);
      return {
        contentType: info.contentType ?? DEFAULT_CONTENT_TYPE,
        ...(info.etag && { etag: stripEtag(info.etag) }),
        key,
        ...(info.lastModified !== undefined && {
          lastModified: toMs(info.lastModified),
        }),
        ...(info.metadata && {
          metadata: stringifyMetadata(info.metadata),
        }),
        size: info.size ?? 0,
      };
    },
    async list(options): Promise<ListResult> {
      // Both shapes go through the V2 search API. The legacy V1 list() is
      // folder-scoped and non-recursive — it returns only the direct
      // children of the prefix-as-folder, with subfolders folded in as
      // zero-size placeholder rows — so a flat listing of a bucket with
      // nested keys would miss every nested object and surface phantom
      // zero-byte "files" for the folders. listV2 without a delimiter is a
      // plain string-prefix scan over full keys, with a real cursor.
      const v2Item = (obj: SupabaseV2Row, fullKey: string): FileInfo => {
        const meta: SupabaseListItemMetadata = obj.metadata ?? {};
        // `metadata` on a listing row is Supabase's *system* block (eTag,
        // size, mimetype, cacheControl, ...) — never user metadata. Surfacing
        // it as `metadata` would report phantom keys that head()/download()
        // don't. User metadata, when the API returns it at all, lives under
        // `user_metadata`.
        const userMetadata = stringifyMetadata(
          isJsonObject(obj.user_metadata) ? obj.user_metadata : undefined
        );
        return {
          contentType: meta.mimetype ?? DEFAULT_CONTENT_TYPE,
          ...(meta.eTag && { etag: stripEtag(meta.eTag) }),
          key: fullKey,
          ...(meta.lastModified !== undefined && {
            lastModified: toMs(meta.lastModified),
          }),
          ...(userMetadata && { metadata: userMetadata }),
          size: meta.size ?? meta.contentLength ?? 0,
        };
      };
      const listFolded = async (delimiter: string): Promise<ListResult> => {
        assertSlashDelimiter("supabase", delimiter);
        const { data, error } = await bucketRef.listV2(
          {
            limit: options?.limit ?? DEFAULT_LIST_LIMIT,
            with_delimiter: true,
            ...(options?.prefix && { prefix: options.prefix }),
            ...(options?.cursor && { cursor: options.cursor }),
          },
          fetchParams(options?.signal)
        );
        if (error) {
          throw mapSupabaseError(error);
        }
        const trimmedPrefix = options?.prefix?.replace(/\/$/u, "");
        const fullPath = (name: string, key?: string): string =>
          key ?? (trimmedPrefix ? `${trimmedPrefix}/${name}` : name);
        const items: FileInfo[] = data.objects.map((obj) =>
          v2Item(obj, fullPath(obj.name, obj.key))
        );
        const prefixes = data.folders.map((folder) => {
          const raw = fullPath(folder.name, folder.key);
          return raw.endsWith("/") ? raw : `${raw}/`;
        });
        return {
          items,
          ...(data.hasNext && data.nextCursor && { cursor: data.nextCursor }),
          ...(prefixes.length && { prefixes }),
        };
      };
      if (options?.delimiter) {
        return await listFolded(options.delimiter);
      }
      const { data, error } = await bucketRef.listV2(
        {
          limit: options?.limit ?? DEFAULT_LIST_LIMIT,
          ...(options?.prefix && { prefix: options.prefix }),
          ...(options?.cursor && { cursor: options.cursor }),
        },
        fetchParams(options?.signal)
      );
      if (error) {
        throw mapSupabaseError(error);
      }
      // Flat-mode object names are already full keys (`key` when the server
      // provides it is the same path).
      const items: FileInfo[] = data.objects.map((obj) =>
        v2Item(obj, obj.key ?? obj.name)
      );
      return {
        items,
        ...(data.hasNext && data.nextCursor && { cursor: data.nextCursor }),
      };
    },
    name: "supabase",
    raw: client,
    ...(tus && {
      resumableUpload: (key: string, resumableOpts: ResumableDriverOptions) =>
        tusDriver(tus, bucket, key, resumableOpts),
    }),
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      // Supabase's createSignedUploadUrl has no `content-length-range`
      // equivalent — there's no way to enforce a max upload size at the
      // URL level. Throw rather than silently no-op so callers don't
      // ship a "limit" that does nothing. Same honest-API stance Azure
      // takes for the same gap.
      if (signOpts.maxSize !== undefined) {
        throw new FilesError(
          "Unsupported",
          "supabase: `maxSize` is not supported. Supabase signed upload URLs have no server-enforced size limit equivalent to S3's content-length-range policy. Set the bucket-level file size limit in the Supabase dashboard, or enforce the limit at your application gateway before issuing the signed URL."
        );
      }
      // `minSize: 0` (no minimum) holds trivially; a positive floor has no
      // Supabase equivalent, so fail closed like `maxSize`.
      if (signOpts.minSize !== undefined && signOpts.minSize > 0) {
        throw new FilesError(
          "Unsupported",
          "supabase: `minSize` is not supported. Supabase signed upload URLs have no minimum-size constraint; pass `minSize: 0` or omit it, and reject small uploads at your application gateway."
        );
      }
      // Same gap for `contentType`: the signed upload token doesn't bind a
      // Content-Type, so the uploader could send any type. Returning it as a
      // header would be advisory only, which the `signedUploadUrl` contract
      // forbids — throw, as Azure does.
      if (signOpts.contentType !== undefined) {
        throw new FilesError(
          "Unsupported",
          "supabase: `contentType` is not supported for signed upload URLs. Supabase signed upload tokens don't bind the request Content-Type, so restrict types with the bucket's allowed MIME types in the Supabase dashboard, or validate at your application gateway before issuing the signed URL."
        );
      }
      // `expiresIn` is intentionally ignored — Supabase fixes the TTL at
      // 2 hours server-side and offers no per-URL override.
      if (requestContext) {
        // The server signs the decoded key and answers with it raw in the
        // URL (storage-js then re-parses that URL), so the token is taken
        // from the answer and the URL rebuilt with the key encoded.
        const res = await send(
          requestContext,
          `/object/upload/sign/${objectPath(key)}`,
          {
            body: "{}",
            headers: { "content-type": "application/json", "x-upsert": "true" },
            method: "POST",
          }
        );
        const token = uploadTokenOf(await readJson(res));
        if (!token) {
          throw new FilesError(
            "Provider",
            "supabase: the signed upload URL response carried no token"
          );
        }
        return {
          headers: { "x-upsert": "true" },
          method: "PUT",
          url: `${requestContext.url}/object/upload/sign/${objectPath(key)}?${new URLSearchParams({ token }).toString()}`,
        };
      }
      const { data, error } = await bucketRef.createSignedUploadUrl(key, {
        upsert: true,
      });
      if (error) {
        throw mapSupabaseError(error);
      }
      const { signedUrl } = data;
      return {
        headers: {
          "x-upsert": "true",
        },
        method: "PUT",
        url: signedUrl,
      };
    },
    async upload(key, body, options) {
      const { data, contentType, contentLength } = await normalizeBody(
        body,
        options?.contentType
      );
      const cacheSeconds = options?.cacheControl
        ? cacheControlSeconds(options.cacheControl)
        : undefined;
      if (requestContext) {
        await discard(
          await send(
            requestContext,
            `/object/${objectPath(normalizeUploadKey(key))}`,
            directUploadInit(data, {
              cacheSeconds,
              contentType,
              metadata: options?.metadata,
              signal: options?.signal,
            })
          )
        );
      } else {
        const fileOptions = {
          contentType,
          upsert: true,
          ...(cacheSeconds !== undefined && { cacheControl: cacheSeconds }),
          ...(options?.metadata && { metadata: options.metadata }),
        };
        // Supabase requires `duplex: 'half'` when uploading a ReadableStream.
        // The SDK threads this through `FileOptions.duplex`.
        const optsWithDuplex =
          data instanceof ReadableStream
            ? { ...fileOptions, duplex: "half" }
            : fileOptions;
        const { error } = await bucketRef.upload(key, data, optsWithDuplex);
        if (error) {
          throw mapSupabaseError(error);
        }
      }
      // For stream bodies we don't know the size locally; ask `info()`
      // for the authoritative value. For buffer bodies we already have it.
      let size = contentLength;
      let etag: string | undefined;
      let lastModified: number | undefined;
      if (size === undefined) {
        let info: SupabaseInfoLike | undefined;
        try {
          info = await objectInfo(key);
        } catch {
          // Best effort: the write already succeeded, so a failed lookup
          // reports size 0 rather than failing (and retrying) the upload.
        }
        size = info?.size ?? 0;
        etag = stripEtag(info?.etag);
        lastModified = toMs(info?.lastModified);
      }
      return {
        contentType,
        ...(etag && { etag }),
        key,
        ...(lastModified !== undefined && { lastModified }),
        size,
      } satisfies UploadResult;
    },
    async url(key, urlOpts): Promise<string> {
      // Same precedence rule as S3/Azure: `responseContentDisposition`
      // forces signing even when a public URL is configured, because the
      // override has to be bound into the signature. Silently dropping
      // it would be a stored-XSS regression on user-uploaded content. An
      // explicit `expiresIn` forces signing too: the caller asked for a link
      // that expires, which a permanent public URL can't be.
      const mustSign =
        Boolean(urlOpts?.responseContentDisposition) ||
        urlOpts?.expiresIn !== undefined;
      if (publicBaseUrl && !mustSign) {
        return joinPublicUrl(publicBaseUrl, key);
      }
      if (isPublic && !mustSign) {
        if (requestContext) {
          // storage-js's `getPublicUrl()` runs the URL through `encodeURI`,
          // which leaves a `#` or `?` in the key unescaped.
          return `${requestContext.url}/object/public/${objectPath(key)}`;
        }
        const { data } = bucketRef.getPublicUrl(key);
        return data.publicUrl;
      }
      // Public modes asked to sign and the default private path all mint a
      // signed URL, so the expiry and disposition can be bound in.
      const expiresIn = urlOpts?.expiresIn ?? defaultUrlExpiresIn;
      const download = urlOpts?.responseContentDisposition
        ? downloadOptionFor(urlOpts.responseContentDisposition)
        : undefined;
      if (requestContext) {
        return await signedReadUrl(requestContext, key, expiresIn, download);
      }
      const { data, error } = await bucketRef.createSignedUrl(key, expiresIn, {
        ...(download !== undefined && { download }),
      });
      if (error) {
        throw mapSupabaseError(error);
      }
      return data.signedUrl;
    },
  };
};
