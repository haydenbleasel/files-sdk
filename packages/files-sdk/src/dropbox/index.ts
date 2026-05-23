import { Buffer } from "node:buffer";

import { Dropbox, DropboxAuth, DropboxResponseError } from "dropbox";
import type { files, sharing } from "dropbox";

import type {
  Adapter,
  Body,
  ListResult,
  MultipartOptions,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  DEFAULT_URL_EXPIRES_IN,
  existsByProbe,
  joinPublicUrl,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import type { FilesErrorCode } from "../internal/errors.js";
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
   * Capped at 14400 (4 hours, the Dropbox maximum). Defaults to 3600.
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
const REFRESH_LEEWAY_MS = 60_000;
const SIMPLE_UPLOAD_LIMIT_BYTES = 150 * 1024 * 1024;
const UPLOAD_SESSION_CHUNK_BYTES = 8 * 1024 * 1024;
// Dropbox requires every non-final session chunk to be a multiple of 4 MiB.
const UPLOAD_SESSION_CHUNK_MULTIPLE = 4 * 1024 * 1024;

/**
 * Resolve the session chunk size from `multipart.partSize`, rounded down to a
 * 4 MiB multiple (Dropbox's requirement) and never below one unit. Defaults to
 * 8 MiB when no `partSize` is given.
 */
const resolveChunkBytes = (
  multipart: boolean | MultipartOptions | undefined
): number => {
  const partSize =
    typeof multipart === "object" ? multipart.partSize : undefined;
  if (partSize === undefined) {
    return UPLOAD_SESSION_CHUNK_BYTES;
  }
  const rounded =
    Math.floor(partSize / UPLOAD_SESSION_CHUNK_MULTIPLE) *
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

const DEFAULT_MESSAGES: Record<FilesErrorCode, string> = {
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: "Dropbox error",
  Unauthorized: "Unauthorized",
};

// Dropbox errors arrive as a discriminated union of nested `.tag` objects.
// Walk the tree and collect every tag string we encounter, plus the leaf
// tag — that's enough to classify the major buckets without enumerating
// every UploadError/DeleteError/RelocationError variant.
const collectErrorTags = (err: unknown, depth = 0): string[] => {
  if (depth > 6 || err === null || typeof err !== "object") {
    return [];
  }
  const tags: string[] = [];
  const obj = err as Record<string, unknown>;
  const tag = obj[".tag"];
  if (typeof tag === "string") {
    tags.push(tag);
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      tags.push(...collectErrorTags(value, depth + 1));
    }
  }
  return tags;
};

const classifyByTags = (
  tags: readonly string[],
  status: number | undefined
): FilesErrorCode => {
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

const errorSummary = (err: unknown): string | undefined => {
  if (err === null || typeof err !== "object") {
    return;
  }
  const summary = (err as { error_summary?: unknown }).error_summary;
  if (typeof summary === "string" && summary.length > 0) {
    return summary;
  }
  const { message } = err as { message?: unknown };
  return typeof message === "string" ? message : undefined;
};

export const mapDropboxError = (err: unknown): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  if (err instanceof DropboxResponseError) {
    const tags = collectErrorTags(err.error);
    const code = classifyByTags(tags, err.status);
    const message = errorSummary(err.error) ?? DEFAULT_MESSAGES[code];
    return new FilesError(code, message, err);
  }
  const e = err as { status?: number; message?: string } | null;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const code = classifyByTags([], status);
  return new FilesError(code, e?.message ?? DEFAULT_MESSAGES[code], err);
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

const collectStream = async (
  stream: ReadableStream<Uint8Array>
): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  while (true) {
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
  if (typeof body === "string") {
    return {
      contentType: contentTypeHint ?? "text/plain; charset=utf-8",
      data: Buffer.from(body, "utf-8"),
    };
  }
  if (body instanceof Uint8Array) {
    return {
      contentType: contentTypeHint ?? "application/octet-stream",
      data: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
    };
  }
  if (body instanceof ArrayBuffer) {
    return {
      contentType: contentTypeHint ?? "application/octet-stream",
      data: Buffer.from(body),
    };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return {
      contentType: contentTypeHint ?? "application/octet-stream",
      data: Buffer.from(view.buffer, view.byteOffset, view.byteLength),
    };
  }
  if (body instanceof Blob) {
    return {
      contentType: contentTypeHint ?? body.type ?? "application/octet-stream",
      data: Buffer.from(await body.arrayBuffer()),
    };
  }
  return {
    contentType: contentTypeHint ?? "application/octet-stream",
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

const downloadResultToBytes = (
  result: files.FileMetadata & { fileBinary?: unknown; fileBlob?: unknown }
): Promise<Uint8Array> => {
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
  ensureAccessToken(): Promise<void>;
  /** Internal — returns the current access token. Test-only / for custom auth flows. */
  getAccessToken(): Promise<string>;
}

// `Dropbox.auth` exists at runtime (constructor stores it as `this.auth`)
// but the published .d.ts omits it. Cast through this shape rather than
// `as any`.
type DropboxWithAuth = Dropbox & {
  auth: {
    setAccessToken(token: string): void;
    getAccessToken(): string;
  };
};

const setAccessToken = (client: Dropbox, token: string): void => {
  (client as DropboxWithAuth).auth.setAccessToken(token);
};

const getAccessToken = (client: Dropbox): string =>
  (client as DropboxWithAuth).auth.getAccessToken();

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
      const text = await res.text().catch(() => "");
      throw new FilesError(
        "Unauthorized",
        `dropbox: refresh-token exchange failed (${res.status}): ${text || res.statusText}`
      );
    }
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
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
      accessToken:
        typeof explicitToken === "string" ? explicitToken : undefined,
    });
    const client = new Dropbox({ auth });
    const handle =
      typeof explicitToken === "function"
        ? createCallableAccessTokenAuth(client, explicitToken)
        : createStaticAccessTokenAuth(client, explicitToken);
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
  // Dropbox shared-link URLs end in `?dl=0` (preview) by default. Rewriting
  // to `?dl=1` makes the same URL serve the raw bytes instead of the
  // Dropbox preview page — what `url()` callers usually want.
  if (url.includes("?dl=0")) {
    return url.replace("?dl=0", "?dl=1");
  }
  if (url.includes("?dl=")) {
    return url;
  }
  return url + (url.includes("?") ? "&dl=1" : "?dl=1");
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
    return downloadResultToBytes(
      res.result as files.FileMetadata & {
        fileBinary?: unknown;
        fileBlob?: unknown;
      }
    );
  };

  const createPublicSharedLink = async (key: string): Promise<string> => {
    try {
      const res = await client.sharingCreateSharedLinkWithSettings({
        path: keyToPath(key),
        settings: {
          requested_visibility: { ".tag": "public" },
        } as sharing.SharedLinkSettings,
      });
      return rewriteSharedLinkForDirectDownload(
        (res.result as sharing.SharedLinkMetadata).url
      );
    } catch (error) {
      // If a link already exists, the SDK throws with `shared_link_already_exists`
      // and embeds the existing metadata in the error body. Reuse it.
      if (error instanceof DropboxResponseError) {
        const tags = collectErrorTags(error.error);
        if (tags.includes("shared_link_already_exists")) {
          const meta = (
            error.error as sharing.CreateSharedLinkWithSettingsErrorSharedLinkAlreadyExists
          ).shared_link_already_exists as
            | { metadata?: { url?: string } }
            | undefined;
          const url = meta?.metadata?.url;
          if (typeof url === "string" && url.length > 0) {
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
    } as files.UploadArg & { contents: Buffer });
    return res.result;
  };

  const sessionStart = async (contents: Buffer): Promise<string> => {
    const start = await client.filesUploadSessionStart({
      close: false,
      contents,
    } as { close: boolean; contents: Buffer });
    return (start.result as { session_id: string }).session_id;
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
    } as {
      close: boolean;
      contents: Buffer;
      cursor: { offset: number; session_id: string };
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
    } as {
      commit: files.CommitInfo;
      contents: Buffer;
      cursor: { offset: number; session_id: string };
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
        if (downloadOpts?.as === "stream") {
          // Dropbox's SDK download doesn't expose a streaming body —
          // `filesDownload` buffers the full response. For genuine streaming
          // we fall back to fetching the temporary link, which serves the
          // bytes via standard HTTP and exposes a ReadableStream body.
          const tmp = await client.filesGetTemporaryLink({
            path: keyToPath(key),
          });
          const tmpResult = tmp.result;
          const meta = fileMetaFromDropbox(tmpResult.metadata);
          // The buffer path below goes through the Dropbox SDK's own
          // transport, which exposes no cancellation; only this temporary-link
          // fetch can carry the signal.
          const linkRes = await fetch(
            tmpResult.link,
            downloadOpts?.signal ? { signal: downloadOpts.signal } : undefined
          );
          if (!linkRes.ok || !linkRes.body) {
            throw new FilesError(
              "Provider",
              `dropbox: temporary-link fetch failed (${linkRes.status})`
            );
          }
          const stream = linkRes.body as ReadableStream<Uint8Array>;
          return createStoredFile(
            { key, ...meta },
            { factory: () => stream, kind: "stream" }
          );
        }
        const res = await client.filesDownload({ path: keyToPath(key) });
        const result = res.result as files.FileMetadata & {
          fileBinary?: unknown;
          fileBlob?: unknown;
        };
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
        const tag = (item as { ".tag"?: string })[".tag"];
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
        const tag = (item as { ".tag"?: string })[".tag"];
        if (tag === "folder" || tag === "deleted") {
          throw new FilesError(
            "NotFound",
            `dropbox: ${key} is not a file (tag=${tag})`
          );
        }
        const file = item as files.FileMetadata;
        const meta = fileMetaFromDropbox(file);
        return createStoredFile(
          { key, ...meta },
          { factory: lazyDownload(key), kind: "lazy" }
        );
      } catch (error) {
        throw mapDropboxError(error);
      }
    },
    async list(options): Promise<ListResult> {
      try {
        await authHandle.ensureAccessToken();
        const res = options?.cursor
          ? await client.filesListFolderContinue({ cursor: options.cursor })
          : await client.filesListFolder({
              limit: options?.limit,
              path: keyToPath(""),
              recursive: true,
            });
        const result = res.result as files.ListFolderResult;
        const items: StoredFile[] = [];
        for (const entry of result.entries) {
          const tag = (entry as { ".tag"?: string })[".tag"];
          if (tag !== "file") {
            continue;
          }
          const file = entry as files.FileMetadataReference;
          const path =
            file.path_display ?? file.path_lower ?? `/${file.name ?? ""}`;
          const key = pathToKey(path);
          if (!key) {
            continue;
          }
          if (options?.prefix && !key.startsWith(options.prefix)) {
            continue;
          }
          const meta = fileMetaFromDropbox(file);
          items.push(
            createStoredFile(
              { key, ...meta },
              { factory: lazyDownload(key), kind: "lazy" }
            )
          );
        }
        return {
          items,
          ...(result.has_more && { cursor: result.cursor }),
        };
      } catch (error) {
        throw mapDropboxError(error);
      }
    },
    name: "dropbox",
    raw: client,
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
    async upload(key, body, options): Promise<UploadResult> {
      if (options?.metadata && Object.keys(options.metadata).length > 0) {
        throw new FilesError(
          "Provider",
          "dropbox: `metadata` is not supported. Dropbox files have no native arbitrary-metadata field; use `raw` with `property_groups` (requires a registered template) if you need it."
        );
      }
      if (options?.cacheControl) {
        throw new FilesError(
          "Provider",
          "dropbox: `cacheControl` is not supported. Dropbox does not expose HTTP cache headers on file content."
        );
      }
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
          contentType = options?.contentType ?? "application/octet-stream";
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
