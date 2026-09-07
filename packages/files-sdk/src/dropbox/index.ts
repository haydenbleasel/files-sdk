import { Buffer } from "node:buffer";

import { Dropbox, DropboxAuth, DropboxResponseError } from "dropbox";
import type { DropboxFileBinary, DropboxFileBlob, files } from "dropbox";

import type {
  Adapter,
  Body,
  ListResult,
  MultipartOptions,
  OffsetResumableDriver,
  ResumableDriverOptions,
  ResumableUploadSession,
  SignedUpload,
  StoredFile,
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
import { FilesError } from "../internal/errors.js";
import type { ProviderFilesErrorCode } from "../internal/errors.js";
import { isNumber, isObject, isString } from "../internal/is.js";
import { isJsonObject } from "../internal/json.js";
import type { JsonValue } from "../internal/json.js";
import { inferTypeFromName } from "../internal/mime.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface DropboxAdapterOptions {
  /**
   * Logical "bucket root" — virtual keys live under this folder path on the
   * Dropbox account. Must already exist; the adapter does not create folders.
   * Path is normalized: leading slash is added, trailing slashes stripped.
   * Defaults to the account root.
   */
  rootFolderPath?: string;
  /**
   * When `true`, `upload()` also creates a public shared link (anyone with
   * the link can view) and `url()` returns that link's `url` (rewritten to
   * `?dl=1` for direct download). When `false` (default), `url()` mints a
   * 4-hour temporary link via `filesGetTemporaryLink`.
   *
   * **Plan policy note:** public shared links may be restricted on Dropbox
   * Business teams; the adapter surfaces Dropbox's `access_denied` error
   * unmodified in that case.
   */
  publicByDefault?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips both signing and shared-link creation.
   * Useful when a CDN sits in front of pre-shared Dropbox links.
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the temporary download links returned by
   * `url()` when neither `publicByDefault` nor `publicBaseUrl` is set.
   * **Validated only**: `filesGetTemporaryLink` takes no expiry parameter, so
   * every link actually lives ~4 hours (14400s, the Dropbox fixed lifetime)
   * regardless of what's requested — values above 14400 throw, values below
   * are accepted but the link still outlives them. Don't rely on a short
   * `expiresIn` as a security control with this adapter. Defaults to 3600.
   */
  defaultUrlExpiresIn?: number;
  /**
   * Pre-built `Dropbox` client — escape hatch for callers that already wire
   * auth themselves (e.g. with team-space `pathRoot`, custom headers, or
   * shared `DropboxAuth`).
   */
  client?: Dropbox;
  /**
   * Static or dynamic access token. Pass a string for a one-shot token, or
   * a function returning a fresh token on each call. The adapter does not
   * cache the result of a callable — your callable is responsible for
   * caching/refresh.
   */
  accessToken?: string | (() => string | Promise<string>);
  /**
   * OAuth2 refresh-token flow. Tokens are exchanged at
   * `https://api.dropboxapi.com/oauth2/token` and cached until ~60s before
   * expiry. `appSecret` is required for confidential clients (server-side
   * apps); PKCE-only public clients should pass `appKey` alone.
   */
  refreshToken?: string;
  /** Dropbox app key (client_id). Required when `refreshToken` is set. */
  appKey?: string;
  /** Dropbox app secret (client_secret). Required for confidential clients. */
  appSecret?: string;
}

export type DropboxClient = Dropbox;
export type DropboxAdapter = Adapter<DropboxClient> & {
  readonly rootFolderPath: string;
};

const MAX_TEMPORARY_LINK_DURATION = 14_400;
const OCTET_STREAM = "application/octet-stream";
const REFRESH_LEEWAY_MS = 60_000;
const SIMPLE_UPLOAD_LIMIT_BYTES = 150 * 1024 * 1024;
const UPLOAD_SESSION_CHUNK_BYTES = 8 * 1024 * 1024;
// Dropbox requires every non-final session chunk to be a multiple of 4 MiB.
const UPLOAD_SESSION_CHUNK_MULTIPLE = 4 * 1024 * 1024;

/**
 * Resolve the session chunk size from `multipart.partSize`, rounded down to a
 * 4 MiB multiple (Dropbox's requirement) and never below one unit. Defaults to
 * 8 MiB when no `partSize` is given. Capped at Dropbox's per-request limit
 * (150 MB, itself rounded down to a 4 MiB multiple) so an oversized
 * `partSize` can't produce a session append the API rejects.
 */
const resolveChunkBytes = (
  multipart: boolean | MultipartOptions | undefined
): number => {
  const partSize = isObject(multipart) ? multipart.partSize : undefined;
  if (partSize === undefined) {
    return UPLOAD_SESSION_CHUNK_BYTES;
  }
  const capped = Math.min(partSize, SIMPLE_UPLOAD_LIMIT_BYTES);
  const rounded =
    Math.floor(capped / UPLOAD_SESSION_CHUNK_MULTIPLE) *
    UPLOAD_SESSION_CHUNK_MULTIPLE;
  return Math.max(rounded, UPLOAD_SESSION_CHUNK_MULTIPLE);
};

