import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type {
  AccessToken,
  GetTokenOptions,
  TokenCredential,
} from "@azure/identity";
import { ClientSecretCredential } from "@azure/identity";
import {
  Client,
  GraphError,
  ResponseType,
} from "@microsoft/microsoft-graph-client";
import type {
  AuthenticationProvider,
  ClientOptions,
} from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js";

import type {
  Adapter,
  Body,
  FileInfo,
  ListResult,
  MultipartOptions,
  OffsetResumableDriver,
  ResumableDriverOptions,
  ResumableUploadSession,
  SignedUpload,
  UploadResult,
} from "../index.js";
import {
  assertSlashDelimiter,
  existsByProbe,
  httpRangeHeader,
  rangedSize,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError, dispositionUnsupported } from "../internal/errors.js";
import type { ProviderFilesErrorCode } from "../internal/errors.js";
import { isNumber, isObject, isString } from "../internal/is.js";
import { isJsonObject } from "../internal/json.js";
import type { JsonValue } from "../internal/json.js";
import { toWebStream } from "../internal/node-stream";
import { assertSessionDiscarded } from "../internal/resumable-offset-http.js";
import { trustedHttpsSessionUrl } from "../internal/resumable-session-url.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface OneDriveAdapterOptions {
  /**
   * App-only (client credentials) auth. Required for unattended access to
   * SharePoint or OneDrive-for-Business — the app acts on its own behalf.
   * Cannot use `/me/drive`; you must pass `driveId`, `siteId`, or `userId`
   * to target a specific drive.
   */
  clientCredentials?: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  };
  /**
   * Delegated (3-legged) auth via OAuth refresh token. The adapter mints
   * fresh access tokens against `clientId`/`clientSecret`. `tenantId`
   * defaults to `"common"`. Mutually exclusive with the other auth
   * shapes.
   */
  oauth?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    tenantId?: string;
  };
  /**
   * Static or dynamic access token. Pass a string for a one-shot token, or
   * an async function to mint fresh tokens on demand (e.g. via
   * `@azure/identity`, NextAuth, or your own broker). The adapter does not
   * cache the result — your callable is responsible for caching/refresh.
   */
  accessToken?: string | (() => string | Promise<string>);
  /**
   * Pre-built `@microsoft/microsoft-graph-client` `Client` — escape hatch
   * for callers that already wire auth themselves. `signedUploadUrl()`
   * still works because Graph's upload-session URL is pre-authenticated
   * by Graph itself.
   */
  client?: Client;
  /**
   * Target a specific drive by id (`/drives/{driveId}`). Works with any
   * auth shape; **required** for `clientCredentials` since `/me/drive` is
   * not available without an interactive user. Mutually exclusive with
   * `siteId`/`userId`.
   */
  driveId?: string;
  /**
   * Target the default document library of a SharePoint site
   * (`/sites/{siteId}/drive`). Mutually exclusive with `driveId`/`userId`.
   */
  siteId?: string;
  /**
   * Target a specific user's drive (`/users/{userId}/drive`). Typical with
   * app-only auth. Mutually exclusive with `driveId`/`siteId`.
   */
  userId?: string;
  /**
   * Logical "bucket root" — virtual keys live under this folder path,
   * which must already exist on the drive. Defaults to the drive root.
   */
  rootFolderPath?: string;
  /**
   * When `true`, `upload()` also creates an anonymous-view sharing link
   * and `url()` returns that link's `webUrl`. When `false` (default),
   * `url()` throws — Graph has no signed URL primitive for private items.
   *
   * **Tenant policy note:** anonymous links are blocked on tenants where
   * an admin has disabled them. Upload will surface Graph's `accessDenied`
   * error in that case.
   */
  publicByDefault?: boolean;
  /**
   * Maximum time (ms) to wait for an async copy operation to complete.
   * Graph returns 202 + a monitor URL; the adapter polls until completed
   * or this timeout elapses, at which point the call throws `Provider`.
   * Defaults to 60_000.
   */
  copyTimeoutMs?: number;
}

export type OneDriveClient = Client;
export type OneDriveAdapter = Omit<
  Adapter<OneDriveClient>,
  "resumableUpload"
> & {
  readonly basePath: string;
  readonly rootFolderPath: string;
  /** Always present — Graph upload sessions back every OneDrive adapter. */
  readonly resumableUpload: (
    key: string,
    opts: ResumableDriverOptions
  ) => OffsetResumableDriver;
};

const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
const OCTET_STREAM = "application/octet-stream";
const MISSING_UPLOAD_URL_MESSAGE =
  "onedrive: createUploadSession response missing uploadUrl";
const SIMPLE_UPLOAD_LIMIT_BYTES = 250 * 1024 * 1024;
const DEFAULT_COPY_TIMEOUT_MS = 60_000;
const COPY_POLL_INTERVAL_MS = 500;
// Graph requires every upload-session fragment except the last to be a multiple
// of 320 KiB and no larger than 60 MiB. Default to ~10 MiB (already a clean
// multiple) and clamp any caller-supplied `partSize` down to a valid multiple
// (never below one unit, never above the largest multiple that fits the cap).
const GRAPH_FRAGMENT_MULTIPLE = 320 * 1024;
const GRAPH_FRAGMENT_MAX_BYTES =
  Math.floor((60 * 1024 * 1024) / GRAPH_FRAGMENT_MULTIPLE) *
  GRAPH_FRAGMENT_MULTIPLE;
const DEFAULT_UPLOAD_SESSION_RANGE_BYTES = 10 * 1024 * 1024;

const resolveRangeSize = (
  multipart: boolean | MultipartOptions | undefined
): number => {
  const requested = isObject(multipart) ? multipart.partSize : undefined;
  if (requested === undefined) {
    return DEFAULT_UPLOAD_SESSION_RANGE_BYTES;
  }
  const rounded =
    Math.floor(requested / GRAPH_FRAGMENT_MULTIPLE) * GRAPH_FRAGMENT_MULTIPLE;
  return Math.min(
    Math.max(rounded, GRAPH_FRAGMENT_MULTIPLE),
    GRAPH_FRAGMENT_MAX_BYTES
  );
};

const NOT_FOUND_CODES = new Set(["itemNotFound"]);
// The Graph client flattens whatever an auth provider throws into a
// status-less GraphError (statusCode -1) that keeps only the error's `name`,
// as `code`, and its message. @azure/identity credentials reject with these
// names, and so does `RefreshTokenCredential` below, so they're all that marks
// a credential failure (a bad client secret, a revoked refresh token).
const AUTHENTICATION_ERROR_NAME = "AuthenticationError";
const UNAUTH_CODES = new Set([
  "unauthenticated",
  "InvalidAuthenticationToken",
  "accessDenied",
  AUTHENTICATION_ERROR_NAME,
  "AuthenticationRequiredError",
  "CredentialUnavailableError",
  "AggregateAuthenticationError",
]);
const CONFLICT_CODES = new Set(["nameAlreadyExists", "resourceModified"]);

