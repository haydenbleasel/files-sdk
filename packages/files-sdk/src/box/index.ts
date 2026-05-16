import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import {
  BoxCcgAuth,
  BoxClient,
  BoxDeveloperTokenAuth,
  BoxJwtAuth,
  BoxOAuth,
  CcgConfig,
  JwtConfig,
  OAuthConfig,
} from "box-typescript-sdk-gen";

import type {
  Adapter,
  Body,
  ListResult,
  SignedUpload,
  StoredFile,
  UploadOptions,
  UploadResult,
} from "../index.js";
import {
  deleteManyWithFallback,
  DEFAULT_URL_EXPIRES_IN,
  existsByProbe,
  joinPublicUrl,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import type { FilesErrorCode } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface BoxOAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * A long-lived refresh token previously obtained via Box's authorization
   * code flow. The adapter seeds the auth's token storage with this value;
   * the SDK then exchanges it for a fresh access token on the first API call
   * and re-refreshes when the access token expires.
   */
  readonly refreshToken: string;
}

export interface BoxCcgOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Pass `enterpriseId` to authenticate as the service account, or `userId`
   * to authenticate as a managed/app user. At least one is required.
   */
  readonly enterpriseId?: string;
  readonly userId?: string;
}

export type BoxJwtOptions =
  | { readonly configJsonString: string }
  | { readonly configFilePath: string };

export interface BoxAdapterOptions {
  /**
   * Logical "bucket root" — virtual keys live under this Box folder ID.
   * Use `"0"` (the default) to anchor at the user's root folder. The folder
   * must already exist; intermediate subfolders are auto-created on upload.
   */
  rootFolderId?: string;
  /**
   * When `true`, `upload()` also creates a public shared link (anyone with
   * the link can preview/download) and `url()` returns that link's
   * `download_url` (or `url` if `download_url` is absent — typical for
   * non-binary previews). When `false` (default), `url()` mints a
   * short-lived signed download URL via `getDownloadFileUrl`.
   *
   * **Plan/policy note:** public shared links may be restricted on Box
   * Business or Enterprise plans; the adapter surfaces Box's
   * `access_denied_insufficient_permissions` error unmodified in that case.
   */
  publicByDefault?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips both signing and shared-link
   * resolution. Useful when a CDN or vanity domain sits in front of
   * pre-shared Box links.
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, used when `url()` mints a signed download
   * URL via `getDownloadFileUrl`. Box does not document a hard maximum
   * for these URLs (they are short-lived by API design); the adapter
   * passes the value through. Defaults to 3600.
   */
  defaultUrlExpiresIn?: number;
  /**
   * Pre-built `BoxClient` — escape hatch for callers that already wire
   * auth themselves (e.g. with custom `NetworkSession`, proxy config, or
   * downscoped tokens).
   */
  client?: BoxClient;
  /**
   * Static developer token from the Box developer console. Useful for
   * scripts and trying the adapter; production apps should use OAuth, CCG,
   * or JWT instead. Falls back to env `BOX_DEVELOPER_TOKEN`.
   */
  developerToken?: string;
  /** OAuth2 user-app flow seeded with a refresh token. */
  oauth?: BoxOAuthOptions;
  /** Server-side Client Credentials Grant. */
  ccg?: BoxCcgOptions;
  /** JWT Server Authentication, configured via the JSON blob from Box's developer console. */
  jwt?: BoxJwtOptions;
}

export type { BoxClient };
export type BoxAdapter = Adapter<BoxClient> & {
  readonly rootFolderId: string;
};

const DEFAULT_ROOT_FOLDER_ID = "0";
const SIMPLE_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

const NOT_FOUND_CODES = new Set([
  "not_found",
  "file_not_found",
  "folder_not_found",
  "trashed",
]);
const UNAUTH_CODES = new Set([
  "unauthorized",
  "access_denied_insufficient_permissions",
  "access_denied_item_locked",
  "forbidden_by_policy",
]);
const CONFLICT_CODES = new Set([
  "item_name_in_use",
  "item_name_invalid",
  "conflict",
  "operation_blocked_temporary",
  "name_temporarily_reserved",
]);