/**
 * Pull fixed-size chunks from a web `ReadableStream`, coalescing the stream's
 * arbitrary-sized reads. `next()` returns exactly `chunkBytes` until the stream
 * is exhausted, then the final (smaller) remainder, then `null`. Peak memory is
 * ~one chunk, so large streams upload without buffering the whole body.
 */
const makeStreamChunker = (
  stream: ReadableStream<Uint8Array>,
  chunkBytes: number
) => {
  const reader = stream.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let done = false;

  const fill = async (): Promise<void> => {
    while (pendingBytes < chunkBytes && !done) {
      // eslint-disable-next-line no-await-in-loop -- stream reader: each read() pulls the next chunk sequentially until the target size is buffered
      const { value, done: d } = await reader.read();
      if (d) {
        done = true;
        break;
      }
      if (value && value.byteLength > 0) {
        pending.push(value);
        pendingBytes += value.byteLength;
      }
    }
  };

  const take = (): Buffer | null => {
    if (pendingBytes === 0) {
      return null;
    }
    const want = Math.min(chunkBytes, pendingBytes);
    const out = Buffer.allocUnsafe(want);
    let filled = 0;
    while (filled < want) {
      // SAFETY: `want <= pendingBytes`, the sum of the queued chunks' sizes, so
      // while `filled < want` at least one chunk is still queued.
      const head = pending[0] as Uint8Array;
      const need = want - filled;
      if (head.byteLength <= need) {
        out.set(head, filled);
        filled += head.byteLength;
        pendingBytes -= head.byteLength;
        pending = pending.slice(1);
      } else {
        out.set(head.subarray(0, need), filled);
        pending[0] = head.subarray(need);
        pendingBytes -= need;
        filled += need;
      }
    }
    return out;
  };

  return {
    async next(): Promise<Buffer | null> {
      await fill();
      return take();
    },
  };
};

const NOT_FOUND_TAGS = new Set([
  "not_found",
  "not_file",
  "not_folder",
  "restricted_content",
]);
const UNAUTH_TAGS = new Set([
  "invalid_access_token",
  "expired_access_token",
  "missing_scope",
  "user_suspended",
  "route_access_denied",
  "access_denied",
]);
const CONFLICT_TAGS = new Set([
  "conflict",
  "no_write_permission",
  "shared_link_already_exists",
]);

const DEFAULT_MESSAGES: Record<ProviderFilesErrorCode, string> = {
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: "Dropbox error",
  Unauthorized: "Unauthorized",
};

// Dropbox errors arrive as a discriminated union of nested `.tag` objects
// (the SDK stores the parsed JSON error body at `err.error`). Walk the tree
// and collect every tag string we encounter, plus the leaf tag — that's
// enough to classify the major buckets without enumerating every
// UploadError/DeleteError/RelocationError variant.
const collectErrorTags = (body: JsonValue | undefined, depth = 0): string[] => {
  if (depth > 6 || !isObject(body)) {
    return [];
  }
  const tags: string[] = [];
  const tag = isJsonObject(body) ? body[".tag"] : undefined;
  if (isString(tag)) {
    tags.push(tag);
  }
  for (const value of Object.values(body)) {
    if (isObject(value)) {
      tags.push(...collectErrorTags(value, depth + 1));
    }
  }
  return tags;
};

const classifyByTags = (
  tags: readonly string[],
  status: number | undefined
): ProviderFilesErrorCode => {
  for (const t of tags) {
    if (NOT_FOUND_TAGS.has(t)) {
      return "NotFound";
    }
  }
  for (const t of tags) {
    if (UNAUTH_TAGS.has(t)) {
      return "Unauthorized";
    }
  }
  for (const t of tags) {
    if (CONFLICT_TAGS.has(t)) {
      return "Conflict";
    }
  }
  if (status === 404) {
    return "NotFound";
  }
  if (status === 401 || status === 403) {
    return "Unauthorized";
  }
  if (status === 412) {
    return "Conflict";
  }
  // Note: Dropbox returns HTTP 409 as the generic envelope for endpoint-
  // specific errors — the actual classification lives in the error body
  // tags, not the status. So 409 alone is *not* a Conflict signal here.
  return "Provider";
};

// Human-readable text from a parsed Dropbox error body: the API's
// `error_summary`, else a plain `message`.
const errorSummary = (body: JsonValue | undefined): string | undefined => {
  if (!isJsonObject(body)) {
    return;
  }
  const summary = body.error_summary;
  if (isString(summary) && summary.length > 0) {
    return summary;
  }
  const { message } = body;
  return isString(message) ? message : undefined;
};

export const mapDropboxError = (cause: unknown): FilesError => {
  if (cause instanceof FilesError) {
    return cause;
  }
  if (cause instanceof DropboxResponseError) {
    const tags = collectErrorTags(cause.error);
    const code = classifyByTags(tags, cause.status);
    const message = errorSummary(cause.error) ?? DEFAULT_MESSAGES[code];
    return new FilesError(code, message, cause);
  }
  const status =
    isObject(cause) && "status" in cause && isNumber(cause.status)
      ? cause.status
      : undefined;
  const message =
    isObject(cause) && "message" in cause && isString(cause.message)
      ? cause.message
      : undefined;
  const code = classifyByTags([], status);
  return new FilesError(code, message ?? DEFAULT_MESSAGES[code], cause);
};