const DEFAULT_MESSAGES: Record<ProviderFilesErrorCode, string> = {
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: "OneDrive error",
  Unauthorized: "Unauthorized",
};

const classifyGraphError = (
  status: number | undefined,
  code: string | null | undefined
): ProviderFilesErrorCode => {
  if (status === 404 || (code && NOT_FOUND_CODES.has(code))) {
    return "NotFound";
  }
  if (status === 401 || status === 403 || (code && UNAUTH_CODES.has(code))) {
    return "Unauthorized";
  }
  if (status === 409 || status === 412 || (code && CONFLICT_CODES.has(code))) {
    return "Conflict";
  }
  return "Provider";
};

// Graph error bodies nest the human message under `error`; some proxies flatten
// it to the top level. `GraphError#body` is the parsed (untyped) JSON body.
const graphBodyMessage = (body: JsonValue | undefined): string | undefined => {
  if (!isJsonObject(body)) {
    return undefined;
  }
  const nested = isJsonObject(body.error) ? body.error.message : undefined;
  const message = nested ?? body.message;
  return isString(message) ? message : undefined;
};

export const mapGraphError = (cause: unknown): FilesError => {
  if (cause instanceof FilesError) {
    return cause;
  }
  if (cause instanceof GraphError) {
    const code = classifyGraphError(cause.statusCode, cause.code);
    const innerMessage = graphBodyMessage(cause.body) ?? cause.message;
    return new FilesError(code, innerMessage || DEFAULT_MESSAGES[code], cause);
  }
  const status = ((): number | undefined => {
    if (!isObject(cause)) {
      return undefined;
    }
    if ("statusCode" in cause && isNumber(cause.statusCode)) {
      return cause.statusCode;
    }
    if ("status" in cause && isNumber(cause.status)) {
      return cause.status;
    }
    return undefined;
  })();
  const codeStr =
    isObject(cause) && "code" in cause && isString(cause.code)
      ? cause.code
      : undefined;
  const message =
    isObject(cause) && "message" in cause && isString(cause.message)
      ? cause.message
      : undefined;
  const errorCode = classifyGraphError(status, codeStr);
  return new FilesError(
    errorCode,
    message ?? DEFAULT_MESSAGES[errorCode],
    cause
  );
};

interface GraphErrorBody {
  error?: { code?: string; message?: string };
}

// Best-effort parse of a raw (unparsed) Graph error response; Graph answers
// with JSON, but a proxy or throttling layer may not.
const readGraphErrorBody = async (
  res: Response
): Promise<GraphErrorBody | null> => {
  try {
    // SAFETY: `Response#json()` is untyped; a Graph error response carries
    // the documented `{ error: { code, message } }` envelope, and every field
    // is read optional-guarded so a non-Graph JSON body degrades to no message.
    return (await res.json()) as GraphErrorBody;
  } catch {
    return null;
  }
};

const basename = (key: string): string => {
  let end = key.length;
  while (end > 0 && key[end - 1] === "/") {
    end -= 1;
  }
  const idx = key.lastIndexOf("/", end - 1);
  return key.slice(idx + 1, end);
};

const trimSlashes = (s: string): string => {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === "/") {
    start += 1;
  }
  while (end > start && s[end - 1] === "/") {
    end -= 1;
  }
  return start === 0 && end === s.length ? s : s.slice(start, end);
};

const assertNoRelativeSegments = (path: string, label: string): void => {
  if (
    trimSlashes(path)
      .split("/")
      .filter(Boolean)
      .some((segment) => segment === "." || segment === "..")
  ) {
    throw new FilesError(
      "Invalid",
      `onedrive: ${label} must not contain . or .. path segments`
    );
  }
};

const normalizeRootFolderPath = (path: string | undefined): string => {
  const normalized = trimSlashes(path ?? "");
  assertNoRelativeSegments(normalized, "rootFolderPath");
  return normalized;
};

const encodePathSegments = (path: string): string =>
  trimSlashes(path)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

// Graph lists one folder at a time, so a `list()` key prefix splits at its
// last "/": the folder it points into (`folderKey`), the child-name prefix
// matched within it, and the `keyBase` child names are joined onto to form
// full keys (`photos/` → list `photos`, keys `photos/<name>`).
const splitListPrefix = (prefix: string) => {
  const slash = prefix.lastIndexOf("/");
  return {
    folderKey: prefix.slice(0, Math.max(slash, 0)),
    keyBase: prefix.slice(0, slash + 1),
    namePrefix: prefix.slice(slash + 1),
  };
};

const GRAPH_API_VERSION_PREFIX = "/v1.0";

const throwListCursorRootMismatch = (): never => {
  throw new FilesError(
    "Invalid",
    "onedrive: list cursor does not match this adapter root"
  );
};

const normalizeListCursor = (cursor: string, expectedPath: string): string => {
  let apiPath = cursor;
  if (/^[a-z][a-z\d+.-]*:/iu.test(cursor)) {
    try {
      const url = new URL(cursor);
      if (
        url.protocol !== "https:" ||
        !url.pathname.startsWith(`${GRAPH_API_VERSION_PREFIX}/`)
      ) {
        throwListCursorRootMismatch();
      }
      apiPath = `${url.pathname.slice(GRAPH_API_VERSION_PREFIX.length)}${
        url.search
      }`;
    } catch {
      throwListCursorRootMismatch();
    }
  }

  if (!apiPath.startsWith("/")) {
    throwListCursorRootMismatch();
  }
  const queryStart = apiPath.indexOf("?");
  const pathOnly = queryStart === -1 ? apiPath : apiPath.slice(0, queryStart);
  if (pathOnly !== expectedPath) {
    throwListCursorRootMismatch();
  }
  return apiPath;
};

interface NormalizedBody {
  data: Buffer;
  contentType: string;
}

