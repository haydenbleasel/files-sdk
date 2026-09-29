import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
  OffsetResumableDriver,
  ResumableUploadSession,
  SignedUpload,
  StoredFile,
  UploadOptions,
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
import { isObject, isString } from "../internal/is.js";
import { inferTypeFromName } from "../internal/mime.js";
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
   * Default expiry, in seconds, for the signed download URLs `url()` mints
   * via `getDownloadFileUrl`. Accepted for API symmetry but not honoured:
   * `getDownloadFileUrl` takes no expiry, so Box controls the TTL
   * server-side (the URLs are short-lived by API design). Defaults to 3600.
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

export type { BoxClient } from "box-typescript-sdk-gen";
export type BoxAdapter = Adapter<BoxClient> & {
  readonly rootFolderId: string;
};

const DEFAULT_ROOT_FOLDER_ID = "0";
const OCTET_STREAM = "application/octet-stream";
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
  // OAuth token-endpoint rejections (a revoked refresh token, a bad client
  // secret or JWT key) arrive as a 400 carrying an RFC 6749 `error`.
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
]);
const CONFLICT_CODES = new Set([
  "item_name_in_use",
  "item_name_invalid",
  "conflict",
  "operation_blocked_temporary",
  "name_temporarily_reserved",
]);

const DEFAULT_MESSAGES: Record<ProviderFilesErrorCode, string> = {
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
    body?: { code?: unknown; error?: unknown } | undefined;
  };
}

const isBoxApiErrorLike = (err: unknown): err is BoxApiErrorLike =>
  isObject(err) && "responseInfo" in err && isObject(err.responseInfo);

// The SDK's ESM build — what an `import` resolves to — declares `responseInfo`
// as a class field, which resets it to `undefined` right after the base
// constructor assigns it. A real BoxApiError then carries only its message,
// which the SDK formats as `<status> <message>; Request ID: <id>`, so recover
// the HTTP status from there.
const strippedApiErrorStatus = (cause: unknown): number | undefined => {
  if (
    !(isObject(cause) && "name" in cause && cause.name === "BoxApiError") ||
    !("message" in cause && isString(cause.message))
  ) {
    return;
  }
  const status = /^(?<status>[1-5]\d{2}) /u.exec(cause.message)?.groups?.status;
  return status === undefined ? undefined : Number(status);
};