// View a Uint8Array as a Node Buffer without copying — the Dropbox session
// helpers take `Buffer` contents.
const toBuffer = (data: Uint8Array): Buffer =>
  Buffer.from(data.buffer, data.byteOffset, data.byteLength);

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

interface NormalizedBody {
  data: Buffer;
  contentType: string;
}

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

// Dropbox doesn't store user-supplied MIME types — `filesUpload` accepts
// no Content-Type. Approximate by extension on the way out (shared with the
// FTP/SFTP adapters, which have the same gap) so callers don't get
// `application/octet-stream` for everything.

interface FileMeta {
  size: number;
  type: string;
  etag?: string;
  lastModified?: number;
}

const fileMetaFromDropbox = (item: files.FileMetadata): FileMeta => {
  const ms = item.server_modified
    ? new Date(item.server_modified).getTime()
    : undefined;
  return {
    ...(item.rev && { etag: item.rev }),
    ...(ms !== undefined && Number.isFinite(ms) && { lastModified: ms }),
    size: item.size ?? 0,
    type: inferTypeFromName(item.name ?? ""),
  };
};

// The SDK's `filesDownload` result: the metadata plus the bytes, attached as
// `fileBinary` (Node) or `fileBlob` (browsers/Workers). Beyond the declared
// shapes the adapter also tolerates an `ArrayBuffer` binary (custom fetch
// transports) and a real `Blob`.
interface DownloadedFile extends files.FileMetadata {
  fileBinary?: DropboxFileBinary | ArrayBuffer;
  fileBlob?: DropboxFileBlob | Blob;
}

const downloadResultToBytes = (result: DownloadedFile): Promise<Uint8Array> => {
  // Node path: SDK attaches a Buffer as `fileBinary`.
  const binary = result.fileBinary;
  if (binary instanceof Uint8Array) {
    return Promise.resolve(
      new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength)
    );
  }
  if (binary instanceof ArrayBuffer) {
    return Promise.resolve(new Uint8Array(binary));
  }
  // Browser/Workers path: SDK attaches a Blob as `fileBlob`.
  const blob = result.fileBlob;
  if (blob instanceof Blob) {
    // oxlint-disable-next-line github/no-then -- this helper is intentionally non-async and returns Promises across its branches (resolve/reject); making it async just to drop one .then() would restructure every branch
    return blob.arrayBuffer().then((ab) => new Uint8Array(ab));
  }
  return Promise.reject(
    new FilesError(
      "Provider",
      "dropbox: unexpected download response shape — neither fileBinary nor fileBlob present"
    )
  );
};

interface AuthHandle {
  /** Mutates `client.auth.accessToken` (when applicable) so subsequent SDK calls use a fresh token. */
  ensureAccessToken: () => Promise<void>;
  /** Internal — returns the current access token. Test-only / for custom auth flows. */
  getAccessToken: () => Promise<string>;
}

// `Dropbox.auth` exists at runtime (the constructor stores its `DropboxAuth`
// as `this.auth`) but the published .d.ts omits it.
type DropboxWithAuth = Dropbox & {
  auth: {
    setAccessToken: (token: string) => void;
    getAccessToken: () => string;
  };
};

const setAccessToken = (client: Dropbox, token: string): void => {
  // SAFETY: the Dropbox constructor assigns the `DropboxAuth` it was built
  // with to `this.auth`; only the published types leave it out.
  (client as DropboxWithAuth).auth.setAccessToken(token);
};

const getAccessToken = (client: Dropbox): string => {
  // SAFETY: the Dropbox constructor assigns the `DropboxAuth` it was built
  // with to `this.auth`; only the published types leave it out.
  const withAuth = client as DropboxWithAuth;
  return withAuth.auth.getAccessToken();
};

const createCallableAccessTokenAuth = (
  client: Dropbox,
  source: () => string | Promise<string>
): AuthHandle => {
  const ensure = async (): Promise<string> => {
    const token = await source();
    setAccessToken(client, token);
    return token;
  };
  return {
    async ensureAccessToken() {
      await ensure();
    },
    getAccessToken: ensure,
  };
};

const createStaticAccessTokenAuth = (
  client: Dropbox,
  token: string
): AuthHandle => {
  setAccessToken(client, token);
  return {
    ensureAccessToken: () => Promise.resolve(),
    getAccessToken: () => Promise.resolve(token),
  };
};

interface OAuthTokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface RefreshTokenAuthOptions {
  refreshToken: string;
  appKey: string;
  appSecret?: string;
}