const collectStream = async (
  stream: ReadableStream<Uint8Array>
): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- stream reader: each read() pulls the next chunk sequentially
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const normalizeBody = async (
  body: Body,
  contentTypeHint?: string
): Promise<NormalizedBody> => {
  if (isString(body)) {
    return {
      contentType: contentTypeHint ?? "text/plain; charset=utf-8",
      data: Buffer.from(body, "utf-8"),
    };
  }
  if (body instanceof Uint8Array) {
    return {
      contentType: contentTypeHint ?? OCTET_STREAM,
      data: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
    };
  }
  if (body instanceof ArrayBuffer) {
    return {
      contentType: contentTypeHint ?? OCTET_STREAM,
      data: Buffer.from(body),
    };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      contentType: contentTypeHint ?? OCTET_STREAM,
      data: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
    };
  }
  if (body instanceof Blob) {
    return {
      contentType: contentTypeHint ?? (body.type || OCTET_STREAM),
      data: Buffer.from(await body.arrayBuffer()),
    };
  }
  return {
    contentType: contentTypeHint ?? OCTET_STREAM,
    data: await collectStream(body),
  };
};

// What `ResponseType.ARRAYBUFFER` hands back across runtimes: an ArrayBuffer
// in browsers/Workers, a Buffer (or other view) under Node, or — from a custom
// client — text. `toUint8` is the runtime check that the payload is one of
// these; anything else is a provider error.
type GraphContentPayload = ArrayBuffer | ArrayBufferView | string;

const toUint8 = (data: GraphContentPayload): Uint8Array => {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (isString(data)) {
    return new TextEncoder().encode(data);
  }
  throw new FilesError(
    "Provider",
    "onedrive: unexpected response payload shape"
  );
};

interface DriveItem {
  id?: string;
  name?: string;
  size?: number;
  eTag?: string;
  cTag?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  ["@microsoft.graph.downloadUrl"]?: string;
}

type ItemMeta = Omit<FileInfo, "key" | "metadata">;

// Graph collection / action response envelopes the adapter reads. Every field
// is optional because the adapter validates presence itself.
interface DriveItemCollection {
  value?: DriveItem[];
  ["@odata.nextLink"]?: string;
}

interface UploadSessionResponse {
  uploadUrl?: string;
}

interface UploadSessionStatus {
  nextExpectedRanges?: string[];
}

interface CreateLinkResponse {
  link?: { webUrl?: string };
}

interface CopyMonitorStatus {
  status?: string;
  percentageComplete?: number;
  error?: { code?: string; message?: string };
  errorCode?: string;
}

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
}

// A key names a file. The item-path GET also resolves a folder, which has no
// body to read, so report it the way a missing file is reported.
const assertNotFolder = (key: string, item: DriveItem): void => {
  if (item.folder) {
    throw new FilesError(
      "NotFound",
      `onedrive: "${key}" is a folder, not a file`
    );
  }
};

const itemToMeta = (item: DriveItem): ItemMeta => ({
  contentType: item.file?.mimeType ?? OCTET_STREAM,
  ...(item.eTag && { etag: item.eTag.replaceAll('"', "") }),
  ...(item.lastModifiedDateTime && {
    lastModified: new Date(item.lastModifiedDateTime).getTime(),
  }),
  size: Number(item.size ?? 0),
});

// A refresh-token rejection from `RefreshTokenCredential`: `Unauthorized`, and
// named like @azure/identity's own credential failures so it still classifies
// as `Unauthorized` once the Graph client has flattened it (see
// `UNAUTH_CODES`).
const credentialRejected = (message: string): FilesError => {
  const error = new FilesError("Unauthorized", message);
  error.name = AUTHENTICATION_ERROR_NAME;
  return error;
};

// Custom TokenCredential for the OAuth refresh-token flow. @azure/identity
// has no native refresh-token credential — `OnBehalfOfCredential` and the
// MSAL flows are different beasts — so we implement the spec-standard
// `grant_type=refresh_token` POST against the tenant's token endpoint and
// cache the result until just before expiry.
class RefreshTokenCredential implements TokenCredential {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #refreshToken: string;
  readonly #tenantId: string;
  #cached?: { token: string; expiresOnMs: number };

  constructor(opts: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    tenantId: string;
  }) {
    this.#clientId = opts.clientId;
    this.#clientSecret = opts.clientSecret;
    this.#refreshToken = opts.refreshToken;
    this.#tenantId = opts.tenantId;
  }

  async getToken(
    scopes: string | string[],
    _options?: GetTokenOptions
  ): Promise<AccessToken | null> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresOnMs - 60_000 > now) {
      return {
        expiresOnTimestamp: this.#cached.expiresOnMs,
        token: this.#cached.token,
      };
    }
    const scopeStr = Array.isArray(scopes) ? scopes.join(" ") : scopes;
    const body = new URLSearchParams({
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      grant_type: "refresh_token",
      refresh_token: this.#refreshToken,
      scope: scopeStr,
    });
    const url = `https://login.microsoftonline.com/${encodeURIComponent(
      this.#tenantId
    )}/oauth2/v2.0/token`;
    const res = await fetch(url, {
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    if (!res.ok) {
      // oxlint-disable-next-line github/no-then -- best-effort read: swallow the body-read error and use "" when building the failure message
      const text = await res.text().catch(() => "");
      const message = `onedrive: refresh-token exchange failed (${res.status}): ${text || res.statusText}`;
      // A throttled or failing token endpoint is transient, so it stays a
      // retryable `Provider` error; any other refusal rejects the grant.
      if (res.status === 429 || res.status >= 500) {
        throw new FilesError("Provider", message);
      }
      throw credentialRejected(message);
    }
    // SAFETY: `Response#json()` is untyped; a 2xx from the v2.0 token
    // endpoint is an OAuth 2.0 token response (`access_token`, `expires_in`),
    // and `access_token` is checked below before use.
    const json = (await res.json()) as OAuthTokenResponse;
    if (!json.access_token) {
      throw credentialRejected(
        "onedrive: refresh-token response missing access_token"
      );
    }
    const expiresOnMs = now + (json.expires_in ?? 3600) * 1000;
    this.#cached = { expiresOnMs, token: json.access_token };
    return { expiresOnTimestamp: expiresOnMs, token: json.access_token };
  }
}

const createStaticAccessTokenAuthProvider = (
  source: string | (() => string | Promise<string>)
): AuthenticationProvider => ({
  async getAccessToken(): Promise<string> {
    if (isString(source)) {
      return source;
    }
    return await source();
  },
});

const envClientCredentials = ():
  | {
      tenantId: string;
      clientId: string;
      clientSecret: string;
    }
  | undefined => {
  const tenantId = readEnv("ONEDRIVE_TENANT_ID");
  const clientId = readEnv("ONEDRIVE_CLIENT_ID");
  const clientSecret = readEnv("ONEDRIVE_CLIENT_SECRET");
  if (tenantId && clientId && clientSecret) {
    return { clientId, clientSecret, tenantId };
  }
  return undefined;
};

const hasEnvAuth = (): boolean =>
  Boolean(readEnv("ONEDRIVE_ACCESS_TOKEN")) || Boolean(envClientCredentials());