const DEFAULT_MESSAGES: Record<FilesErrorCode, string> = {
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: "Box error",
  Unauthorized: "Unauthorized",
};

interface BoxApiErrorLike {
  message?: string;
  responseInfo?: {
    statusCode?: number;
    code?: string;
    body?: { code?: string } | undefined;
  };
}

const isBoxApiErrorLike = (err: unknown): err is BoxApiErrorLike => {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const info = (err as { responseInfo?: unknown }).responseInfo;
  return typeof info === "object" && info !== null;
};

const classifyBox = (
  code: string | undefined,
  status: number | undefined
): FilesErrorCode => {
  if (code && NOT_FOUND_CODES.has(code)) {
    return "NotFound";
  }
  if (code && UNAUTH_CODES.has(code)) {
    return "Unauthorized";
  }
  if (code && CONFLICT_CODES.has(code)) {
    return "Conflict";
  }
  if (status === 404) {
    return "NotFound";
  }
  if (status === 401 || status === 403) {
    return "Unauthorized";
  }
  if (status === 409 || status === 412) {
    return "Conflict";
  }
  return "Provider";
};

export const mapBoxError = (err: unknown): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  if (isBoxApiErrorLike(err)) {
    const status = err.responseInfo?.statusCode;
    const code = err.responseInfo?.code ?? err.responseInfo?.body?.code;
    const errorCode = classifyBox(code, status);
    // Use `||` (not `??`) so empty-string messages also fall back — an
    // empty message offers callers nothing useful.
    return new FilesError(
      errorCode,
      err.message || DEFAULT_MESSAGES[errorCode],
      err
    );
  }
  const e = err as { message?: string } | null;
  return new FilesError(
    "Provider",
    e?.message || DEFAULT_MESSAGES.Provider,
    err
  );
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

const splitKey = (
  key: string
): { parents: readonly string[]; leaf: string } => {
  const trimmed = trimSlashes(key);
  if (!trimmed) {
    throw new FilesError("Provider", "box: key must not be empty");
  }
  const parts = trimmed.split("/").filter((p) => p.length > 0);
  const leaf = parts.pop() ?? "";
  if (!leaf) {
    throw new FilesError(
      "Provider",
      `box: key "${key}" has no file name segment`
    );
  }
  return { leaf, parents: parts };
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

const TYPE_BY_EXT: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  mjs: "text/javascript; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  xml: "application/xml",
  zip: "application/zip",
};

const inferTypeFromName = (name: string): string => {
  const idx = name.lastIndexOf(".");
  if (idx === -1) {
    return "application/octet-stream";
  }
  const ext = name.slice(idx + 1).toLowerCase();
  return TYPE_BY_EXT[ext] ?? "application/octet-stream";
};

interface BoxFileLike {
  id?: string;
  name?: string;
  size?: number;
  etag?: string | null;
  modifiedAt?: string;
  contentModifiedAt?: string | null;
  sharedLink?: { url?: string; downloadUrl?: string | null } | undefined;
}

interface FileMeta {
  size: number;
  type: string;
  etag?: string;
  lastModified?: number;
}

const fileMetaFromBox = (item: BoxFileLike): FileMeta => {
  const ts = item.modifiedAt ?? item.contentModifiedAt;
  const ms = ts ? new Date(ts).getTime() : undefined;
  const meta: FileMeta = {
    size: item.size ?? 0,
    type: inferTypeFromName(item.name ?? ""),
  };
  if (item.etag !== null && item.etag !== undefined && item.etag !== "") {
    meta.etag = item.etag;
  }
  if (ms !== undefined && Number.isFinite(ms)) {
    meta.lastModified = ms;
  }
  return meta;
};

interface AuthHandle {
  ensureReady(): Promise<void>;
}