const createRefreshTokenAuth = (
  client: Dropbox,
  opts: RefreshTokenAuthOptions
): AuthHandle => {
  let cached: { token: string; expiresOnMs: number } | undefined;

  const refresh = async (): Promise<string> => {
    const now = Date.now();
    if (cached && cached.expiresOnMs - REFRESH_LEEWAY_MS > now) {
      return cached.token;
    }
    const body = new URLSearchParams({
      client_id: opts.appKey,
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      ...(opts.appSecret && { client_secret: opts.appSecret }),
    });
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    if (!res.ok) {
      // oxlint-disable-next-line github/no-then -- best-effort read: swallow the body-read error and use "" when building the failure message
      const text = await res.text().catch(() => "");
      throw new FilesError(
        "Unauthorized",
        `dropbox: refresh-token exchange failed (${res.status}): ${text || res.statusText}`
      );
    }
    // SAFETY: `Response#json()` is untyped; a 2xx from Dropbox's token
    // endpoint is an OAuth 2.0 token response (`access_token`, `expires_in`),
    // and `access_token` is checked below before use.
    const json = (await res.json()) as OAuthTokenResponse;
    if (!json.access_token) {
      throw new FilesError(
        "Unauthorized",
        "dropbox: refresh-token response missing access_token"
      );
    }
    cached = {
      expiresOnMs: now + (json.expires_in ?? 3600) * 1000,
      token: json.access_token,
    };
    setAccessToken(client, json.access_token);
    return json.access_token;
  };

  return {
    async ensureAccessToken() {
      await refresh();
    },
    getAccessToken: refresh,
  };
};

interface ResolvedAuth {
  client: Dropbox;
  authHandle: AuthHandle;
  ownsClient: boolean;
}

const resolveAuth = (opts: DropboxAdapterOptions): ResolvedAuth => {
  // Pre-built client wins outright.
  if (opts.client) {
    const builtClient = opts.client;
    return {
      authHandle: {
        ensureAccessToken: () => Promise.resolve(),
        getAccessToken: () => Promise.resolve(getAccessToken(builtClient)),
      },
      client: builtClient,
      ownsClient: false,
    };
  }

  // Explicit options.
  const explicitToken = opts.accessToken;
  const explicitRefresh =
    opts.refreshToken !== undefined ||
    opts.appKey !== undefined ||
    opts.appSecret !== undefined;

  if (explicitToken !== undefined && explicitRefresh) {
    throw new FilesError(
      "Provider",
      "dropbox adapter: pass exactly one of `accessToken` or `refreshToken` (with `appKey`)."
    );
  }

  if (explicitToken !== undefined) {
    const auth = new DropboxAuth({
      accessToken: isString(explicitToken) ? explicitToken : undefined,
    });
    const client = new Dropbox({ auth });
    const handle = isString(explicitToken)
      ? createStaticAccessTokenAuth(client, explicitToken)
      : createCallableAccessTokenAuth(client, explicitToken);
    return { authHandle: handle, client, ownsClient: true };
  }

  if (explicitRefresh) {
    if (!opts.refreshToken || !opts.appKey) {
      throw new FilesError(
        "Provider",
        "dropbox adapter: refresh-token auth requires both `refreshToken` and `appKey`."
      );
    }
    // Don't pass refreshToken/clientId to DropboxAuth — that would activate
    // the SDK's own auto-refresh, which would race ours. We are the sole
    // refresh authority; the SDK just sees a fresh access token each call.
    const auth = new DropboxAuth({});
    const client = new Dropbox({ auth });
    const handle = createRefreshTokenAuth(client, {
      appKey: opts.appKey,
      ...(opts.appSecret && { appSecret: opts.appSecret }),
      refreshToken: opts.refreshToken,
    });
    return { authHandle: handle, client, ownsClient: true };
  }

  // Env-var fallback.
  const envAccessToken = readEnv("DROPBOX_ACCESS_TOKEN");
  if (envAccessToken) {
    const auth = new DropboxAuth({ accessToken: envAccessToken });
    const client = new Dropbox({ auth });
    return {
      authHandle: createStaticAccessTokenAuth(client, envAccessToken),
      client,
      ownsClient: true,
    };
  }
  const envRefreshToken = readEnv("DROPBOX_REFRESH_TOKEN");
  const envAppKey = readEnv("DROPBOX_APP_KEY");
  if (envRefreshToken && envAppKey) {
    const envAppSecret = readEnv("DROPBOX_APP_SECRET");
    const auth = new DropboxAuth({});
    const client = new Dropbox({ auth });
    return {
      authHandle: createRefreshTokenAuth(client, {
        appKey: envAppKey,
        ...(envAppSecret && { appSecret: envAppSecret }),
        refreshToken: envRefreshToken,
      }),
      client,
      ownsClient: true,
    };
  }

  throw new FilesError(
    "Provider",
    "dropbox adapter: missing auth. Pass `client`, `accessToken`, or `refreshToken` + `appKey`. Env fallbacks: DROPBOX_ACCESS_TOKEN, or DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY (+ DROPBOX_APP_SECRET)."
  );
};

const rewriteSharedLinkForDirectDownload = (url: string): string => {
  // Dropbox shared-link URLs carry `dl=0` (preview) by default. Setting
  // `dl=1` makes the same URL serve the raw bytes instead of the Dropbox
  // preview page — what `url()` callers usually want. Current `/scl/fi/`
  // links put `rlkey` before `dl`, so this goes through the URL parser
  // rather than matching `?dl=` textually.
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("dl", "1");
    return parsed.toString();
  } catch {
    // Not a parseable absolute URL — hand it back untouched.
    return url;
  }
};

