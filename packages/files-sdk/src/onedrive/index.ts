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
  ListResult,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import { existsByProbe } from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import type { FilesErrorCode } from "../internal/errors.js";
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
export type OneDriveAdapter = Adapter<OneDriveClient> & {
  readonly basePath: string;
  readonly rootFolderPath: string;
};

const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";
const SIMPLE_UPLOAD_LIMIT_BYTES = 250 * 1024 * 1024;
const DEFAULT_COPY_TIMEOUT_MS = 60_000;
const COPY_POLL_INTERVAL_MS = 500;

const NOT_FOUND_CODES = new Set(["itemNotFound"]);
const UNAUTH_CODES = new Set([
  "unauthenticated",
  "InvalidAuthenticationToken",
  "accessDenied",
]);
const CONFLICT_CODES = new Set(["nameAlreadyExists", "resourceModified"]);

const DEFAULT_MESSAGES: Record<FilesErrorCode, string> = {
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: "OneDrive error",
  Unauthorized: "Unauthorized",
};

const classifyGraphError = (
  status: number | undefined,
  code: string | null | undefined
): FilesErrorCode => {
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

export const mapGraphError = (err: unknown): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  if (err instanceof GraphError) {
    const code = classifyGraphError(err.statusCode, err.code);
    const innerMessage =
      (err.body && typeof err.body === "object"
        ? ((err.body as { error?: { message?: string } }).error?.message ??
          (err.body as { message?: string }).message)
        : undefined) ?? err.message;
    return new FilesError(code, innerMessage || DEFAULT_MESSAGES[code], err);
  }
  const e = err as {
    statusCode?: number;
    status?: number;
    code?: string | number;
    message?: string;
  };
  const status = ((): number | undefined => {
    if (typeof e?.statusCode === "number") {
      return e.statusCode;
    }
    if (typeof e?.status === "number") {
      return e.status;
    }
    return undefined;
  })();
  const codeStr = typeof e?.code === "string" ? e.code : undefined;
  const errorCode = classifyGraphError(status, codeStr);
  return new FilesError(
    errorCode,
    e?.message ?? DEFAULT_MESSAGES[errorCode],
    err
  );
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

const encodePathSegments = (path: string): string =>
  trimSlashes(path)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

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

const toUint8 = (data: unknown): Uint8Array => {
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
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (typeof data === "string") {
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

const itemToStoredMeta = (
  item: DriveItem
): {
  size: number;
  type: string;
  etag?: string;
  lastModified?: number;
} => ({
  ...(item.eTag && { etag: item.eTag.replaceAll('"', "") }),
  ...(item.lastModifiedDateTime && {
    lastModified: new Date(item.lastModifiedDateTime).getTime(),
  }),
  size: Number(item.size ?? 0),
  type: item.file?.mimeType ?? "application/octet-stream",
});

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
      const text = await res.text().catch(() => "");
      throw new FilesError(
        "Unauthorized",
        `onedrive: refresh-token exchange failed (${res.status}): ${text || res.statusText}`
      );
    }
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      throw new FilesError(
        "Unauthorized",
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
    if (typeof source === "string") {
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

const buildAuthProvider = (
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
  const driveId = opts.driveId ?? readEnv("ONEDRIVE_DRIVE_ID");
  const siteId = opts.siteId ?? readEnv("ONEDRIVE_SITE_ID");
  const userId = opts.userId ?? readEnv("ONEDRIVE_USER_ID");
  const targets = [driveId, siteId, userId].filter(
    (t): t is string => typeof t === "string" && t.length > 0
  );
  if (targets.length > 1) {
    throw new FilesError(
      "Provider",
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
      "Provider",
      "onedrive: clientCredentials auth requires `driveId`, `siteId`, or `userId` — `/me/drive` is not available without an interactive user."
    );
  }
  return "/me/drive";
};

export const onedrive = (
  opts: OneDriveAdapterOptions = {}
): OneDriveAdapter => {
  const explicitAuthShapes = [
    opts.clientCredentials,
    opts.oauth,
    opts.accessToken,
    opts.client,
  ].filter((v) => v !== undefined && v !== null);
  if (explicitAuthShapes.length === 0 && !hasEnvAuth()) {
    throw new FilesError(
      "Provider",
      "onedrive adapter: missing auth. Pass `clientCredentials`, `oauth`, `accessToken`, or `client`. Env fallbacks: ONEDRIVE_ACCESS_TOKEN, or ONEDRIVE_TENANT_ID + ONEDRIVE_CLIENT_ID + ONEDRIVE_CLIENT_SECRET."
    );
  }
  if (explicitAuthShapes.length > 1) {
    throw new FilesError(
      "Provider",
      "onedrive adapter: pass exactly one of `clientCredentials`, `oauth`, `accessToken`, or `client`."
    );
  }

  const basePath = resolveBasePath(opts);
  const rootFolderPath = trimSlashes(opts.rootFolderPath ?? "");
  const publicByDefault = opts.publicByDefault ?? false;
  const copyTimeoutMs = opts.copyTimeoutMs ?? DEFAULT_COPY_TIMEOUT_MS;

  let client: Client;
  if (opts.client) {
    ({ client } = opts);
  } else {
    const authProvider = buildAuthProvider(opts);
    if (!authProvider) {
      // Unreachable — explicit auth shape count guarantees one branch matched.
      throw new FilesError("Provider", "onedrive: failed to build auth");
    }
    const clientOpts: ClientOptions = { authProvider };
    client = Client.initWithMiddleware(clientOpts);
  }

  const itemApiPath = (key: string): string => {
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

  const lazyDownload = (key: string) => async (): Promise<Uint8Array> => {
    const data = (await client
      .api(`${itemApiPath(key)}/content`)
      .responseType(ResponseType.ARRAYBUFFER)
      .get()) as unknown;
    return toUint8(data);
  };

  const pollCopyMonitor = async (monitorUrl: string): Promise<void> => {
    const start = Date.now();
    while (true) {
      const res = await fetch(monitorUrl);
      if (!res.ok && res.status !== 202) {
        const text = await res.text().catch(() => "");
        throw new FilesError(
          "Provider",
          `onedrive: copy monitor failed (${res.status}): ${text || res.statusText}`
        );
      }
      const json = (await res.json().catch(() => ({}))) as {
        status?: string;
        percentageComplete?: number;
        error?: { message?: string };
      };
      if (json.status === "completed") {
        return;
      }
      if (json.status === "failed") {
        throw new FilesError(
          "Provider",
          json.error?.message ?? "onedrive: copy operation failed"
        );
      }
      if (Date.now() - start > copyTimeoutMs) {
        throw new FilesError(
          "Provider",
          `onedrive: copy operation timed out after ${copyTimeoutMs}ms`
        );
      }
      await delay(COPY_POLL_INTERVAL_MS);
    }
  };

  const createAnonymousLink = async (key: string): Promise<string> => {
    const res = (await client
      .api(`${itemApiPath(key)}/createLink`)
      .post({ scope: "anonymous", type: "view" })) as {
      link?: { webUrl?: string };
    };
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
    async copy(from, to) {
      try {
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
        const res = (await client
          .api(`${itemApiPath(from)}/copy`)
          .responseType(ResponseType.RAW)
          .post({
            name: basename(to),
            parentReference: parentRef,
          })) as Response;
        // Graph returns 202 + Location header pointing to a monitor URL.
        const monitorUrl =
          res.headers.get("location") ?? res.headers.get("Location");
        if (!monitorUrl) {
          // Some configurations return 200 with the new item directly — treat
          // as success.
          if (res.status >= 200 && res.status < 300) {
            return;
          }
          throw new FilesError(
            "Provider",
            `onedrive: copy returned ${res.status} without monitor URL`
          );
        }
        await pollCopyMonitor(monitorUrl);
      } catch (error) {
        throw mapGraphError(error);
      }
    },
    async delete(key) {
      try {
        await client.api(itemApiPath(key)).delete();
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
        if (downloadOpts?.as === "stream") {
          const [meta, stream] = await Promise.all([
            client.api(itemApiPath(key)).get() as Promise<DriveItem>,
            client
              .api(`${itemApiPath(key)}/content`)
              .responseType(ResponseType.STREAM)
              .get() as Promise<Readable>,
          ]);
          const m = itemToStoredMeta(meta);
          return createStoredFile(
            { key, ...m },
            {
              factory: () =>
                Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
              kind: "stream",
            }
          );
        }
        const [meta, bytes] = await Promise.all([
          client.api(itemApiPath(key)).get() as Promise<DriveItem>,
          client
            .api(`${itemApiPath(key)}/content`)
            .responseType(ResponseType.ARRAYBUFFER)
            .get() as Promise<unknown>,
        ]);
        const m = itemToStoredMeta(meta);
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
      return existsByProbe(
        () => client.api(itemApiPath(key)).get(),
        mapGraphError
      );
    },
    async head(key) {
      try {
        const meta = (await client.api(itemApiPath(key)).get()) as DriveItem;
        const m = itemToStoredMeta(meta);
        return createStoredFile(
          { key, ...m },
          { factory: lazyDownload(key), kind: "lazy" }
        );
      } catch (error) {
        throw mapGraphError(error);
      }
    },
    async list(options): Promise<ListResult> {
      try {
        // Cursor (when provided) is the @odata.nextLink absolute URL, which
        // the Graph client accepts as a path.
        const initial = options?.cursor ?? `${containerApiPath()}/children`;
        let req = client.api(initial);
        if (!options?.cursor && options?.limit !== undefined) {
          req = req.top(options.limit);
        }
        const res = (await req.get()) as {
          value?: DriveItem[];
          ["@odata.nextLink"]?: string;
        };
        const items: StoredFile[] = [];
        for (const item of res.value ?? []) {
          if (item.folder) {
            continue;
          }
          const name = item.name ?? "";
          const key = rootFolderPath ? name : name;
          if (options?.prefix && !key.startsWith(options.prefix)) {
            continue;
          }
          const m = itemToStoredMeta(item);
          items.push(
            createStoredFile(
              { key, ...m },
              { factory: lazyDownload(key), kind: "lazy" }
            )
          );
        }
        const cursor = res["@odata.nextLink"];
        return { items, ...(cursor && { cursor }) };
      } catch (error) {
        throw mapGraphError(error);
      }
    },
    name: "onedrive",
    raw: client,
    rootFolderPath,
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      try {
        const res = (await client
          .api(`${itemApiPath(key)}/createUploadSession`)
          .post({
            item: {
              "@microsoft.graph.conflictBehavior": "replace",
              name: basename(key),
            },
          })) as { uploadUrl?: string };
        const { uploadUrl } = res;
        if (!uploadUrl) {
          throw new FilesError(
            "Provider",
            "onedrive: createUploadSession response missing uploadUrl"
          );
        }
        return {
          method: "PUT",
          url: uploadUrl,
          ...(signOpts.contentType && {
            headers: { "Content-Type": signOpts.contentType },
          }),
        };
      } catch (error) {
        throw mapGraphError(error);
      }
    },
    async upload(key, body, options): Promise<UploadResult> {
      if (options?.metadata && Object.keys(options.metadata).length > 0) {
        throw new FilesError(
          "Provider",
          "onedrive: `metadata` is not supported. Drive items have no native arbitrary-metadata field; use `raw` to set Open Extensions if you need it."
        );
      }
      if (options?.cacheControl) {
        throw new FilesError(
          "Provider",
          "onedrive: `cacheControl` is not supported. Graph does not expose HTTP cache headers on drive items."
        );
      }
      try {
        const normalized = await normalizeBody(body, options?.contentType);
        if (normalized.data.byteLength > SIMPLE_UPLOAD_LIMIT_BYTES) {
          throw new FilesError(
            "Provider",
            `onedrive: upload exceeds the ${SIMPLE_UPLOAD_LIMIT_BYTES}-byte simple-upload limit. Use signedUploadUrl() (chunked upload session) or raw client for large files.`
          );
        }
        const item = (await client
          .api(`${itemApiPath(key)}/content`)
          .header("Content-Type", normalized.contentType)
          .put(normalized.data)) as DriveItem;
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
          size: normalized.data.byteLength,
        };
      } catch (error) {
        throw mapGraphError(error);
      }
    },
    async url(key, urlOpts) {
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "onedrive: `responseContentDisposition` is not supported. Graph has no Content-Disposition override for share links or downloadUrl."
        );
      }
      if (!publicByDefault) {
        throw new FilesError(
          "Provider",
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