const usesClientCredentialsAuth = (opts: OneDriveAdapterOptions): boolean => {
  if (opts.client || opts.accessToken !== undefined || opts.oauth) {
    return false;
  }
  if (opts.clientCredentials) {
    return true;
  }
  if (readEnv("ONEDRIVE_ACCESS_TOKEN")) {
    return false;
  }
  return Boolean(envClientCredentials());
};

export const buildAuthProvider = (
  opts: OneDriveAdapterOptions
): AuthenticationProvider | undefined => {
  if (opts.client) {
    return undefined;
  }
  if (opts.accessToken !== undefined) {
    return createStaticAccessTokenAuthProvider(opts.accessToken);
  }
  if (opts.clientCredentials) {
    const credential = new ClientSecretCredential(
      opts.clientCredentials.tenantId,
      opts.clientCredentials.clientId,
      opts.clientCredentials.clientSecret
    );
    return new TokenCredentialAuthenticationProvider(credential, {
      scopes: [GRAPH_DEFAULT_SCOPE],
    });
  }
  if (opts.oauth) {
    const credential = new RefreshTokenCredential({
      clientId: opts.oauth.clientId,
      clientSecret: opts.oauth.clientSecret,
      refreshToken: opts.oauth.refreshToken,
      tenantId: opts.oauth.tenantId ?? "common",
    });
    return new TokenCredentialAuthenticationProvider(credential, {
      scopes: [GRAPH_DEFAULT_SCOPE],
    });
  }
  const envAccessToken = readEnv("ONEDRIVE_ACCESS_TOKEN");
  if (envAccessToken) {
    return createStaticAccessTokenAuthProvider(envAccessToken);
  }
  const envCreds = envClientCredentials();
  if (envCreds) {
    const credential = new ClientSecretCredential(
      envCreds.tenantId,
      envCreds.clientId,
      envCreds.clientSecret
    );
    return new TokenCredentialAuthenticationProvider(credential, {
      scopes: [GRAPH_DEFAULT_SCOPE],
    });
  }
  return undefined;
};

const resolveBasePath = (opts: OneDriveAdapterOptions): string => {
  // An explicit target wins outright: env targets are only read when no
  // option names one, so e.g. an explicit `driveId` (which `sharepoint()`
  // always passes) isn't rejected over an unrelated ONEDRIVE_SITE_ID.
  const hasExplicitTarget = [opts.driveId, opts.siteId, opts.userId].some(
    (t) => isString(t) && t.length > 0
  );
  const source = hasExplicitTarget
    ? opts
    : {
        driveId: readEnv("ONEDRIVE_DRIVE_ID"),
        siteId: readEnv("ONEDRIVE_SITE_ID"),
        userId: readEnv("ONEDRIVE_USER_ID"),
      };
  const { driveId, siteId, userId } = source;
  const targets = [driveId, siteId, userId].filter(
    (t): t is string => isString(t) && t.length > 0
  );
  if (targets.length > 1) {
    throw new FilesError(
      "Invalid",
      "onedrive: pass at most one of `driveId`, `siteId`, `userId`."
    );
  }
  if (driveId) {
    return `/drives/${encodeURIComponent(driveId)}`;
  }
  if (siteId) {
    return `/sites/${encodeURIComponent(siteId)}/drive`;
  }
  if (userId) {
    return `/users/${encodeURIComponent(userId)}/drive`;
  }
  if (usesClientCredentialsAuth(opts)) {
    throw new FilesError(
      "Invalid",
      "onedrive: clientCredentials auth requires `driveId`, `siteId`, or `userId` — `/me/drive` is not available without an interactive user."
    );
  }
  return "/me/drive";
};