const classifyBox = (
  code: string | undefined,
  status: number | undefined
): ProviderFilesErrorCode => {
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

export const mapBoxError = (cause: unknown): FilesError => {
  if (cause instanceof FilesError) {
    return cause;
  }
  if (isBoxApiErrorLike(cause)) {
    const status = cause.responseInfo?.statusCode;
    // The SDK stores the body's `code` JSON-encoded in `responseInfo.code`
    // (`"\"not_found\""`), so read the raw one from the parsed body first; an
    // OAuth token-endpoint failure has an `error` there instead.
    const { body } = cause.responseInfo ?? {};
    const code = [body?.code, body?.error, cause.responseInfo?.code].find(
      isString
    );
    const errorCode = classifyBox(code, status);
    // Use `||` (not `??`) so empty-string messages also fall back — an
    // empty message offers callers nothing useful.
    return new FilesError(
      errorCode,
      cause.message || DEFAULT_MESSAGES[errorCode],
      cause
    );
  }
  const message =
    isObject(cause) && "message" in cause && isString(cause.message)
      ? cause.message
      : undefined;
  const errorCode = classifyBox(undefined, strippedApiErrorStatus(cause));
  return new FilesError(
    errorCode,
    message || DEFAULT_MESSAGES[errorCode],
    cause
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

interface SplitKey {
  parents: readonly string[];
  leaf: string;
}

const splitKey = (key: string): SplitKey => {
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

// The SDK deserializes RFC 3339 timestamps into its `DateTime` wrapper
// (`{ value: Date }`); hand-built items (and older SDKs) carry the string.
interface BoxDateTime {
  readonly value: Date;
}

// The subset of the SDK's `FileFull` (and, for folder listings, `FolderMini` /
// `WebLink`) the adapter reads. Every SDK item type is assignable to it.
interface BoxFileLike {
  id?: string;
  name?: string;
  size?: number;
  etag?: string | null;
  modifiedAt?: string | BoxDateTime | null;
  contentModifiedAt?: string | BoxDateTime | null;
  sharedLink?: { url?: string; downloadUrl?: string | null } | null;
}

interface FileMeta {
  size: number;
  type: string;
  etag?: string;
  lastModified?: number;
}

const fileMetaFromBox = (item: BoxFileLike): FileMeta => {
  const raw = item.modifiedAt ?? item.contentModifiedAt;
  const ts = isString(raw) ? raw : raw?.value;
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
  ensureReady: () => Promise<void>;
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

type BoxUploadPart = NonNullable<
  Awaited<ReturnType<BoxClient["chunkedUploads"]["uploadFilePart"]>>["part"]
>;

// Box's chunked-upload digests: RFC 3230 `sha=<base64 SHA-1>`.
const sha1Digest = (data: Buffer): string =>
  `sha=${createHash("sha1").update(data).digest("base64")}`;

// Chunked re-upload of an EXISTING file as a new version. The SDK's
// `uploadBigFile` helper always opens a new-file session, so re-uploading a
// key that already exists 409s with `item_name_in_use` instead of versioning
// it. Mirror the helper's loop over an existing-file session instead: open the
// session, upload each `partSize` slice with its digest + content range, then
// commit with the whole-file digest.
const uploadBigFileVersion = async (
  client: BoxClient,
  fileId: string,
  leaf: string,
  data: Buffer
): Promise<BoxFileLike> => {
  const session =
    await client.chunkedUploads.createFileUploadSessionForExistingFile(fileId, {
      fileName: leaf,
      fileSize: data.byteLength,
    });
  const { id: sessionId, partSize } = session;
  if (!(sessionId && partSize)) {
    throw new FilesError(
      "Provider",
      "box: upload session for existing file returned no id/partSize"
    );
  }
  const parts: BoxUploadPart[] = [];
  for (let offset = 0; offset < data.byteLength; offset += partSize) {
    const chunk = data.subarray(
      offset,
      Math.min(offset + partSize, data.byteLength)
    );
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Box parts are uploaded in order; each slice is a bounded sequential request like the SDK's own reducer
    const uploaded = await client.chunkedUploads.uploadFilePart(
      sessionId,
      bufferToReadable(chunk),
      {
        contentRange: `bytes ${offset}-${offset + chunk.byteLength - 1}/${data.byteLength}`,
        digest: sha1Digest(chunk),
      }
    );
    if (!uploaded.part) {
      throw new FilesError("Provider", "box: uploadFilePart returned no part");
    }
    parts.push(uploaded.part);
  }
  const committed = await client.chunkedUploads.createFileUploadSessionCommit(
    sessionId,
    { parts },
    { digest: sha1Digest(data) }
  );
  const entry = committed?.entries?.[0];
  if (!entry) {
    throw new FilesError(
      "Provider",
      "box: upload session commit returned no file"
    );
  }
  return entry;
};

const folderCacheKey = (parents: readonly string[]): string =>
  parents.join("/");

// A folder child located by name: the SDK's item `type` discriminant + id.
interface ChildRef {
  type: "file" | "folder" | "web_link";
  id: string;
}

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

  // Folder listings page by marker, not offset: Box rejects an `offset`
  // above 10000 with a 400, so offset paging can't reach the rest of a
  // large folder.
  const findChildByName = async (
    folderId: string,
    name: string
  ): Promise<ChildRef | undefined> => {
    let marker: string | undefined;
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- pagination is sequential by API design.
      const page = await client.folders.getFolderItems(folderId, {
        queryParams: {
          fields: ["id", "name", "type"],
          limit: 1000,
          usemarker: true,
          ...(marker && { marker }),
        },
      });
      for (const entry of page.entries ?? []) {
        if (entry.name === name && entry.id && entry.type) {
          return { id: entry.id, type: entry.type };
        }
      }
      marker = page.nextMarker ?? undefined;
      if (!marker) {
        return;
      }
    }
  };

  const resolveFolderId = async (
    parents: readonly string[],
    options: { create: boolean }
    // oxlint-disable-next-line sonarjs/cognitive-complexity -- sequential folder-walk with per-segment cache hits, conflict/create branches, and error mapping; the branches are cohesive and test-covered, splitting would scatter the walk state
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
    // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- the two continues (cache hit, found-folder) are distinct fast paths; folding them would obscure the walk
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

  // The lazy body behind head()/list() results runs after the operation has
  // returned, so it maps its own failures (a file deleted in between reads as
  // NotFound) instead of leaking a raw SDK error out of `text()`.
  const lazyDownload = (key: string) => async (): Promise<Uint8Array> => {
    try {
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
    } catch (error) {
      throw mapBoxError(error);
    }
  };

  const fetchSharedLinkUrl = async (fileId: string): Promise<string> => {
    const file = await client.sharedLinksFiles.getSharedLinkForFile(fileId, {
      fields: "shared_link",
    });
    const link = file.sharedLink;
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
      const link = file.sharedLink;
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
      if (fileId) {
        return await uploadBigFileVersion(client, fileId, leaf, data);
      }
      return await client.chunkedUploads.uploadBigFile(
        bufferToReadable(data),
        leaf,
        data.byteLength,
        folderId
      );
    }
    if (fileId) {
      const res = await client.uploads.uploadFileVersion(fileId, {
        attributes: { name: leaf },
        file: bufferToReadable(data),
      });
      const [entry] = res.entries ?? [];
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
    const [entry] = res.entries ?? [];
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
    // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
    // (this adapter advertises neither) — Box's unified API exposes no
    // arbitrary-metadata or cache-header field.
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

  // In-flight resumable uploads. Box's chunked-upload commit requires a
  // whole-file SHA-1 that can't be recomputed across a process boundary, so
  // resume is in-process only: chunks are buffered and uploaded in one call at
  // complete. A token from another process/instance is rejected by `adopt`.
  const pending = new Map<string, { chunks: Uint8Array[]; received: number }>();
  let uploadSeq = 0;

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
    async download(key, downloadOpts) {
      try {
        await authHandle.ensureReady();
        const fileId = await resolveFileId(key);
        const file = await client.files.getFileById(fileId);
        const meta = fileMetaFromBox(file);
        const range = downloadOpts?.range;

        // Both buffered and streaming reads go through the same standard-HTTP
        // download URL, so a single fetch (with the Range header when asked)
        // serves both.
        const url = await client.downloads.getDownloadFileUrl(fileId);
        const res = await fetch(url, {
          ...(downloadOpts?.signal && { signal: downloadOpts.signal }),
          ...(range && { headers: rangeRequestHeaders(range) }),
        });
        if (!res.ok) {
          throw new FilesError(
            "Provider",
            `box: download fetch failed (${res.status})`
          );
        }
        if (range) {
          assertRangeHonored(res.status, "box");
        }

        if (downloadOpts?.as === "stream") {
          if (!res.body) {
            throw new FilesError(
              "Provider",
              `box: download fetch failed (${res.status})`
            );
          }
          const stream = res.body;
          return createStoredFile(
            {
              key,
              ...meta,
              ...(range && {
                size: rangedResponseSize(
                  res.headers.get("content-length"),
                  meta.size,
                  range
                ),
              }),
            },
            { factory: () => stream, kind: "stream" }
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
        const file = await client.files.getFileById(fileId);
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
        const folded = options?.delimiter !== undefined;
        if (options?.delimiter) {
          assertSlashDelimiter("box", options.delimiter);
        }
        // List one folder, paginated by Box's opaque marker. Subfolders are
        // not recursed. The key prefix splits at its last "/": the part
        // before it names the folder to list (resolved under
        // `rootFolderId`), the rest is matched against the children's names,
        // so `photos/` lists the `photos` folder with full keys
        // (`photos/cover.jpg`). Callers who want deep enumeration should
        // iterate folders themselves via `adapter.raw`.
        const prefix = options?.prefix ?? "";
        const slash = prefix.lastIndexOf("/");
        const namePrefix = prefix.slice(slash + 1);
        const keyBase = slash === -1 ? "" : prefix.slice(0, slash + 1);
        let folderId: string;
        try {
          folderId = await resolveFolderId(
            keyBase.split("/").filter((part) => part.length > 0),
            { create: false }
          );
        } catch (error) {
          const mapped = mapBoxError(error);
          // A prefix into a folder that doesn't exist lists nothing.
          if (mapped.code === "NotFound") {
            return { items: [] };
          }
          throw mapped;
        }
        const page = await client.folders.getFolderItems(folderId, {
          queryParams: {
            fields: ["id", "name", "size", "modified_at", "etag", "type"],
            limit: options?.limit ?? 1000,
            usemarker: true,
            ...(options?.cursor && { marker: options.cursor }),
          },
        });
        const entries = page.entries ?? [];
        const items: StoredFile[] = [];
        const prefixes: string[] = [];
        // Classify one child into items (files) or prefixes (subfolders,
        // folded mode only); nested so the loop's branching stays out of
        // `list`.
        const collect = (entry: (typeof entries)[number]) => {
          if (!entry.name || !entry.name.startsWith(namePrefix)) {
            return;
          }
          const key = `${keyBase}${entry.name}`;
          if (folded && entry.type === "folder") {
            prefixes.push(`${key}/`);
            return;
          }
          if (entry.type !== "file" || !entry.id) {
            return;
          }
          fileIdCache.set(key, entry.id);
          items.push(
            createStoredFile(
              { key, ...fileMetaFromBox(entry) },
              { factory: lazyDownload(key), kind: "lazy" }
            )
          );
        };
        for (const entry of entries) {
          collect(entry);
        }

        const cursor = page.nextMarker;
        return {
          items,
          ...(cursor && { cursor }),
          ...(prefixes.length && { prefixes }),
        };
      } catch (error) {
        throw mapBoxError(error);
      }
    },
    name: "box",
    raw: client,
    resumableUpload(key, resumableOpts): OffsetResumableDriver {
      let uploadId: string | undefined;
      let contentType = OCTET_STREAM;
      const requirePending = () => {
        const entry =
          uploadId === undefined ? undefined : pending.get(uploadId);
        if (!entry) {
          throw new FilesError(
            "Provider",
            "box: resumable session not found — box uploads are in-process only (commit needs a whole-file digest) and can't resume in a new instance."
          );
        }
        return entry;
      };
      return {
        adopt(session: ResumableUploadSession) {
          if (session.provider !== "box") {
            throw new FilesError(
              "Provider",
              `Cannot resume a ${session.provider} session on a box adapter.`
            );
          }
          if (session.key !== key) {
            throw new FilesError(
              "Provider",
              "Resume token does not match this upload's key."
            );
          }
          ({ uploadId } = session);
          ({ contentType } = session);
        },
        begin(meta): Promise<ResumableUploadSession> {
          // `metadata` / `cacheControl` are rejected centrally by the Files
          // wrapper before a resumable upload ever reaches here.
          uploadSeq += 1;
          uploadId = `box-${uploadSeq}`;
          ({ contentType } = meta);
          pending.set(uploadId, { chunks: [], received: 0 });
          return Promise.resolve({
            contentType,
            key,
            provider: "box",
            uploadId,
          });
        },
        complete(): Promise<UploadResult> {
          const entry = requirePending();
          const bytes = new Uint8Array(entry.received);
          let offset = 0;
          for (const chunk of entry.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          // SAFETY: `requirePending()` above throws unless `uploadId` is set
          // and names a live entry.
          pending.delete(uploadId as string);
          return runUpload(key, bytes, { contentType });
        },
        discard() {
          if (uploadId !== undefined) {
            pending.delete(uploadId);
          }
          return Promise.resolve();
        },
        mode: "offset",
        partSize:
          isObject(resumableOpts.multipart) && resumableOpts.multipart.partSize
            ? resumableOpts.multipart.partSize
            : 8 * 1024 * 1024,
        probe(): Promise<{ nextOffset: number }> {
          return Promise.resolve({ nextOffset: requirePending().received });
        },
        uploadAt({ offset, data }): Promise<{ nextOffset: number }> {
          const entry = requirePending();
          entry.chunks.push(new Uint8Array(data));
          entry.received = offset + data.byteLength;
          return Promise.resolve({ nextOffset: entry.received });
        },
      };
    },
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
    // By default `url()` returns a tokenized download URL: time-limited, but
    // Box controls the TTL server-side, so `expiresIn` is accepted and
    // ignored — see provider-gaps. Under `publicBaseUrl` / `publicByDefault`
    // it returns a permanent public link instead, which isn't signed.
    signedUrl: { supported: !(publicBaseUrl || publicByDefault) },
    supportsDelimiter: true,
    supportsRange: true,
    // `copy()` is a server-side `copyFile`.
    supportsServerSideCopy: true,
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