// The Dropbox SDK stores the whole parsed error body at `err.error`, so a
// failed `create_shared_link_with_settings` variant lives under a second
// `error` envelope: `err.error.error.shared_link_already_exists.metadata.url`.
// Tolerate the bare (envelope-less) variant as well.
const existingSharedLinkUrl = (
  body: JsonValue | undefined
): string | undefined => {
  if (!isJsonObject(body)) {
    return;
  }
  const variant = isJsonObject(body.error) ? body.error : body;
  const existing = variant.shared_link_already_exists;
  const metadata = isJsonObject(existing) ? existing.metadata : undefined;
  const url = isJsonObject(metadata) ? metadata.url : undefined;
  return isString(url) && url.length > 0 ? url : undefined;
};

export const dropbox = (opts: DropboxAdapterOptions): DropboxAdapter => {
  const rootFolderPath = trimSlashes(opts.rootFolderPath ?? "");
  const publicByDefault = opts.publicByDefault ?? false;
  const { publicBaseUrl } = opts;
  const defaultUrlExpiresIn = Math.min(
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN,
    MAX_TEMPORARY_LINK_DURATION
  );

  const { client, authHandle } = resolveAuth(opts);

  // Translate a virtual key (e.g. "docs/a.txt") to a Dropbox path
  // ("/sandbox/docs/a.txt"). Dropbox paths must start with `/` and use
  // forward slashes; the empty root case is the special string "".
  const keyToPath = (key: string): string => {
    const inner = trimSlashes(key);
    const parts: string[] = [];
    if (rootFolderPath) {
      parts.push(rootFolderPath);
    }
    if (inner) {
      parts.push(inner);
    }
    return parts.length === 0 ? "" : `/${parts.join("/")}`;
  };

  const pathToKey = (path: string): string => {
    const inner = trimSlashes(path);
    if (!rootFolderPath) {
      return inner;
    }
    if (inner === rootFolderPath) {
      return "";
    }
    const prefix = `${rootFolderPath}/`;
    return inner.startsWith(prefix) ? inner.slice(prefix.length) : inner;
  };

  const lazyDownload = (key: string) => async (): Promise<Uint8Array> => {
    await authHandle.ensureAccessToken();
    const res = await client.filesDownload({ path: keyToPath(key) });
    return downloadResultToBytes(res.result);
  };

  const createPublicSharedLink = async (key: string): Promise<string> => {
    try {
      const res = await client.sharingCreateSharedLinkWithSettings({
        path: keyToPath(key),
        settings: { requested_visibility: { ".tag": "public" } },
      });
      return rewriteSharedLinkForDirectDownload(res.result.url);
    } catch (error) {
      // If a link already exists, the SDK throws with `shared_link_already_exists`
      // and embeds the existing metadata in the error body. Reuse it.
      if (error instanceof DropboxResponseError) {
        const tags = collectErrorTags(error.error);
        if (tags.includes("shared_link_already_exists")) {
          const url = existingSharedLinkUrl(error.error);
          if (url !== undefined) {
            return rewriteSharedLinkForDirectDownload(url);
          }
        }
      }
      throw error;
    }
  };

  const uploadSimple = async (
    path: string,
    data: Buffer
  ): Promise<files.FileMetadata> => {
    const res = await client.filesUpload({
      contents: data,
      mode: { ".tag": "overwrite" },
      mute: true,
      path,
    });
    return res.result;
  };

  const sessionStart = async (contents: Buffer): Promise<string> => {
    const start = await client.filesUploadSessionStart({
      close: false,
      contents,
    });
    return start.result.session_id;
  };

  const sessionAppend = async (
    sessionId: string,
    offset: number,
    contents: Buffer
  ): Promise<void> => {
    await client.filesUploadSessionAppendV2({
      close: false,
      contents,
      cursor: { offset, session_id: sessionId },
    });
  };

  const sessionFinish = async (
    path: string,
    sessionId: string,
    offset: number,
    contents: Buffer
  ): Promise<files.FileMetadata> => {
    const finish = await client.filesUploadSessionFinish({
      commit: { mode: { ".tag": "overwrite" }, mute: true, path },
      contents,
      cursor: { offset, session_id: sessionId },
    });
    return finish.result;
  };

  const uploadSession = async (
    path: string,
    data: Buffer,
    chunkBytes: number
  ): Promise<files.FileMetadata> => {
    const total = data.byteLength;
    let offset = Math.min(chunkBytes, total);
    const sessionId = await sessionStart(data.subarray(0, offset));

    while (total - offset > chunkBytes) {
      // eslint-disable-next-line no-await-in-loop -- chunks must be sequential to honor Dropbox session offset.
      await sessionAppend(
        sessionId,
        offset,
        data.subarray(offset, offset + chunkBytes)
      );
      offset += chunkBytes;
    }
    return await sessionFinish(
      path,
      sessionId,
      offset,
      data.subarray(offset, total)
    );
  };

  // Stream a body through an upload session, pulling `chunkBytes`-sized pieces
  // so peak memory is ~one chunk rather than the whole body. The final (smaller)
  // piece is sent in `finish`; every appended piece is a full `chunkBytes` so it
  // satisfies Dropbox's "non-final chunks must be a 4 MiB multiple" rule.
  const uploadSessionFromStream = async (
    path: string,
    stream: ReadableStream<Uint8Array>,
    chunkBytes: number
  ): Promise<{ item: files.FileMetadata; size: number }> => {
    const chunker = makeStreamChunker(stream, chunkBytes);
    const first = await chunker.next();
    // Empty stream, or one that fits in a single chunk: a plain upload is
    // cheaper than a 3-call session and still memory-bounded.
    if (first === null) {
      return { item: await uploadSimple(path, Buffer.alloc(0)), size: 0 };
    }
    if (first.byteLength < chunkBytes) {
      return { item: await uploadSimple(path, first), size: first.byteLength };
    }
    const sessionId = await sessionStart(first);
    let offset = first.byteLength;
    let chunk = await chunker.next();
    while (chunk !== null) {
      // eslint-disable-next-line no-await-in-loop -- chunks must be sequential to honor Dropbox session offset.
      const next = await chunker.next();
      if (next === null) {
        // `chunk` is the final piece — send it in finish below.
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- sequential session offsets.
      await sessionAppend(sessionId, offset, chunk);
      offset += chunk.byteLength;
      chunk = next;
    }
    const tail = chunk ?? Buffer.alloc(0);
    const item = await sessionFinish(path, sessionId, offset, tail);
    return { item, size: offset + tail.byteLength };
  };

  // Pause-able / resumable upload over the same Dropbox upload session as
  // `uploadSession`, driven chunk-by-chunk by the orchestrator. Dropbox has no
  // API to query a session's offset, so the token tracks it client-side — the
  // driver mutates the session object the orchestrator exposes via `toJSON()`,
  // keeping the persisted offset current across a pause.
  const createResumableDriver = (
    key: string,
    resumableOpts: ResumableDriverOptions
  ): OffsetResumableDriver => {
    const path = keyToPath(key);
    const chunkBytes = resolveChunkBytes(resumableOpts.multipart);
    let session:
      | Extract<ResumableUploadSession, { provider: "dropbox" }>
      | undefined;
    let finalItem: files.FileMetadata | undefined;
    let contentType = OCTET_STREAM;
    const requireSession = () => {
      if (!session) {
        throw new FilesError(
          "Provider",
          "dropbox: upload session not started."
        );
      }
      return session;
    };
    return {
      adopt(adopted: ResumableUploadSession) {
        if (adopted.provider !== "dropbox") {
          throw new FilesError(
            "Provider",
            `Cannot resume a ${adopted.provider} session on a Dropbox adapter.`
          );
        }
        if (adopted.path !== path) {
          throw new FilesError(
            "Provider",
            "Resume token does not match this upload's path."
          );
        }
        session = adopted;
        ({ contentType } = adopted);
      },
      async begin(meta): Promise<ResumableUploadSession> {
        // `metadata` / `cacheControl` are rejected centrally by the Files
        // wrapper before a resumable upload ever reaches here.
        try {
          await authHandle.ensureAccessToken();
          ({ contentType } = meta);
          const sessionId = await sessionStart(Buffer.alloc(0));
          session = {
            contentType,
            offset: 0,
            path,
            provider: "dropbox",
            sessionId,
          };
          return session;
        } catch (error) {
          throw mapDropboxError(error);
        }
      },
      complete(): Promise<UploadResult> {
        if (!finalItem) {
          throw new FilesError(
            "Provider",
            "dropbox: upload session did not finalize."
          );
        }
        const meta = fileMetaFromDropbox(finalItem);
        return Promise.resolve({
          contentType,
          ...(meta.etag && { etag: meta.etag }),
          key,
          ...(meta.lastModified !== undefined && {
            lastModified: meta.lastModified,
          }),
          size: requireSession().offset,
        });
      },
      discard() {
        // Dropbox has no API to cancel an upload session; it expires on its own.
        return Promise.resolve();
      },
      mode: "offset",
      partSize: chunkBytes,
      probe(): Promise<{ nextOffset: number }> {
        // No server-side offset query — trust the offset tracked in the token.
        return Promise.resolve({ nextOffset: requireSession().offset });
      },
      async uploadAt({
        offset,
        data,
        isLast,
      }): Promise<{ nextOffset: number }> {
        try {
          await authHandle.ensureAccessToken();
          const current = requireSession();
          const buffer = toBuffer(data);
          if (isLast) {
            finalItem = await sessionFinish(
              path,
              current.sessionId,
              offset,
              buffer
            );
          } else {
            await sessionAppend(current.sessionId, offset, buffer);
          }
          const nextOffset = offset + data.byteLength;
          current.offset = nextOffset;
          return { nextOffset };
        } catch (error) {
          throw mapDropboxError(error);
        }
      },
    };
  };

  const adapter: DropboxAdapter = {
    async copy(from, to) {
      try {
        await authHandle.ensureAccessToken();
        await client.filesCopyV2({
          from_path: keyToPath(from),
          to_path: keyToPath(to),
        });
      } catch (error) {
        throw mapDropboxError(error);
      }
    },
    async delete(key) {
      try {
        await authHandle.ensureAccessToken();
        await client.filesDeleteV2({ path: keyToPath(key) });
      } catch (error) {
        const mapped = mapDropboxError(error);
        // Idempotent: missing item is not an error.
        if (mapped.code === "NotFound") {
          return;
        }
        throw mapped;
      }
    },
    async download(key, downloadOpts) {
      try {
        await authHandle.ensureAccessToken();
        const range = downloadOpts?.range;
        // `filesDownload` buffers the whole body and exposes neither streaming
        // nor a byte range. For streaming OR a range we fetch the temporary
        // link instead — it serves the bytes over standard HTTP (Range-capable)
        // and exposes a ReadableStream body. This fetch is also the only path
        // that can carry the abort signal, since the SDK transport can't.
        if (downloadOpts?.as === "stream" || range) {
          const tmp = await client.filesGetTemporaryLink({
            path: keyToPath(key),
          });
          const tmpResult = tmp.result;
          const meta = fileMetaFromDropbox(tmpResult.metadata);
          const linkRes = await fetch(tmpResult.link, {
            ...(downloadOpts?.signal && { signal: downloadOpts.signal }),
            ...(range && { headers: rangeRequestHeaders(range) }),
          });
          if (!linkRes.ok || !linkRes.body) {
            throw new FilesError(
              "Provider",
              `dropbox: temporary-link fetch failed (${linkRes.status})`
            );
          }
          if (range) {
            assertRangeHonored(linkRes.status, "dropbox");
          }
          if (downloadOpts?.as === "stream") {
            const stream = linkRes.body;
            return createStoredFile(
              {
                key,
                ...meta,
                ...(range && {
                  size: rangedResponseSize(
                    linkRes.headers.get("content-length"),
                    meta.size,
                    range
                  ),
                }),
              },
              { factory: () => stream, kind: "stream" }
            );
          }
          // Buffered + ranged: drain the ranged response.
          const rangedBytes = new Uint8Array(await linkRes.arrayBuffer());
          return createStoredFile(
            { key, ...meta, size: rangedBytes.byteLength },
            { data: rangedBytes, kind: "buffer" }
          );
        }
        const res = await client.filesDownload({ path: keyToPath(key) });
        const { result } = res;
        const meta = fileMetaFromDropbox(result);
        const bytes = await downloadResultToBytes(result);
        return createStoredFile(
          { key, ...meta, size: bytes.byteLength },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapDropboxError(error);
      }
    },
    exists(key) {
      return existsByProbe(async () => {
        await authHandle.ensureAccessToken();
        const res = await client.filesGetMetadata({ path: keyToPath(key) });
        const item = res.result;
        const tag = item[".tag"];
        if (tag === "folder" || tag === "deleted") {
          throw new FilesError(
            "NotFound",
            `dropbox: ${key} is not a file (tag=${tag})`
          );
        }
      }, mapDropboxError);
    },
    async head(key) {
      try {
        await authHandle.ensureAccessToken();
        const res = await client.filesGetMetadata({ path: keyToPath(key) });
        const item = res.result;
        if (item[".tag"] === "folder" || item[".tag"] === "deleted") {
          throw new FilesError(
            "NotFound",
            `dropbox: ${key} is not a file (tag=${item[".tag"]})`
          );
        }
        const meta = fileMetaFromDropbox(item);
        return createStoredFile(
          { key, ...meta },
          { factory: lazyDownload(key), kind: "lazy" }
        );
      } catch (error) {
        throw mapDropboxError(error);
      }
    },
    async list(options): Promise<ListResult> {
      // With a delimiter, list one folder level (recursive: false) rooted at
      // the prefix and surface subfolders as common prefixes; otherwise walk
      // the whole tree recursively as before.
      const folded = options?.delimiter !== undefined;
      if (options?.delimiter) {
        assertSlashDelimiter("dropbox", options.delimiter);
      }
      try {
        await authHandle.ensureAccessToken();
        const res = options?.cursor
          ? await client.filesListFolderContinue({ cursor: options.cursor })
          : await client.filesListFolder({
              limit: options?.limit,
              path: keyToPath(folded ? (options?.prefix ?? "") : ""),
              recursive: !folded,
            });
        const { result } = res;
        const items: StoredFile[] = [];
        const prefixes: string[] = [];
        // Classify one entry into items (files) or prefixes (folders, folded
        // mode only); nested so the loop's branching stays out of `list`.
        const collect = (entry: files.ListFolderResult["entries"][number]) => {
          const path =
            entry.path_display ?? entry.path_lower ?? `/${entry.name ?? ""}`;
          const key = pathToKey(path);
          if (!key) {
            return;
          }
          if (entry[".tag"] === "folder") {
            if (folded) {
              prefixes.push(`${key}/`);
            }
            return;
          }
          if (entry[".tag"] !== "file") {
            return;
          }
          if (options?.prefix && !key.startsWith(options.prefix)) {
            return;
          }
          items.push(
            createStoredFile(
              { key, ...fileMetaFromDropbox(entry) },
              { factory: lazyDownload(key), kind: "lazy" }
            )
          );
        };
        for (const entry of result.entries) {
          collect(entry);
        }
        return {
          items,
          ...(result.has_more && { cursor: result.cursor }),
          ...(prefixes.length && { prefixes }),
        };
      } catch (error) {
        const mapped = mapDropboxError(error);
        // A folded listing of a folder that doesn't exist is an empty folder.
        if (folded && mapped.code === "NotFound") {
          return { items: [] };
        }
        throw mapped;
      }
    },
    name: "dropbox",
    raw: client,
    resumableUpload: createResumableDriver,
    rootFolderPath,
    signedUploadUrl(_key, _signOpts): Promise<SignedUpload> {
      // Dropbox's `files/get_temporary_upload_link` returns a URL that
      // requires `POST` with `Content-Type: application/octet-stream` and
      // the raw file bytes as the body. Our `SignedUpload` shape supports
      // PUT-with-raw-body or POST-with-form-fields (S3 policy style); a
      // raw-body POST fits neither. Throw rather than mint a URL whose
      // method our contract misrepresents.
      return Promise.reject(
        new FilesError(
          "Provider",
          "dropbox: signedUploadUrl is not supported. Dropbox's temporary upload link uses POST with a raw body, which doesn't fit the SDK's PUT/POST-form contract. Use upload() or `adapter.raw.filesGetTemporaryUploadLink(...)` directly."
        )
      );
    },
    // `url()` returns a temporary link — time-limited, but capped at 4h
    // (`MAX_TEMPORARY_LINK_DURATION`); `url()` throws above that.
    signedUrl: { maxExpiresIn: MAX_TEMPORARY_LINK_DURATION, supported: true },
    supportsDelimiter: true,
    supportsRange: true,
    // `copy()` is a server-side `filesCopyV2`.
    supportsServerSideCopy: true,
    async upload(key, body, options): Promise<UploadResult> {
      // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
      // (this adapter advertises neither) — Dropbox files have no native
      // arbitrary-metadata or cache-header field.
      try {
        await authHandle.ensureAccessToken();
        const path = keyToPath(key);
        const chunkBytes = resolveChunkBytes(options?.multipart);
        // Stream bodies upload chunk-by-chunk so a multi-GB file never has to
        // be held in memory all at once. Buffered bodies are already resident,
        // so they keep the simple-vs-session-by-size path.
        let item: files.FileMetadata;
        let size: number;
        let contentType: string;
        if (body instanceof ReadableStream) {
          contentType = options?.contentType ?? OCTET_STREAM;
          ({ item, size } = await uploadSessionFromStream(
            path,
            body,
            chunkBytes
          ));
        } else {
          const normalized = await normalizeBody(body, options?.contentType);
          ({ contentType } = normalized);
          size = normalized.data.byteLength;
          item =
            size <= SIMPLE_UPLOAD_LIMIT_BYTES
              ? await uploadSimple(path, normalized.data)
              : await uploadSession(path, normalized.data, chunkBytes);
        }
        if (publicByDefault) {
          // Idempotent: if the link already exists, createPublicSharedLink
          // pulls the existing URL from the error body.
          await createPublicSharedLink(key);
        }
        const meta = fileMetaFromDropbox(item);
        return {
          contentType,
          ...(meta.etag && { etag: meta.etag }),
          key,
          ...(meta.lastModified !== undefined && {
            lastModified: meta.lastModified,
          }),
          size,
        };
      } catch (error) {
        throw mapDropboxError(error);
      }
    },
    async url(key, urlOpts) {
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "dropbox: `responseContentDisposition` is not supported. Dropbox temporary links and shared links have no Content-Disposition override."
        );
      }
      const expiresIn = urlOpts?.expiresIn ?? defaultUrlExpiresIn;
      if (expiresIn > MAX_TEMPORARY_LINK_DURATION) {
        throw new FilesError(
          "Provider",
          `dropbox: \`expiresIn\` of ${expiresIn}s exceeds the ${MAX_TEMPORARY_LINK_DURATION}s (4h) maximum for Dropbox temporary links. Use \`publicByDefault: true\` for a permanent shared link.`
        );
      }
      if (publicBaseUrl) {
        return joinPublicUrl(publicBaseUrl, key);
      }
      try {
        // oxlint-disable-next-line react-doctor/async-defer-await -- both branches below need a fresh access token, so this must run before the publicByDefault guard, not after it
        await authHandle.ensureAccessToken();
        if (publicByDefault) {
          return await createPublicSharedLink(key);
        }
        const res = await client.filesGetTemporaryLink({
          path: keyToPath(key),
        });
        return res.result.link;
      } catch (error) {
        throw mapDropboxError(error);
      }
    },
  };
  // Tests reach in via this property to verify auth flows; not part of
  // the public type so users don't accidentally couple to it.
  Object.defineProperty(adapter, "_authHandle", {
    enumerable: false,
    value: authHandle,
  });
  return adapter;
};