export const onedrive = (
  opts: OneDriveAdapterOptions = {}
): OneDriveAdapter => {
  const explicitAuthOptions = [
    opts.clientCredentials,
    opts.oauth,
    opts.accessToken,
    opts.client,
  ].filter((v) => v !== undefined && v !== null);
  if (explicitAuthOptions.length === 0 && !hasEnvAuth()) {
    throw new FilesError(
      "Invalid",
      "onedrive adapter: missing auth. Pass `clientCredentials`, `oauth`, `accessToken`, or `client`. Env fallbacks: ONEDRIVE_ACCESS_TOKEN, or ONEDRIVE_TENANT_ID + ONEDRIVE_CLIENT_ID + ONEDRIVE_CLIENT_SECRET."
    );
  }
  if (explicitAuthOptions.length > 1) {
    throw new FilesError(
      "Invalid",
      "onedrive adapter: pass exactly one of `clientCredentials`, `oauth`, `accessToken`, or `client`."
    );
  }

  const basePath = resolveBasePath(opts);
  const rootFolderPath = normalizeRootFolderPath(opts.rootFolderPath);
  const publicByDefault = opts.publicByDefault ?? false;
  const copyTimeoutMs = opts.copyTimeoutMs ?? DEFAULT_COPY_TIMEOUT_MS;

  let client: Client;
  if (opts.client) {
    ({ client } = opts);
  } else {
    const authProvider = buildAuthProvider(opts);
    if (!authProvider) {
      // Unreachable — explicit auth shape count guarantees one branch matched.
      throw new FilesError("Invalid", "onedrive: failed to build auth");
    }
    const clientOpts: ClientOptions = { authProvider };
    client = Client.initWithMiddleware(clientOpts);
  }

  const itemApiPath = (key: string): string => {
    // An empty key (or "/") maps to the adapter root and a trailing "/" names
    // a folder; Graph DELETE and copy act on a whole folder tree, so neither
    // shape reaches an object verb.
    if (!trimSlashes(key) || key.endsWith("/")) {
      throw new FilesError(
        "Invalid",
        `onedrive: key must name a file, not the root or a folder: ${JSON.stringify(key)}`
      );
    }
    assertNoRelativeSegments(key, "key");
    const fullPath = rootFolderPath
      ? `${rootFolderPath}/${trimSlashes(key)}`
      : trimSlashes(key);
    const encoded = encodePathSegments(fullPath);
    return `${basePath}/root:/${encoded}:`;
  };

  const containerApiPath = (): string => {
    if (!rootFolderPath) {
      return `${basePath}/root`;
    }
    const encoded = encodePathSegments(rootFolderPath);
    return `${basePath}/root:/${encoded}:`;
  };

  // The folder a `list()` reads: the root, or the key folder `folderKey`
  // (a key prefix up to its last "/") beneath it.
  const folderApiPath = (folderKey: string): string => {
    const trimmed = trimSlashes(folderKey);
    if (!trimmed) {
      return containerApiPath();
    }
    assertNoRelativeSegments(trimmed, "prefix");
    const fullPath = rootFolderPath ? `${rootFolderPath}/${trimmed}` : trimmed;
    return `${basePath}/root:/${encodePathSegments(fullPath)}:`;
  };

  // The driveItem at `key`, or `undefined` when nothing is there.
  const findItem = async (key: string): Promise<DriveItem | undefined> => {
    try {
      // SAFETY: the Graph client types every parsed response as `any`; a GET
      // on the item path returns a `driveItem`.
      return (await client.api(itemApiPath(key)).get()) as DriveItem;
    } catch (error) {
      if (mapGraphError(error).code === "NotFound") {
        return undefined;
      }
      throw error;
    }
  };

  // Address an item by id where Graph gave one, so a mutation hits exactly the
  // item that was inspected — never a folder that has since landed on the path.
  const itemByIdPath = (key: string, item: DriveItem): string =>
    item.id
      ? `${basePath}/items/${encodeURIComponent(item.id)}`
      : itemApiPath(key);

  const pollCopyMonitor = async (monitorUrl: string): Promise<void> => {
    const start = Date.now();
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- copy-status polling: each poll must observe the prior response before deciding to poll again
      const res = await fetch(monitorUrl);
      if (!res.ok && res.status !== 202) {
        // oxlint-disable-next-line eslint/no-await-in-loop, github/no-then -- reading the error body of the current poll response; catch yields "" so the error is intentionally swallowed
        const text = await res.text().catch(() => "");
        throw new FilesError(
          "Provider",
          `onedrive: copy monitor failed (${res.status}): ${text || res.statusText}`
        );
      }
      // SAFETY: `Response#json()` is untyped; the copy monitor URL returns a
      // Graph `asyncJobStatus` resource (`status`, `percentageComplete`,
      // `error`), and the `{}` parse fallback fits the same all-optional shape.
      // oxlint-disable-next-line eslint/no-await-in-loop, github/no-then -- parsing the current poll response body; catch yields {} so the parse error is intentionally swallowed
      const json = (await res.json().catch(() => ({}))) as CopyMonitorStatus;
      if (json.status === "completed") {
        return;
      }
      if (json.status === "failed") {
        // Classify the job's own error code like a synchronous Graph error
        // (`nameAlreadyExists` → Conflict, `itemNotFound` → NotFound, …).
        throw new FilesError(
          classifyGraphError(undefined, json.error?.code ?? json.errorCode),
          json.error?.message ?? "onedrive: copy operation failed"
        );
      }
      if (Date.now() - start > copyTimeoutMs) {
        // Permanent: Graph accepted the copy and may still finish it, so a
        // retry would start a second copy job rather than resume this one.
        throw new FilesError(
          "Provider",
          `onedrive: copy operation did not finish within ${copyTimeoutMs}ms; it may still complete server-side, so check the destination before retrying`,
          undefined,
          { permanent: true }
        );
      }
      // eslint-disable-next-line no-await-in-loop -- backoff between sequential status polls
      await delay(COPY_POLL_INTERVAL_MS);
    }
  };

  // Large files (and any `multipart` upload) go through a Graph upload session:
  // create the session, then PUT the buffered body in `Content-Range` chunks.
  // The session `uploadUrl` is pre-authenticated, so the chunk PUTs use plain
  // fetch. The final chunk's 200/201 response carries the created DriveItem.
  const uploadViaSession = async (
    key: string,
    data: Buffer,
    rangeSize: number,
    signal?: AbortSignal
  ): Promise<DriveItem> => {
    // SAFETY: the Graph client types every parsed response as `any`;
    // `createUploadSession` returns an `uploadSession` resource whose
    // `uploadUrl` is checked below before use.
    const session = (await client
      .api(`${itemApiPath(key)}/createUploadSession`)
      .post({
        item: {
          "@microsoft.graph.conflictBehavior": "replace",
          name: basename(key),
        },
      })) as UploadSessionResponse;
    const { uploadUrl } = session;
    if (!uploadUrl) {
      throw new FilesError("Provider", MISSING_UPLOAD_URL_MESSAGE);
    }
    const total = data.byteLength;
    let offset = 0;
    let item: DriveItem | undefined;
    while (offset < total) {
      const end = Math.min(offset + rangeSize, total);
      const chunk = data.subarray(offset, end);
      // SAFETY: a Node Buffer is a valid fetch body at runtime (undici); only
      // its generic `ArrayBufferLike` backing keeps it out of the DOM
      // `BodyInit` union.
      // eslint-disable-next-line no-await-in-loop -- chunked upload session: each Content-Range PUT depends on the prior chunk's offset
      const res = await fetch(uploadUrl, {
        body: chunk as BodyInit,
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${total}` },
        method: "PUT",
        ...(signal && { signal }),
      });
      if (!res.ok) {
        // oxlint-disable-next-line eslint/no-await-in-loop, github/no-then -- reading the error body of the current chunk PUT; catch yields "" so the error is intentionally swallowed
        const text = await res.text().catch(() => "");
        throw new FilesError(
          "Provider",
          `onedrive: upload session chunk failed (${res.status}): ${text || res.statusText}`
        );
      }
      // 202 = accepted, more chunks expected; 200/201 = final chunk, body is
      // the DriveItem. Read it on completion and ignore the interim ranges.
      if (res.status === 200 || res.status === 201) {
        // SAFETY: `Response#json()` is untyped; Graph documents the final
        // fragment's 200/201 body as the created `driveItem`.
        // eslint-disable-next-line no-await-in-loop -- reading the DriveItem from the final chunk's response
        item = (await res.json()) as DriveItem;
      }
      offset = end;
    }
    if (!item) {
      throw new FilesError(
        "Provider",
        "onedrive: upload session completed without returning a drive item"
      );
    }
    return item;
  };

  // Pause-able / resumable upload over the same Graph upload session as
  // `uploadViaSession`, but driven chunk-by-chunk by the orchestrator. The
  // session `uploadUrl` is the resumable token; `GET`ting it reports
  // `nextExpectedRanges` for resume, and `DELETE`ing it discards the session.
  const createResumableDriver = (
    key: string,
    resumableOpts: ResumableDriverOptions
  ): OffsetResumableDriver => {
    const partSize = resolveRangeSize(resumableOpts.multipart);
    let uploadUrl: string | undefined;
    let contentType: string | undefined;
    let finalItem: DriveItem | undefined;
    // Calling the driver out of order is a caller bug, not a provider
    // failure — it fails the same way on every attempt.
    const requireUrl = (): string => {
      if (!uploadUrl) {
        throw new FilesError(
          "Invalid",
          "onedrive: upload session not started."
        );
      }
      return uploadUrl;
    };
    const result = (item: DriveItem): UploadResult => ({
      contentType: item.file?.mimeType ?? OCTET_STREAM,
      ...(item.eTag && { etag: item.eTag.replaceAll('"', "") }),
      key,
      ...(item.lastModifiedDateTime && {
        lastModified: new Date(item.lastModifiedDateTime).getTime(),
      }),
      size: Number(item.size ?? 0),
    });
    return {
      adopt(session: ResumableUploadSession) {
        if (session.provider !== "onedrive") {
          throw new FilesError(
            "Invalid",
            `Cannot resume a ${session.provider} session on a OneDrive adapter.`
          );
        }
        if (session.itemPath !== key) {
          throw new FilesError(
            "Invalid",
            "Resume token does not match this upload's item path."
          );
        }
        uploadUrl = trustedHttpsSessionUrl(
          session.uploadUrl,
          "onedrive upload session URL",
          ["up.1drv.com", "up.1drv.ms", "sharepoint.com"]
        );
      },
      async begin(meta): Promise<ResumableUploadSession> {
        // `metadata` / `cacheControl` are rejected centrally by the Files
        // wrapper before a resumable upload ever reaches here.
        ({ contentType } = meta);
        try {
          // SAFETY: the Graph client types every parsed response as `any`;
          // `createUploadSession` returns an `uploadSession` resource whose
          // `uploadUrl` is checked below before use.
          const { uploadUrl: created } = (await client
            .api(`${itemApiPath(key)}/createUploadSession`)
            .post({
              item: {
                "@microsoft.graph.conflictBehavior": "replace",
                name: basename(key),
              },
            })) as UploadSessionResponse;
          if (!created) {
            throw new FilesError("Provider", MISSING_UPLOAD_URL_MESSAGE);
          }
          uploadUrl = trustedHttpsSessionUrl(
            created,
            "onedrive upload session URL",
            ["up.1drv.com", "up.1drv.ms", "sharepoint.com"]
          );
          return { itemPath: key, provider: "onedrive", uploadUrl };
        } catch (error) {
          throw mapGraphError(error);
        }
      },
      complete(): Promise<UploadResult> {
        if (!finalItem) {
          throw new FilesError(
            "Provider",
            "onedrive: upload session completed without returning a drive item"
          );
        }
        return Promise.resolve(result(finalItem));
      },
      async discard() {
        if (!uploadUrl) {
          return;
        }
        try {
          // A refused cancel (401/403, 5xx) leaves the session live, so it
          // throws; 2xx or an already-gone 404/410 is success.
          assertSessionDiscarded(
            await fetch(uploadUrl, { method: "DELETE" }),
            "onedrive: upload session cancel failed"
          );
        } catch (error) {
          throw mapGraphError(error);
        }
      },
      mode: "offset",
      partSize,
      async probe(): Promise<{ nextOffset: number }> {
        try {
          const res = await fetch(requireUrl(), { method: "GET" });
          if (!res.ok) {
            throw new FilesError(
              "Provider",
              `onedrive: resume status check failed (${res.status})`
            );
          }
          // SAFETY: `Response#json()` is untyped; a GET on the upload session
          // URL returns an `uploadSession` resource whose `nextExpectedRanges`
          // is a list of "start-end" strings (read optional-guarded).
          const body = (await res.json()) as UploadSessionStatus;
          const first = body.nextExpectedRanges?.[0];
          return { nextOffset: first ? Number(first.split("-")[0]) : 0 };
        } catch (error) {
          throw mapGraphError(error);
        }
      },
      async uploadAt({ offset, data, total, signal }): Promise<{
        nextOffset: number;
      }> {
        try {
          if (data.byteLength === 0) {
            // An upload session needs at least one byte (`bytes 0--1/0` is
            // not a valid range), so an empty body takes the simple PUT —
            // the same path `upload()` uses for 0-byte bodies — and the
            // unused session is dropped.
            const req = client.api(`${itemApiPath(key)}/content`);
            const typed = contentType
              ? req.header("Content-Type", contentType)
              : req;
            // SAFETY: the Graph client types every parsed response as
            // `any`; a PUT to `/content` returns the created or updated
            // `driveItem`.
            finalItem = (await typed.put(Buffer.alloc(0))) as DriveItem;
            if (uploadUrl) {
              try {
                await fetch(uploadUrl, { method: "DELETE" });
              } catch {
                // Best effort: an unused session expires on its own.
              }
            }
            return { nextOffset: 0 };
          }
          const end = offset + data.byteLength;
          // SAFETY: a `Uint8Array` is a valid fetch body at runtime; only its
          // generic `ArrayBufferLike` backing keeps it out of the DOM `BodyInit`
          // union.
          const res = await fetch(requireUrl(), {
            body: data as BodyInit,
            headers: { "Content-Range": `bytes ${offset}-${end - 1}/${total}` },
            method: "PUT",
            ...(signal && { signal }),
          });
          if (!res.ok) {
            // oxlint-disable-next-line github/no-then -- best-effort read: swallow the body-read error and use "" when building the failure message
            const text = await res.text().catch(() => "");
            throw new FilesError(
              "Provider",
              `onedrive: upload session chunk failed (${res.status}): ${text || res.statusText}`
            );
          }
          if (res.status === 200 || res.status === 201) {
            // SAFETY: `Response#json()` is untyped; Graph documents the final
            // fragment's 200/201 body as the created `driveItem`.
            finalItem = (await res.json()) as DriveItem;
          }
          return { nextOffset: end };
        } catch (error) {
          throw mapGraphError(error);
        }
      },
    };
  };

  const createAnonymousLink = async (key: string): Promise<string> => {
    // SAFETY: the Graph client types every parsed response as `any`;
    // `createLink` returns a `permission` resource whose `link.webUrl` is
    // checked below before use.
    const res = (await client
      .api(`${itemApiPath(key)}/createLink`)
      .post({ scope: "anonymous", type: "view" })) as CreateLinkResponse;
    const url = res.link?.webUrl;
    if (!url) {
      throw new FilesError(
        "Provider",
        "onedrive: createLink response missing link.webUrl"
      );
    }
    return url;
  };

  return {
    basePath,
    capabilities: {
      delimiter: "slash",
      // Under `publicByDefault`, `url(key)` returns the item's anonymous
      // (permanent) share link.
      publicUrl: publicByDefault,
      rangeRead: true,
      // `copy()` is a server-side Graph `/copy`.
      serverSideCopy: true,
      // `signedUploadUrl()` mints a Graph upload session, which binds neither
      // a size limit nor a Content-Type — it throws when asked for either.
      signedUpload: { contentType: false, maxSize: false, supported: true },
      // Graph has no signed-URL primitive: `url()` throws unless built with
      // `publicByDefault`, and even then returns an anonymous (permanent) link.
      signedUrl: { supported: false },
    },
    async copy(from, to) {
      try {
        const [source, destination] = await Promise.all([
          findItem(from),
          findItem(to),
        ]);
        // Graph copies a folder's whole tree; a folder is not an object here
        // (`head` reports it as NotFound), so neither is its copy.
        if (!source || source.folder) {
          throw new FilesError(
            "NotFound",
            `onedrive: no file at ${JSON.stringify(from)}`
          );
        }
        // `replace` onto a folder would swap the whole folder for one file.
        if (destination?.folder) {
          throw new FilesError(
            "Conflict",
            `onedrive: ${JSON.stringify(to)} is a folder; refusing to replace it with a file`
          );
        }
        // Graph paths are case-insensitive: replacing "the destination" here
        // would replace the source itself.
        if (destination?.id !== undefined && destination.id === source.id) {
          throw new FilesError(
            "Conflict",
            `onedrive: ${JSON.stringify(from)} and ${JSON.stringify(to)} are the same item`
          );
        }
        // Resolve destination parent folder. For nested keys we copy to the
        // root and let `requestBody.parentReference.path` handle the rest.
        const destDir = (() => {
          const trimmedTo = trimSlashes(to);
          const idx = trimmedTo.lastIndexOf("/");
          return idx === -1 ? "" : trimmedTo.slice(0, idx);
        })();
        const fullDestDir = ((): string => {
          if (!rootFolderPath) {
            return destDir;
          }
          if (!destDir) {
            return rootFolderPath;
          }
          return `${rootFolderPath}/${destDir}`;
        })();
        const parentRef = fullDestDir
          ? { path: `/drive/root:/${encodePathSegments(fullDestDir)}` }
          : { path: "/drive/root:" };
        const runCopy = async (): Promise<void> => {
          // SAFETY: with `ResponseType.RAW` the Graph client resolves with the
          // underlying fetch `Response` itself instead of a parsed body.
          const res = (await client
            .api(`${itemApiPath(from)}/copy`)
            // Overwrite an existing destination file, like every other
            // adapter's copy (Graph's default is to fail on a name clash).
            .query({ "@microsoft.graph.conflictBehavior": "replace" })
            .responseType(ResponseType.RAW)
            .post({
              name: basename(to),
              parentReference: parentRef,
            })) as Response;
          // `ResponseType.RAW` hands back the fetch Response as-is — the Graph
          // client only turns non-2xx responses into GraphErrors for the
          // parsed response types — so classify the failure here (404 →
          // NotFound, 409 → Conflict, …) instead of a generic provider error.
          if (!res.ok) {
            const errorBody = await readGraphErrorBody(res);
            const code = classifyGraphError(res.status, errorBody?.error?.code);
            throw new FilesError(
              code,
              errorBody?.error?.message ??
                `onedrive: copy returned ${res.status}`
            );
          }
          // Graph returns 202 + Location header pointing to a monitor URL.
          // Some configurations return 200 with the new item directly — treat
          // a 2xx without one as success.
          const monitorUrl =
            res.headers.get("location") ?? res.headers.get("Location");
          if (!monitorUrl) {
            return;
          }
          await pollCopyMonitor(monitorUrl);
        };
        try {
          await runCopy();
        } catch (error) {
          // OneDrive personal ignores `conflictBehavior` on copy, so a file
          // at the destination still fails it with a name clash there.
          // Replace it the way the business service does: delete it (to the
          // recycle bin, by id — never by a path that could be the source's
          // other casing), then copy again.
          if (
            destination?.id === undefined ||
            mapGraphError(error).code !== "Conflict"
          ) {
            throw error;
          }
          await client.api(itemByIdPath(to, destination)).delete();
          await runCopy();
        }
      } catch (error) {
        throw mapGraphError(error);
      }
    },
    async delete(key) {
      try {
        const item = await findItem(key);
        // Graph DELETE on a folder removes everything under it. A folder is
        // not an object (`head` reports it as NotFound), so deleting its key
        // is the same no-op as deleting a missing one.
        if (!item || item.folder) {
          return;
        }
        await client.api(itemByIdPath(key, item)).delete();
      } catch (error) {
        const mapped = mapGraphError(error);
        // Idempotent: missing item is not an error.
        if (mapped.code === "NotFound") {
          return;
        }
        throw mapped;
      }
    },
    async download(key, downloadOpts) {
      try {
        const range = downloadOpts?.range;
        // Graph's /content endpoint honors a Range header; add it when asked.
        const contentReq = () => {
          const req = client.api(`${itemApiPath(key)}/content`);
          return range ? req.header("Range", httpRangeHeader(range)) : req;
        };
        if (downloadOpts?.as === "stream") {
          // SAFETY: the Graph client types every response as `any`. A GET on
          // the item path returns a `driveItem`; `ResponseType.STREAM` yields
          // the fetch Response body — a web ReadableStream in every runtime the
          // Graph client runs on — or a Node Readable from a custom client.
          const [meta, stream] = await Promise.all([
            client.api(itemApiPath(key)).get() as Promise<DriveItem>,
            contentReq().responseType(ResponseType.STREAM).get() as Promise<
              Readable | ReadableStream<Uint8Array>
            >,
          ]);
          const m = itemToMeta(meta);
          return createStoredFile(
            { key, ...m, ...(range && { size: rangedSize(m.size, range) }) },
            {
              // Only a custom client that hands back a Node Readable needs
              // converting; `Readable.toWeb` throws on a web stream.
              factory: () => {
                if (stream instanceof Readable) {
                  return toWebStream(stream);
                }
                return stream;
              },
              kind: "stream",
            }
          );
        }
        // SAFETY: the Graph client types every response as `any`. A GET on the
        // item path returns a `driveItem`; `ResponseType.ARRAYBUFFER` yields a
        // binary payload that `toUint8` checks at runtime.
        const [meta, bytes] = await Promise.all([
          client.api(itemApiPath(key)).get() as Promise<DriveItem>,
          contentReq()
            .responseType(ResponseType.ARRAYBUFFER)
            .get() as Promise<GraphContentPayload>,
        ]);
        const m = itemToMeta(meta);
        const u8 = toUint8(bytes);
        return createStoredFile(
          { key, ...m, size: u8.byteLength },
          { data: u8, kind: "buffer" }
        );
      } catch (error) {
        throw mapGraphError(error);
      }
    },
    exists(key) {
      return existsByProbe(async () => {
        // SAFETY: the Graph client types every parsed response as `any`; a
        // GET on the item path returns a `driveItem`.
        const item = (await client.api(itemApiPath(key)).get()) as DriveItem;
        assertNotFolder(key, item);
      }, mapGraphError);
    },
    async head(key) {
      try {
        // SAFETY: the Graph client types every parsed response as `any`; a
        // GET on the item path returns a `driveItem`.
        const meta = (await client.api(itemApiPath(key)).get()) as DriveItem;
        assertNotFolder(key, meta);
        return { key, ...itemToMeta(meta) };
      } catch (error) {
        throw mapGraphError(error);
      }
    },
    async list(options): Promise<ListResult> {
      const folded = options?.delimiter !== undefined;
      if (options?.delimiter) {
        assertSlashDelimiter("onedrive", options.delimiter);
      }
      // List the folder the key prefix points into and match the rest
      // against the children's names, so `photos/` lists the `photos`
      // folder and child keys come back in full (`photos/cover.jpg`).
      const { folderKey, keyBase, namePrefix } = splitListPrefix(
        options?.prefix ?? ""
      );
      try {
        const listPath = `${folderApiPath(folderKey)}/children`;
        const initial = options?.cursor
          ? normalizeListCursor(options.cursor, listPath)
          : listPath;
        let req = client.api(initial);
        if (!options?.cursor && options?.limit !== undefined) {
          req = req.top(options.limit);
        }
        // SAFETY: the Graph client types every parsed response as `any`;
        // `/children` (and its `@odata.nextLink` continuation) returns a
        // `driveItem` collection page.
        const res = (await req.get()) as DriveItemCollection;
        const items: FileInfo[] = [];
        const prefixes: string[] = [];
        // Classify one child into items (files) or prefixes (folders, folded
        // mode only); nested so the loop's branching stays out of `list`.
        const collect = (item: DriveItem) => {
          const name = item.name ?? "";
          if (!name.startsWith(namePrefix)) {
            return;
          }
          const key = `${keyBase}${name}`;
          if (item.folder) {
            if (folded && name) {
              prefixes.push(`${key}/`);
            }
            return;
          }
          items.push({ key, ...itemToMeta(item) });
        };
        for (const item of res.value ?? []) {
          collect(item);
        }
        const cursor = res["@odata.nextLink"];
        return {
          items,
          ...(cursor && { cursor }),
          ...(prefixes.length && { prefixes }),
        };
      } catch (error) {
        const mapped = mapGraphError(error);
        // A prefix into a folder that doesn't exist lists nothing.
        if (trimSlashes(folderKey) && mapped.code === "NotFound") {
          return { items: [] };
        }
        throw mapped;
      }
    },
    name: "onedrive",
    raw: client,
    resumableUpload: createResumableDriver,
    rootFolderPath,
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      if (signOpts.maxSize !== undefined || signOpts.minSize !== undefined) {
        throw new FilesError(
          "Unsupported",
          "onedrive: `maxSize` and `minSize` are not supported for signed upload URLs. Graph upload sessions do not enforce a server-side content-length-range policy; enforce size limits at your application gateway / proxy before issuing the session URL."
        );
      }
      if (signOpts.contentType !== undefined) {
        throw new FilesError(
          "Unsupported",
          "onedrive: `contentType` is not supported for signed upload URLs. A Graph upload session doesn't bind a Content-Type (Graph infers the file's type from its name), so a Content-Type header would only be advisory; omit `contentType`, or validate it at your application gateway / proxy before issuing the session URL."
        );
      }
      try {
        // SAFETY: the Graph client types every parsed response as `any`;
        // `createUploadSession` returns an `uploadSession` resource whose
        // `uploadUrl` is checked below before use.
        const res = (await client
          .api(`${itemApiPath(key)}/createUploadSession`)
          .post({
            item: {
              "@microsoft.graph.conflictBehavior": "replace",
              name: basename(key),
            },
          })) as UploadSessionResponse;
        const { uploadUrl } = res;
        if (!uploadUrl) {
          throw new FilesError("Provider", MISSING_UPLOAD_URL_MESSAGE);
        }
        // The session URL is a Graph upload session, not a plain presigned
        // PUT: every PUT must carry `Content-Range: bytes 0-{n-1}/{n}` (the
        // client knows `n`; we don't, so no header is minted here), and one
        // request tops out below 60 MiB — larger files need the client to
        // PUT 320 KiB-multiple fragments against the same URL.
        return { method: "PUT", url: uploadUrl };
      } catch (error) {
        throw mapGraphError(error);
      }
    },
    async upload(key, body, options): Promise<UploadResult> {
      // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
      // (this adapter advertises neither) — Graph drive items have no native
      // arbitrary-metadata or cache-header field.
      try {
        const normalized = await normalizeBody(body, options?.contentType);
        const total = normalized.data.byteLength;
        const wantsMultipart =
          options?.multipart !== undefined && options.multipart !== false;
        // Use a chunked upload session above Graph's simple-upload limit, or
        // whenever the caller forces multipart on a non-empty body. A 0-byte
        // body always takes the simple PUT (sessions need at least one chunk).
        const useSession =
          total > SIMPLE_UPLOAD_LIMIT_BYTES || (wantsMultipart && total > 0);
        // SAFETY: the Graph client types every parsed response as `any`; a
        // PUT to `/content` returns the created or updated `driveItem`.
        const item: DriveItem = useSession
          ? await uploadViaSession(
              key,
              normalized.data,
              resolveRangeSize(options?.multipart),
              options?.signal
            )
          : ((await client
              .api(`${itemApiPath(key)}/content`)
              .header("Content-Type", normalized.contentType)
              .put(normalized.data)) as DriveItem);
        if (publicByDefault) {
          // createLink is idempotent for the same scope+type — repeat calls
          // return the existing link rather than creating duplicates.
          await createAnonymousLink(key);
        }
        return {
          contentType: normalized.contentType,
          ...(item.eTag && { etag: item.eTag.replaceAll('"', "") }),
          key,
          ...(item.lastModifiedDateTime && {
            lastModified: new Date(item.lastModifiedDateTime).getTime(),
          }),
          size: total,
        };
      } catch (error) {
        throw mapGraphError(error);
      }
    },
    async url(key, urlOpts) {
      if (urlOpts?.responseContentDisposition) {
        throw dispositionUnsupported(
          "onedrive: `responseContentDisposition` is not supported. Graph has no Content-Disposition override for share links or downloadUrl."
        );
      }
      if (!publicByDefault) {
        throw new FilesError(
          "Unsupported",
          "onedrive: url() requires the adapter to be constructed with `publicByDefault: true`. Graph has no signed URL primitive — use download() for private files."
        );
      }
      try {
        return await createAnonymousLink(key);
      } catch (error) {
        throw mapGraphError(error);
      }
    },
  };
};