const noopAuthHandle: AuthHandle = {
  ensureReady: () => Promise.resolve(),
};

interface ResolvedAuth {
  client: BoxClient;
  authHandle: AuthHandle;
}

const countAuthMethods = (opts: BoxAdapterOptions): number =>
  [opts.developerToken, opts.oauth, opts.ccg, opts.jwt].filter(
    (v) => v !== undefined
  ).length;

const buildJwtConfig = (jwt: BoxJwtOptions): JwtConfig => {
  if ("configJsonString" in jwt) {
    return JwtConfig.fromConfigJsonString(jwt.configJsonString);
  }
  return JwtConfig.fromConfigFile(jwt.configFilePath);
};

const resolveAuth = (opts: BoxAdapterOptions): ResolvedAuth => {
  if (opts.client) {
    return { authHandle: noopAuthHandle, client: opts.client };
  }

  const explicit = countAuthMethods(opts);
  if (explicit > 1) {
    throw new FilesError(
      "Provider",
      "box adapter: pass exactly one of `developerToken`, `oauth`, `ccg`, or `jwt`."
    );
  }

  if (opts.developerToken !== undefined) {
    const auth = new BoxDeveloperTokenAuth({ token: opts.developerToken });
    return { authHandle: noopAuthHandle, client: new BoxClient({ auth }) };
  }

  if (opts.oauth) {
    const { clientId, clientSecret, refreshToken } = opts.oauth;
    const config = new OAuthConfig({ clientId, clientSecret });
    const auth = new BoxOAuth({ config });
    // Seed the SDK's in-memory token storage with the refresh token.
    // The first API call sees an empty access token, gets a 401, and the
    // SDK's interceptor refreshes using this refresh token. The seed call
    // is deferred to first use and cached so we don't store on every call.
    let seeded: Promise<void> | undefined;
    const seed = async (): Promise<void> => {
      await auth.tokenStorage.store({ accessToken: "", refreshToken });
    };
    const handle: AuthHandle = {
      ensureReady: () => {
        if (!seeded) {
          seeded = seed();
        }
        return seeded;
      },
    };
    return { authHandle: handle, client: new BoxClient({ auth }) };
  }

  if (opts.ccg) {
    const { clientId, clientSecret, enterpriseId, userId } = opts.ccg;
    if (!enterpriseId && !userId) {
      throw new FilesError(
        "Provider",
        "box adapter: ccg auth requires either `enterpriseId` or `userId`."
      );
    }
    const config = new CcgConfig({
      clientId,
      clientSecret,
      ...(enterpriseId !== undefined && { enterpriseId }),
      ...(userId !== undefined && { userId }),
    });
    const auth = new BoxCcgAuth({ config });
    return { authHandle: noopAuthHandle, client: new BoxClient({ auth }) };
  }

  if (opts.jwt) {
    const config = buildJwtConfig(opts.jwt);
    const auth = new BoxJwtAuth({ config });
    return { authHandle: noopAuthHandle, client: new BoxClient({ auth }) };
  }

  const envDeveloperToken = readEnv("BOX_DEVELOPER_TOKEN");
  if (envDeveloperToken) {
    const auth = new BoxDeveloperTokenAuth({ token: envDeveloperToken });
    return { authHandle: noopAuthHandle, client: new BoxClient({ auth }) };
  }

  throw new FilesError(
    "Provider",
    "box adapter: missing auth. Pass `client`, `developerToken`, `oauth`, `ccg`, or `jwt`. Env fallback: BOX_DEVELOPER_TOKEN."
  );
};

const bufferToReadable = (buf: Buffer): Readable => Readable.from(buf);

const folderCacheKey = (parents: readonly string[]): string =>
  parents.join("/");

export const box = (opts: BoxAdapterOptions = {}): BoxAdapter => {
  const rootFolderId = opts.rootFolderId ?? DEFAULT_ROOT_FOLDER_ID;
  const publicByDefault = opts.publicByDefault ?? false;
  const { publicBaseUrl } = opts;
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

  const { client, authHandle } = resolveAuth(opts);

  // Per-instance caches for path → ID lookups. Box file/folder IDs are
  // stable; on a 404 the resolver drops the entry so subsequent calls
  // re-walk and pick up out-of-band moves.
  const folderIdCache = new Map<string, string>();
  const fileIdCache = new Map<string, string>();

  const findChildByName = async (
    folderId: string,
    name: string
  ): Promise<
    { type: "file" | "folder" | "web_link"; id: string } | undefined
  > => {
    let offset = 0;
    const limit = 1000;
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- pagination is sequential by API design.
      const page = await client.folders.getFolderItems(folderId, {
        queryParams: {
          fields: ["id", "name", "type"],
          limit,
          offset,
        },
      });
      const entries = page.entries ?? [];
      for (const entry of entries) {
        const e = entry as { id?: string; name?: string; type?: string };
        if (e.name === name && e.id && e.type) {
          return {
            id: e.id,
            type: e.type as "file" | "folder" | "web_link",
          };
        }
      }
      if (entries.length < limit) {
        return;
      }
      offset += entries.length;
    }
  };

  const resolveFolderId = async (
    parents: readonly string[],
    options: { create: boolean }
  ): Promise<string> => {
    if (parents.length === 0) {
      return rootFolderId;
    }
    const cacheKey = folderCacheKey(parents);
    const cached = folderIdCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    let currentId = rootFolderId;
    const walked: string[] = [];
    for (const segment of parents) {
      walked.push(segment);
      const partialKey = folderCacheKey(walked);
      const partialCached = folderIdCache.get(partialKey);
      if (partialCached) {
        currentId = partialCached;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- folder walk must be sequential.
      const child = await findChildByName(currentId, segment);
      if (child && child.type === "folder") {
        currentId = child.id;
        folderIdCache.set(partialKey, currentId);
        continue;
      }
      if (child && child.type !== "folder") {
        throw new FilesError(
          "Conflict",
          `box: path segment "${segment}" exists but is not a folder`
        );
      }
      if (!options.create) {
        throw new FilesError(
          "NotFound",
          `box: folder "${walked.join("/")}" not found`
        );
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- folder creation must be sequential.
        const created = await client.folders.createFolder({
          name: segment,
          parent: { id: currentId },
        });
        if (!created.id) {
          throw new FilesError(
            "Provider",
            `box: createFolder did not return an id for "${segment}"`
          );
        }
        currentId = created.id;
        folderIdCache.set(partialKey, currentId);
      } catch (error) {
        const mapped = mapBoxError(error);
        // Race: another writer created the folder between findChild and
        // createFolder. Re-resolve from the parent and continue.
        if (mapped.code === "Conflict") {
          // eslint-disable-next-line no-await-in-loop -- recovery path.
          const existing = await findChildByName(currentId, segment);
          if (existing && existing.type === "folder") {
            currentId = existing.id;
            folderIdCache.set(partialKey, currentId);
            continue;
          }
        }
        throw mapped;
      }
    }
    folderIdCache.set(cacheKey, currentId);
    return currentId;
  };

  const resolveFileId = async (key: string): Promise<string> => {
    const cached = fileIdCache.get(key);
    if (cached) {
      return cached;
    }
    const { parents, leaf } = splitKey(key);
    const folderId = await resolveFolderId(parents, { create: false });
    const child = await findChildByName(folderId, leaf);
    if (!child || child.type !== "file") {
      throw new FilesError("NotFound", `box: file "${key}" not found`);
    }
    fileIdCache.set(key, child.id);
    return child.id;
  };

  const dropFileFromCache = (key: string): void => {
    fileIdCache.delete(key);
  };

  const lazyDownload = (key: string) => async (): Promise<Uint8Array> => {
    await authHandle.ensureReady();
    const fileId = await resolveFileId(key);
    const url = await client.downloads.getDownloadFileUrl(fileId);
    const res = await fetch(url);
    if (!res.ok) {
      throw new FilesError(
        "Provider",
        `box: download fetch failed (${res.status})`
      );
    }
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  };

  const fetchSharedLinkUrl = async (fileId: string): Promise<string> => {
    const file = await client.sharedLinksFiles.getSharedLinkForFile(fileId, {
      fields: "shared_link",
    });
    const link = (file as BoxFileLike).sharedLink;
    const out = link?.downloadUrl ?? link?.url;
    if (!out) {
      throw new FilesError(
        "Provider",
        "box: file has no shared link to return. Call upload() with publicByDefault: true, or addShareLinkToFile via raw."
      );
    }
    return out;
  };

  const ensureSharedLink = async (fileId: string): Promise<string> => {
    try {
      const file = await client.sharedLinksFiles.addShareLinkToFile(
        fileId,
        { sharedLink: { access: "open" } },
        { fields: "shared_link" }
      );
      const link = (file as BoxFileLike).sharedLink;
      const out = link?.downloadUrl ?? link?.url;
      if (!out) {
        // Box returned the file but no link payload — fall through to a
        // fresh fetch in case the shared_link field was filtered out.
        return await fetchSharedLinkUrl(fileId);
      }
      return out;
    } catch (error) {
      const mapped = mapBoxError(error);
      // Idempotent: if a shared link already exists, reuse it.
      if (mapped.code === "Conflict") {
        return await fetchSharedLinkUrl(fileId);
      }
      throw mapped;
    }
  };

  // Resolve an existing file ID at `folderId/leaf` for overwrite-on-upload,
  // or return undefined when the leaf is new. Throws Conflict if the leaf
  // exists as a non-file.
  const resolveExistingFileForUpload = async (
    key: string,
    folderId: string,
    leaf: string
  ): Promise<string | undefined> => {
    const cachedId = fileIdCache.get(key);
    if (cachedId) {
      return cachedId;
    }
    const existing = await findChildByName(folderId, leaf);
    if (!existing) {
      return;
    }
    if (existing.type === "file") {
      fileIdCache.set(key, existing.id);
      return existing.id;
    }
    throw new FilesError(
      "Conflict",
      `box: "${key}" already exists as a non-file (${existing.type})`
    );
  };

  const performUpload = async (
    fileId: string | undefined,
    folderId: string,
    leaf: string,
    data: Buffer
  ): Promise<BoxFileLike> => {
    if (data.byteLength > SIMPLE_UPLOAD_LIMIT_BYTES) {
      return (await client.chunkedUploads.uploadBigFile(
        bufferToReadable(data),
        leaf,
        data.byteLength,
        folderId
      )) as BoxFileLike;
    }
    if (fileId) {
      const res = await client.uploads.uploadFileVersion(fileId, {
        attributes: { name: leaf },
        file: bufferToReadable(data),
      });
      const entry = (res.entries ?? [])[0] as BoxFileLike | undefined;
      if (!entry) {
        throw new FilesError(
          "Provider",
          "box: uploadFileVersion returned no file"
        );
      }
      return entry;
    }
    const res = await client.uploads.uploadFile({
      attributes: { name: leaf, parent: { id: folderId } },
      file: bufferToReadable(data),
    });
    const entry = (res.entries ?? [])[0] as BoxFileLike | undefined;
    if (!entry) {
      throw new FilesError("Provider", "box: uploadFile returned no file");
    }
    return entry;
  };

  const runUpload = async (
    key: string,
    body: Body,
    options?: UploadOptions
  ): Promise<UploadResult> => {
    if (options?.metadata && Object.keys(options.metadata).length > 0) {
      throw new FilesError(
        "Provider",
        "box: `metadata` is not supported on the unified API. Box exposes file metadata via classifications and metadata templates; use `raw` with `client.fileMetadata.*` if you need it."
      );
    }
    if (options?.cacheControl) {
      throw new FilesError(
        "Provider",
        "box: `cacheControl` is not supported. Box does not expose HTTP cache headers on file content."
      );
    }
    try {
      await authHandle.ensureReady();
      const normalized = await normalizeBody(body, options?.contentType);
      const { parents, leaf } = splitKey(key);
      const folderId = await resolveFolderId(parents, { create: true });
      const fileId = await resolveExistingFileForUpload(key, folderId, leaf);
      const item = await performUpload(fileId, folderId, leaf, normalized.data);

      if (item.id) {
        fileIdCache.set(key, item.id);
        if (publicByDefault) {
          await ensureSharedLink(item.id);
        }
      }

      const meta = fileMetaFromBox(item);
      const size = normalized.data.byteLength;
      return {
        contentType: normalized.contentType,
        ...(meta.etag && { etag: meta.etag }),
        key,
        ...(meta.lastModified !== undefined && {
          lastModified: meta.lastModified,
        }),
        size,
      };
    } catch (error) {
      throw mapBoxError(error);
    }
  };

  const adapter: BoxAdapter = {
    async copy(from, to) {
      try {
        await authHandle.ensureReady();
        const sourceId = await resolveFileId(from);
        const { parents, leaf } = splitKey(to);
        const destFolderId = await resolveFolderId(parents, { create: true });
        const created = await client.files.copyFile(sourceId, {
          name: leaf,
          parent: { id: destFolderId },
        });
        if (created.id) {
          fileIdCache.set(to, created.id);
        }
      } catch (error) {
        throw mapBoxError(error);
      }
    },
    async delete(key) {
      try {
        await authHandle.ensureReady();
        let fileId: string;
        try {
          fileId = await resolveFileId(key);
        } catch (error) {
          const mapped = mapBoxError(error);
          if (mapped.code === "NotFound") {
            return;
          }
          throw mapped;
        }
        try {
          await client.files.deleteFileById(fileId);
        } catch (error) {
          const mapped = mapBoxError(error);
          if (mapped.code === "NotFound") {
            dropFileFromCache(key);
            return;
          }
          throw mapped;
        }
        dropFileFromCache(key);
      } catch (error) {
        throw mapBoxError(error);
      }
    },
    deleteMany(keys, deleteOpts) {
      return deleteManyWithFallback(
        keys,
        (key) => adapter.delete(key),
        deleteOpts,
        mapBoxError
      );
    },
    async download(key, downloadOpts) {
      try {
        await authHandle.ensureReady();
        const fileId = await resolveFileId(key);
        const file = (await client.files.getFileById(fileId)) as BoxFileLike;
        const meta = fileMetaFromBox(file);

        if (downloadOpts?.as === "stream") {
          const url = await client.downloads.getDownloadFileUrl(fileId);
          const res = await fetch(url);
          if (!res.ok || !res.body) {
            throw new FilesError(
              "Provider",
              `box: download fetch failed (${res.status})`
            );
          }
          const stream = res.body as ReadableStream<Uint8Array>;
          return createStoredFile(
            { key, ...meta },
            { factory: () => stream, kind: "stream" }
          );
        }

        const url = await client.downloads.getDownloadFileUrl(fileId);
        const res = await fetch(url);
        if (!res.ok) {
          throw new FilesError(
            "Provider",
            `box: download fetch failed (${res.status})`
          );
        }
        const ab = await res.arrayBuffer();
        const bytes = new Uint8Array(ab);
        return createStoredFile(
          { key, ...meta, size: bytes.byteLength },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapBoxError(error);
      }
    },
    exists(key) {
      return existsByProbe(async () => {
        await authHandle.ensureReady();
        const fileId = await resolveFileId(key);
        await client.files.getFileById(fileId, {
          queryParams: { fields: ["id"] },
        });
      }, mapBoxError);
    },
    async head(key) {
      try {
        await authHandle.ensureReady();
        const fileId = await resolveFileId(key);
        const file = (await client.files.getFileById(fileId)) as BoxFileLike;
        const meta = fileMetaFromBox(file);
        return createStoredFile(
          { key, ...meta },
          { factory: lazyDownload(key), kind: "lazy" }
        );
      } catch (error) {
        throw mapBoxError(error);
      }
    },
    async list(options): Promise<ListResult> {
      try {
        await authHandle.ensureReady();
        const limit = options?.limit ?? 1000;
        const offset = options?.cursor
          ? Number.parseInt(options.cursor, 10)
          : 0;
        if (Number.isNaN(offset) || offset < 0) {
          throw new FilesError(
            "Provider",
            `box: invalid list cursor "${options?.cursor}"`
          );
        }

        // Walk only the configured root folder, paginated. Subfolders are
        // not recursed — Box's flat folder list is what we expose, with
        // `prefix` matched against the immediate child's name. Callers who
        // want deep enumeration should iterate folders themselves via
        // `adapter.raw`.
        const page = await client.folders.getFolderItems(rootFolderId, {
          queryParams: {
            fields: ["id", "name", "size", "modified_at", "etag", "type"],
            limit,
            offset,
          },
        });
        const entries = page.entries ?? [];
        const items: StoredFile[] = [];
        for (const entry of entries) {
          const e = entry as BoxFileLike & { type?: string };
          if (e.type !== "file" || !e.id || !e.name) {
            continue;
          }
          if (options?.prefix && !e.name.startsWith(options.prefix)) {
            continue;
          }
          fileIdCache.set(e.name, e.id);
          const meta = fileMetaFromBox(e);
          items.push(
            createStoredFile(
              { key: e.name, ...meta },
              { factory: lazyDownload(e.name), kind: "lazy" }
            )
          );
        }

        const nextOffset = offset + entries.length;
        const total = page.totalCount;
        const hasMore =
          entries.length === limit &&
          (total === undefined || nextOffset < total);
        return {
          items,
          ...(hasMore && { cursor: String(nextOffset) }),
        };
      } catch (error) {
        throw mapBoxError(error);
      }
    },
    name: "box",
    raw: client,
    rootFolderId,
    signedUploadUrl(_key, _signOpts): Promise<SignedUpload> {
      // Box's upload URL (`/files/content` against a session) requires a
      // multipart POST with both an `attributes` JSON part and the file
      // bytes part — neither the PUT-with-raw-body nor S3-style
      // POST-with-form-fields shapes in our `SignedUpload` contract fit.
      // Throw rather than mint a URL whose method our contract
      // misrepresents.
      return Promise.reject(
        new FilesError(
          "Provider",
          "box: signedUploadUrl is not supported. Box uploads require a multipart POST with an `attributes` JSON part; this doesn't fit the SDK's PUT/POST-form contract. Use upload() server-side, or the Box UI Elements / Box Content Uploader for browser flows."
        )
      );
    },
    upload(key, body, options): Promise<UploadResult> {
      return runUpload(key, body, options);
    },
    async url(key, urlOpts) {
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "box: `responseContentDisposition` is not supported. Box's getDownloadFileUrl and shared-link URLs have no Content-Disposition override."
        );
      }
      if (publicBaseUrl) {
        return joinPublicUrl(publicBaseUrl, key);
      }
      try {
        await authHandle.ensureReady();
        const fileId = await resolveFileId(key);
        if (publicByDefault) {
          return await ensureSharedLink(fileId);
        }
        const expiresIn = urlOpts?.expiresIn ?? defaultUrlExpiresIn;
        // The SDK's `getDownloadFileUrl` doesn't take an expiry — Box
        // controls the URL's TTL server-side. The expiresIn parameter is
        // accepted for API symmetry but the actual lifetime is whatever
        // Box returns.
        void expiresIn;
        return await client.downloads.getDownloadFileUrl(fileId);
      } catch (error) {
        throw mapBoxError(error);
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
