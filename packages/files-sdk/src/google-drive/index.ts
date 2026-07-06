import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import { drive } from "@googleapis/drive";
import type { drive_v3 } from "@googleapis/drive";
import { GoogleAuth, JWT, OAuth2Client } from "google-auth-library";

import type {
  Adapter,
  Body,
  ListResult,
  OffsetResumableDriver,
  ResumableUploadSession,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  assertRangeHonored,
  existsByProbe,
  rangeRequestHeaders,
  rangedSize,
  resumableChunkSize,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import type { ProviderFilesErrorCode } from "../internal/errors.js";
import { createOffsetHttpDriver } from "../internal/resumable-offset-http.js";
import { trustedHttpsSessionUrl } from "../internal/resumable-session-url.js";
import { createStoredFile } from "../internal/stored-file.js";
import { compareKeys, paginateHierarchy } from "../internal/walk-paginate.js";

export interface GoogleDriveAdapterOptions {
  /**
   * Inline service-account credentials. Mints a `JWT` auth client with
   * `https://www.googleapis.com/auth/drive` scope. Mutually exclusive with
   * the other auth shapes.
   */
  credentials?: { client_email: string; private_key: string };
  /**
   * Path to a service-account JSON file. Mutually exclusive with the other
   * auth shapes.
   */
  keyFilename?: string;
  /**
   * OAuth refresh token (3-legged OAuth, end-user Drive). The adapter mints
   * fresh access tokens against `clientId`/`clientSecret`. Mutually
   * exclusive with the other auth shapes.
   */
  oauth?: { clientId: string; clientSecret: string; refreshToken: string };
  /**
   * Pre-built `@googleapis/drive` v3 client — escape hatch for callers that
   * have already wired auth (workload identity, ADC, etc.). When passed,
   * the adapter uses it directly. `signedUploadUrl()` requires an auth
   * handle to mint access tokens for the resumable session POST; if you
   * use this escape hatch, that method will throw because we can't
   * recover the underlying auth from the wrapped client in a stable way.
   */
  client?: drive_v3.Drive;
  /**
   * Domain-wide delegation subject (the user to impersonate). Only honored
   * with `credentials` or `keyFilename`.
   */
  subject?: string;
  /**
   * Shared Drive id. **Strongly recommended for service-account auth** —
   * service accounts have a 15 GB personal quota; production workloads
   * should target a Shared Drive with the service account added as a
   * member. When set, all queries scope to that Shared Drive.
   */
  driveId?: string;
  /**
   * Logical "bucket root" — virtual keys live under this folder. Defaults
   * to `"root"` (My Drive root) or, when `driveId` is set, the Shared
   * Drive root id should be used here.
   */
  rootFolderId?: string;
  /**
   * When `true`, `upload()` also creates an `anyone with link, reader`
   * permission and `url()` returns the Drive public download URL. When
   * `false` (default), `url()` throws — Drive has no signed URL primitive.
   *
   * Security note: this is public-by-default for the entire adapter
   * lifetime. If you need a mix of public and private files, instantiate
   * two `Files` instances or grant permissions explicitly via `raw`.
   */
  publicByDefault?: boolean;
  /**
   * LRU capacity for the in-memory virtual-key → fileId cache. Drive has
   * no native key field; every read after the first round-trips a
   * `files.list` to resolve the id, which the cache amortizes within a
   * single adapter instance. Defaults to 1024.
   */
  fileIdCacheSize?: number;
}

export type GoogleDriveClient = drive_v3.Drive;
export type GoogleDriveAdapter = Adapter<GoogleDriveClient> & {
  readonly rootFolderId: string;
};

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const OCTET_STREAM = "application/octet-stream";
const PROVIDER = "google-drive";
const DEFAULT_CACHE_SIZE = 1024;
const RESUMABLE_INITIATE_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true";
/**
 * Session initiation for a key that already has a file: a `PATCH` against
 * that fileId updates it in place. A `POST` (create) would strand a
 * duplicate carrying the same virtual key, wedging later reads on it with a
 * Conflict. `parents` is create-only, so the update body must omit it.
 */
const resumableUpdateUrl = (fileId: string): string =>
  `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=resumable&supportsAllDrives=true`;

// Reserved appProperties keys — used as the virtual-key index and to
// round-trip metadata Drive has no native field for. Caller metadata keys
// starting with `fsdk` are rejected at upload time to keep the namespace
// clean (see assertNoReservedMetadata).
const KEY_PROP = "fsdkKey";
const CONTENT_TYPE_PROP = "fsdkContentType";
const CACHE_CONTROL_PROP = "fsdkCacheControl";
const RESERVED_METADATA_PREFIX = "fsdk";

const FILE_FIELDS =
  "id, name, size, mimeType, md5Checksum, modifiedTime, appProperties";

const NOT_FOUND_STATUS = new Set([404]);
const UNAUTH_STATUS = new Set([401, 403]);
const CONFLICT_STATUS = new Set([409, 412]);

const classifyDriveError = (
  status: number | undefined
): ProviderFilesErrorCode => {
  if (NOT_FOUND_STATUS.has(status ?? 0)) {
    return "NotFound";
  }
  if (UNAUTH_STATUS.has(status ?? 0)) {
    return "Unauthorized";
  }
  if (CONFLICT_STATUS.has(status ?? 0)) {
    return "Conflict";
  }
  return "Provider";
};

const DEFAULT_MESSAGES: Record<ProviderFilesErrorCode, string> = {
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: "Drive error",
  Unauthorized: "Unauthorized",
};

export const mapDriveError = (err: unknown): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  const e = err as {
    code?: number | string;
    message?: string;
    status?: number;
    response?: { status?: number; data?: { error?: { message?: string } } };
  };
  let status: number | undefined;
  if (typeof e?.code === "number") {
    status = e.code;
  } else if (typeof e?.status === "number") {
    ({ status } = e);
  } else if (typeof e?.response?.status === "number") {
    ({ status } = e.response);
  }
  const errorCode = classifyDriveError(status);
  const message =
    e?.response?.data?.error?.message ??
    e?.message ??
    DEFAULT_MESSAGES[errorCode];
  return new FilesError(errorCode, message, err);
};

// Drive's `q` syntax: backslash escapes single quote.
const escapeQueryValue = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");

const basename = (key: string): string => {
  const idx = key.lastIndexOf("/");
  return idx === -1 ? key : key.slice(idx + 1);
};

const assertNoReservedMetadata = (
  metadata: Record<string, string> | undefined
): void => {
  if (!metadata) {
    return;
  }
  for (const k of Object.keys(metadata)) {
    if (k.startsWith(RESERVED_METADATA_PREFIX)) {
      throw new FilesError(
        "Provider",
        `google-drive: metadata key '${k}' is reserved (the '${RESERVED_METADATA_PREFIX}' prefix is used by the adapter for bookkeeping).`
      );
    }
  }
};

class LRU<V> {
  readonly #map = new Map<string, V>();
  readonly #cap: number;
  constructor(cap: number) {
    this.#cap = Math.max(1, cap);
  }
  get(key: string): V | undefined {
    const v = this.#map.get(key);
    if (v === undefined) {
      return undefined;
    }
    this.#map.delete(key);
    this.#map.set(key, v);
    return v;
  }
  set(key: string, value: V): void {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    }
    this.#map.set(key, value);
    if (this.#map.size > this.#cap) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) {
        this.#map.delete(oldest);
      }
    }
  }
  delete(key: string): void {
    this.#map.delete(key);
  }
}

interface NormalizedBody {
  stream: Readable;
  contentType: string;
  contentLength?: number;
}

const normalizeBody = async (
  body: Body,
  contentTypeHint?: string
): Promise<NormalizedBody> => {
  if (typeof body === "string") {
    const buf = Buffer.from(body, "utf-8");
    return {
      contentLength: buf.byteLength,
      contentType: contentTypeHint ?? "text/plain; charset=utf-8",
      stream: Readable.from(buf),
    };
  }
  if (body instanceof Uint8Array) {
    const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    return {
      contentLength: buf.byteLength,
      contentType: contentTypeHint ?? OCTET_STREAM,
      stream: Readable.from(buf),
    };
  }
  if (body instanceof ArrayBuffer) {
    const buf = Buffer.from(body);
    return {
      contentLength: buf.byteLength,
      contentType: contentTypeHint ?? OCTET_STREAM,
      stream: Readable.from(buf),
    };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    return {
      contentLength: buf.byteLength,
      contentType: contentTypeHint ?? OCTET_STREAM,
      stream: Readable.from(buf),
    };
  }
  if (body instanceof Blob) {
    const buf = Buffer.from(await body.arrayBuffer());
    return {
      contentLength: buf.byteLength,
      contentType: contentTypeHint ?? (body.type || OCTET_STREAM),
      stream: Readable.from(buf),
    };
  }
  return {
    contentType: contentTypeHint ?? OCTET_STREAM,
    stream: Readable.fromWeb(body as never),
  };
};

// Thread the operation's AbortSignal into a googleapis method-options arg.
// `MethodOptions` extends gaxios `GaxiosOptions`, whose `signal` is typed
// `any`, so a web `AbortSignal` passes through unchanged. Returns `undefined`
// when there's no signal so we don't alter the call when cancellation isn't
// requested.
const signalOpts = (
  signal: AbortSignal | undefined
): { signal: AbortSignal } | undefined => (signal ? { signal } : undefined);

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
    "google-drive: unexpected response payload shape"
  );
};

const fileToStoredMeta = (
  file: drive_v3.Schema$File
): {
  size: number;
  type: string;
  etag?: string;
  lastModified?: number;
  metadata?: Record<string, string>;
} => {
  const props = (file.appProperties ?? {}) as Record<string, string>;
  const userMeta: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith(RESERVED_METADATA_PREFIX)) {
      continue;
    }
    if (typeof v === "string") {
      userMeta[k] = v;
    }
  }
  const ct = props[CONTENT_TYPE_PROP] ?? file.mimeType ?? OCTET_STREAM;
  return {
    ...(file.md5Checksum && { etag: file.md5Checksum }),
    ...(file.modifiedTime && {
      lastModified: new Date(file.modifiedTime).getTime(),
    }),
    ...(Object.keys(userMeta).length > 0 && { metadata: userMeta }),
    size: Number(file.size ?? 0),
    type: ct,
  };
};

type AuthHandle = JWT | GoogleAuth | OAuth2Client;

const hasEnvAuth = (): boolean => {
  const email = readEnv("GOOGLE_DRIVE_CLIENT_EMAIL");
  const key = readEnv("GOOGLE_DRIVE_PRIVATE_KEY");
  if (email && key) {
    return true;
  }
  return Boolean(readEnv("GOOGLE_DRIVE_KEY_FILE"));
};

const buildAuth = (opts: GoogleDriveAdapterOptions): AuthHandle | undefined => {
  const subject = opts.subject ?? readEnv("GOOGLE_DRIVE_SUBJECT");
  if (opts.credentials) {
    return new JWT({
      email: opts.credentials.client_email,
      key: opts.credentials.private_key,
      scopes: [DRIVE_SCOPE],
      ...(subject && { subject }),
    });
  }
  if (opts.keyFilename) {
    return new GoogleAuth({
      keyFile: opts.keyFilename,
      scopes: [DRIVE_SCOPE],
      ...(subject && { clientOptions: { subject } }),
    });
  }
  if (opts.oauth) {
    const o = new OAuth2Client({
      clientId: opts.oauth.clientId,
      clientSecret: opts.oauth.clientSecret,
    });
    o.setCredentials({ refresh_token: opts.oauth.refreshToken });
    return o;
  }
  const envEmail = readEnv("GOOGLE_DRIVE_CLIENT_EMAIL");
  const envKey = readEnv("GOOGLE_DRIVE_PRIVATE_KEY");
  if (envEmail && envKey) {
    return new JWT({
      email: envEmail,
      key: envKey,
      scopes: [DRIVE_SCOPE],
      ...(subject && { subject }),
    });
  }
  const envKeyFile = readEnv("GOOGLE_DRIVE_KEY_FILE");
  if (envKeyFile) {
    return new GoogleAuth({
      keyFile: envKeyFile,
      scopes: [DRIVE_SCOPE],
      ...(subject && { clientOptions: { subject } }),
    });
  }
  return undefined;
};

export const googleDrive = (
  opts: GoogleDriveAdapterOptions = {}
): GoogleDriveAdapter => {
  const haveExplicit = Boolean(
    opts.credentials || opts.keyFilename || opts.oauth || opts.client
  );
  if (!haveExplicit && !hasEnvAuth()) {
    throw new FilesError(
      "Provider",
      "google-drive adapter: missing auth. Pass `credentials`, `keyFilename`, `oauth`, or `client`. Env fallbacks: GOOGLE_DRIVE_CLIENT_EMAIL + GOOGLE_DRIVE_PRIVATE_KEY, or GOOGLE_DRIVE_KEY_FILE."
    );
  }

  let driveClient: drive_v3.Drive;
  let authForTokens: AuthHandle | undefined;
  if (opts.client) {
    driveClient = opts.client;
    // No reliable public surface to recover the auth from a pre-built
    // client, so signedUploadUrl() will refuse with a clear message.
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = no auth handle available; null would misrepresent it as an intentional value
    authForTokens = undefined;
  } else {
    const built = buildAuth(opts);
    if (!built) {
      // Unreachable — the guard above guarantees explicit or env auth.
      throw new FilesError("Provider", "google-drive: failed to build auth");
    }
    authForTokens = built;
    driveClient = drive({ auth: built as never, version: "v3" });
  }

  const driveId = opts.driveId ?? readEnv("GOOGLE_DRIVE_ID");
  const rootFolderId =
    opts.rootFolderId ??
    readEnv("GOOGLE_DRIVE_ROOT_FOLDER_ID") ??
    driveId ??
    "root";
  const publicByDefault = opts.publicByDefault ?? false;
  const fileIdCache = new LRU<string>(
    opts.fileIdCacheSize ?? DEFAULT_CACHE_SIZE
  );

  const sharedDriveParams: {
    supportsAllDrives: true;
    includeItemsFromAllDrives: true;
    corpora?: string;
    driveId?: string;
  } = {
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    ...(driveId && { corpora: "drive", driveId }),
  };

  /**
   * Look up the fileId carrying virtual key `key` with a fresh `files.list`,
   * returning `undefined` when no file carries it. Skips the id cache on
   * read (writes use this to decide create-vs-update, and a stale cache
   * entry would mask an external delete or rewrite) but populates it on a
   * hit.
   */
  const lookupFileId = async (
    key: string,
    signal?: AbortSignal
  ): Promise<string | undefined> => {
    const q = `appProperties has { key='${KEY_PROP}' and value='${escapeQueryValue(key)}' } and '${escapeQueryValue(rootFolderId)}' in parents and trashed=false`;
    let res: { data: drive_v3.Schema$FileList };
    try {
      res = (await driveClient.files.list(
        {
          ...sharedDriveParams,
          fields: "files(id)",
          pageSize: 2,
          q,
        },
        signalOpts(signal)
      )) as { data: drive_v3.Schema$FileList };
    } catch (error) {
      throw mapDriveError(error);
    }
    const files = res.data.files ?? [];
    if (files.length === 0) {
      return undefined;
    }
    if (files.length > 1) {
      throw new FilesError(
        "Conflict",
        `google-drive: multiple files share virtual key '${key}'. Resolve via raw client.`
      );
    }
    const id = files[0]?.id;
    if (!id) {
      throw new FilesError(
        "Provider",
        `google-drive: list returned no fileId for ${key}`
      );
    }
    fileIdCache.set(key, id);
    return id;
  };

  const resolveFileId = async (
    key: string,
    signal?: AbortSignal
  ): Promise<string> => {
    const cached = fileIdCache.get(key);
    if (cached) {
      return cached;
    }
    const id = await lookupFileId(key, signal);
    if (id === undefined) {
      throw new FilesError("NotFound", `Not found: ${key}`);
    }
    return id;
  };

  const lazyDownload = (fileId: string) => async (): Promise<Uint8Array> => {
    const res = await driveClient.files.get(
      { ...sharedDriveParams, alt: "media", fileId },
      { responseType: "arraybuffer" }
    );
    return toUint8(res.data as unknown);
  };

  return {
    async copy(from, to, operationOpts) {
      try {
        const fromId = await resolveFileId(from, operationOpts?.signal);
        // Drive copies always create a new file; capture the id currently
        // holding `to` so overwrite semantics hold (the stale file would
        // otherwise duplicate the key and wedge later reads with a Conflict).
        const clobberedId = await lookupFileId(to, operationOpts?.signal);
        const copied = await driveClient.files.copy(
          {
            ...sharedDriveParams,
            fields: "id",
            fileId: fromId,
            requestBody: {
              appProperties: { [KEY_PROP]: to },
              name: basename(to),
              parents: [rootFolderId],
            },
          },
          signalOpts(operationOpts?.signal)
        );
        const newId = copied.data.id;
        if (clobberedId && clobberedId !== newId) {
          try {
            await driveClient.files.delete(
              { ...sharedDriveParams, fileId: clobberedId },
              signalOpts(operationOpts?.signal)
            );
          } catch (error) {
            // Already gone is fine — the duplicate resolved itself.
            if (mapDriveError(error).code !== "NotFound") {
              throw error;
            }
          }
        }
        if (newId) {
          fileIdCache.set(to, newId);
        }
      } catch (error) {
        throw mapDriveError(error);
      }
    },
    async delete(key, operationOpts) {
      let fileId: string;
      try {
        fileId = await resolveFileId(key, operationOpts?.signal);
      } catch (error) {
        // Idempotent: a missing file is not an error on delete.
        if (error instanceof FilesError && error.code === "NotFound") {
          return;
        }
        throw error;
      }
      try {
        await driveClient.files.delete(
          { ...sharedDriveParams, fileId },
          signalOpts(operationOpts?.signal)
        );
        fileIdCache.delete(key);
      } catch (error) {
        const mapped = mapDriveError(error);
        if (mapped.code === "NotFound") {
          fileIdCache.delete(key);
          return;
        }
        throw mapped;
      }
    },
    async download(key, downloadOpts) {
      try {
        const fileId = await resolveFileId(key, downloadOpts?.signal);
        const range = downloadOpts?.range;
        // Drive's alt=media download honors a Range header and replies 206.
        const rangeHeaders = range && { headers: rangeRequestHeaders(range) };
        if (downloadOpts?.as === "stream") {
          const [metaRes, mediaRes] = await Promise.all([
            driveClient.files.get(
              {
                ...sharedDriveParams,
                fields: FILE_FIELDS,
                fileId,
              },
              signalOpts(downloadOpts?.signal)
            ),
            driveClient.files.get(
              { ...sharedDriveParams, alt: "media", fileId },
              {
                responseType: "stream",
                ...(downloadOpts?.signal && { signal: downloadOpts.signal }),
                ...rangeHeaders,
              }
            ),
          ]);
          if (range) {
            assertRangeHonored(mediaRes.status, PROVIDER);
          }
          const m = fileToStoredMeta(metaRes.data);
          const node = mediaRes.data as unknown as Readable;
          return createStoredFile(
            { key, ...m, ...(range && { size: rangedSize(m.size, range) }) },
            {
              factory: () =>
                Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>,
              kind: "stream",
            }
          );
        }
        const [metaRes, mediaRes] = await Promise.all([
          driveClient.files.get(
            {
              ...sharedDriveParams,
              fields: FILE_FIELDS,
              fileId,
            },
            signalOpts(downloadOpts?.signal)
          ),
          driveClient.files.get(
            { ...sharedDriveParams, alt: "media", fileId },
            {
              responseType: "arraybuffer",
              ...(downloadOpts?.signal && { signal: downloadOpts.signal }),
              ...rangeHeaders,
            }
          ),
        ]);
        if (range) {
          assertRangeHonored(mediaRes.status, PROVIDER);
        }
        const m = fileToStoredMeta(metaRes.data);
        const bytes = toUint8(mediaRes.data as unknown);
        return createStoredFile(
          { key, ...m, size: bytes.byteLength },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapDriveError(error);
      }
    },
    exists(key, operationOpts) {
      return existsByProbe(async () => {
        const fileId = await resolveFileId(key, operationOpts?.signal);
        await driveClient.files.get(
          {
            ...sharedDriveParams,
            fields: "id",
            fileId,
          },
          signalOpts(operationOpts?.signal)
        );
      }, mapDriveError);
    },
    async head(key, operationOpts) {
      try {
        const fileId = await resolveFileId(key, operationOpts?.signal);
        const res = await driveClient.files.get(
          {
            ...sharedDriveParams,
            fields: FILE_FIELDS,
            fileId,
          },
          signalOpts(operationOpts?.signal)
        );
        const m = fileToStoredMeta(res.data);
        return createStoredFile(
          { key, ...m },
          { factory: lazyDownload(fileId), kind: "lazy" }
        );
      } catch (error) {
        throw mapDriveError(error);
      }
    },
    async list(options): Promise<ListResult> {
      try {
        const q = `'${escapeQueryValue(rootFolderId)}' in parents and trashed=false`;
        const toItem = (
          f: drive_v3.Schema$File,
          fsdkKey: string
        ): StoredFile => {
          const m = fileToStoredMeta(f);
          const fileId = f.id ?? "";
          if (fileId) {
            fileIdCache.set(fsdkKey, fileId);
          }
          return createStoredFile(
            { key: fsdkKey, ...m },
            { factory: lazyDownload(fileId), kind: "lazy" }
          );
        };
        const keyOf = (f: drive_v3.Schema$File): string | undefined =>
          (f.appProperties as Record<string, string> | undefined)?.[KEY_PROP];
        // Drive stores every object flat under rootFolderId, keyed by the
        // fsdkKey appProperty (the Drive `name` is just the leaf). It can't
        // sort/group by appProperty, so gather all keys and synthesize the
        // common prefixes in memory, like the fs adapter. Nested so the flat
        // `list` stays simple.
        const listFolded = async (delimiter: string): Promise<ListResult> => {
          const fileByKey = new Map<string, drive_v3.Schema$File>();
          let pageToken: string | undefined;
          do {
            // eslint-disable-next-line no-await-in-loop -- pagination: each page uses the pageToken from the previous response
            const res = (await driveClient.files.list(
              {
                ...sharedDriveParams,
                fields: `nextPageToken, files(${FILE_FIELDS})`,
                ...(pageToken && { pageToken }),
                q,
              },
              signalOpts(options?.signal)
            )) as { data: drive_v3.Schema$FileList };
            for (const f of res.data.files ?? []) {
              const key = keyOf(f);
              if (key) {
                fileByKey.set(key, f);
              }
            }
            pageToken = res.data.nextPageToken ?? undefined;
          } while (pageToken);
          const sortedKeys = [...fileByKey.keys()].toSorted(compareKeys);
          const page = paginateHierarchy(sortedKeys, {
            delimiter,
            ...(options?.limit !== undefined && { limit: options.limit }),
            ...(options?.prefix !== undefined && { prefix: options.prefix }),
            ...(options?.cursor !== undefined && { cursor: options.cursor }),
          });
          return {
            items: page.items.map((key) =>
              toItem(fileByKey.get(key) as drive_v3.Schema$File, key)
            ),
            ...(page.cursor && { cursor: page.cursor }),
            ...(page.prefixes.length && { prefixes: page.prefixes }),
          };
        };
        if (options?.delimiter) {
          return await listFolded(options.delimiter);
        }
        const res = (await driveClient.files.list(
          {
            ...sharedDriveParams,
            fields: `nextPageToken, files(${FILE_FIELDS})`,
            ...(options?.limit !== undefined && { pageSize: options.limit }),
            ...(options?.cursor && { pageToken: options.cursor }),
            q,
          },
          signalOpts(options?.signal)
        )) as { data: drive_v3.Schema$FileList };
        const driveFiles = res.data.files ?? [];
        const items: StoredFile[] = [];
        for (const f of driveFiles) {
          const fsdkKey = keyOf(f);
          if (
            !fsdkKey ||
            (options?.prefix && !fsdkKey.startsWith(options.prefix))
          ) {
            continue;
          }
          items.push(toItem(f, fsdkKey));
        }
        const cursor = res.data.nextPageToken ?? undefined;
        return { items, ...(cursor && { cursor }) };
      } catch (error) {
        throw mapDriveError(error);
      }
    },
    name: PROVIDER,
    raw: driveClient,
    resumableUpload(key, resumableOpts): OffsetResumableDriver {
      let contentType = OCTET_STREAM;
      let total = 0;
      return createOffsetHttpDriver({
        async open(meta) {
          assertNoReservedMetadata(resumableOpts.metadata);
          ({ contentType } = meta);
          ({ total } = meta);
          if (!authForTokens) {
            throw new FilesError(
              "Provider",
              "google-drive: resumable uploads require `credentials`, `keyFilename`, or `oauth` — not the pre-built `client` escape hatch."
            );
          }
          const tokenResp = await (
            authForTokens as {
              getAccessToken: () => Promise<string | { token?: string | null }>;
            }
          ).getAccessToken();
          const token =
            typeof tokenResp === "string" ? tokenResp : tokenResp?.token;
          if (!token) {
            throw new FilesError(
              "Provider",
              "google-drive: failed to mint access token for resumable upload session"
            );
          }
          const existingId = await lookupFileId(key);
          const fields = `&fields=${encodeURIComponent(
            "id,size,md5Checksum,mimeType,modifiedTime"
          )}`;
          const initBody = {
            appProperties: {
              [KEY_PROP]: key,
              [CONTENT_TYPE_PROP]: meta.contentType,
              ...(resumableOpts.cacheControl && {
                [CACHE_CONTROL_PROP]: resumableOpts.cacheControl,
              }),
              ...resumableOpts.metadata,
            },
            mimeType: meta.contentType,
            name: basename(key),
          };
          const res = await fetch(
            existingId === undefined
              ? `${RESUMABLE_INITIATE_URL}${fields}`
              : `${resumableUpdateUrl(existingId)}${fields}`,
            {
              body: JSON.stringify(
                existingId === undefined
                  ? { ...initBody, parents: [rootFolderId] }
                  : initBody
              ),
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Type": meta.contentType,
              },
              method: existingId === undefined ? "POST" : "PATCH",
            }
          );
          if (!res.ok) {
            // oxlint-disable-next-line github/no-then -- fire-and-forget fallback: swallow the body-read error and use "" when building the failure message
            const text = await res.text().catch(() => "");
            throw new FilesError(
              "Provider",
              `google-drive: resumable session initiation failed: ${res.status} ${text}`.trim()
            );
          }
          const uri =
            res.headers.get("location") ?? res.headers.get("Location");
          if (!uri) {
            throw new FilesError(
              "Provider",
              "google-drive: resumable session response missing Location header"
            );
          }
          const trustedUri = trustedHttpsSessionUrl(
            uri,
            "google-drive resumable session URL",
            ["googleapis.com"]
          );
          return {
            session: { key, provider: PROVIDER, uri: trustedUri },
            uri: trustedUri,
          };
        },
        async parseResult(res) {
          const data = (await res.json()) as {
            id?: string;
            size?: string | number;
            md5Checksum?: string;
            mimeType?: string;
            modifiedTime?: string;
          };
          return {
            contentType: data.mimeType ?? contentType,
            ...(data.md5Checksum && { etag: data.md5Checksum }),
            key,
            ...(data.modifiedTime && {
              lastModified: new Date(data.modifiedTime).getTime(),
            }),
            size: Number(data.size ?? total),
          };
        },
        partSize:
          resumableChunkSize(resumableOpts.multipart) ?? 8 * 1024 * 1024,
        resume(session: ResumableUploadSession): string {
          if (session.provider !== PROVIDER) {
            throw new FilesError(
              "Provider",
              `Cannot resume a ${session.provider} session on a google-drive adapter.`
            );
          }
          if (session.key !== key) {
            throw new FilesError(
              "Provider",
              "Resume token does not match this upload's key."
            );
          }
          return trustedHttpsSessionUrl(
            session.uri,
            "google-drive resumable session URL",
            ["googleapis.com"]
          );
        },
        wrapErr: mapDriveError,
      });
    },
    rootFolderId,
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      if (signOpts.maxSize !== undefined || signOpts.minSize !== undefined) {
        throw new FilesError(
          "Provider",
          "google-drive: `maxSize` and `minSize` are not supported for signed upload URLs. Drive resumable upload sessions do not enforce a server-side content-length-range policy; enforce size limits at your application gateway / proxy before issuing the session URL."
        );
      }
      if (!authForTokens) {
        throw new FilesError(
          "Provider",
          "google-drive: signedUploadUrl() requires `credentials`, `keyFilename`, or `oauth` — not the pre-built `client` escape hatch."
        );
      }
      const tokenResp = await (
        authForTokens as {
          getAccessToken: () => Promise<string | { token?: string | null }>;
        }
      ).getAccessToken();
      const token =
        typeof tokenResp === "string" ? tokenResp : tokenResp?.token;
      if (!token) {
        throw new FilesError(
          "Provider",
          "google-drive: failed to mint access token for resumable upload session"
        );
      }
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      };
      if (signOpts.contentType) {
        headers["X-Upload-Content-Type"] = signOpts.contentType;
      }
      const existingId = await lookupFileId(key, signOpts.signal);
      const initBody = {
        appProperties: { [KEY_PROP]: key },
        name: basename(key),
        ...(existingId === undefined && { parents: [rootFolderId] }),
      };
      let res: Response;
      try {
        res = await fetch(
          existingId === undefined
            ? RESUMABLE_INITIATE_URL
            : resumableUpdateUrl(existingId),
          {
            body: JSON.stringify(initBody),
            headers,
            method: existingId === undefined ? "POST" : "PATCH",
            ...(signOpts.signal && { signal: signOpts.signal }),
          }
        );
      } catch (error) {
        throw mapDriveError(error);
      }
      if (!res.ok) {
        // oxlint-disable-next-line github/no-then -- fire-and-forget fallback: swallow the body-read error and use "" when building the failure message
        const text = await res.text().catch(() => "");
        throw mapDriveError({
          message:
            `google-drive: resumable session initiation failed: ${res.status} ${res.statusText} ${text}`.trim(),
          status: res.status,
        });
      }
      const sessionUrl =
        res.headers.get("location") ?? res.headers.get("Location");
      if (!sessionUrl) {
        throw new FilesError(
          "Provider",
          "google-drive: resumable session response missing Location header"
        );
      }
      return {
        method: "PUT",
        url: sessionUrl,
        ...(signOpts.contentType && {
          headers: { "Content-Type": signOpts.contentType },
        }),
      };
    },
    // Drive has no signed-URL primitive: `url()` throws unless the adapter was
    // built with `publicByDefault`, and even then returns a permanent link.
    signedUrl: { supported: false },
    supportsCacheControl: true,
    supportsDelimiter: true,
    supportsMetadata: true,
    supportsRange: true,
    // `copy()` is a server-side `files.copy`.
    supportsServerSideCopy: true,
    async upload(key, body, options): Promise<UploadResult> {
      assertNoReservedMetadata(options?.metadata);
      try {
        const normalized = await normalizeBody(body, options?.contentType);
        const appProperties: Record<string, string> = {
          [KEY_PROP]: key,
          [CONTENT_TYPE_PROP]: normalized.contentType,
          ...(options?.cacheControl && {
            [CACHE_CONTROL_PROP]: options.cacheControl,
          }),
          ...options?.metadata,
        };
        // Drive has no unique-name constraint, so an unconditional create
        // would strand a duplicate per overwrite and wedge every later read
        // on that key with a Conflict. Look the key up fresh and update the
        // existing file in place (`parents` is create-only).
        const existingId = await lookupFileId(key, options?.signal);
        const media = {
          body: normalized.stream,
          mimeType: normalized.contentType,
        };
        const res =
          existingId === undefined
            ? await driveClient.files.create(
                {
                  ...sharedDriveParams,
                  fields: "id, size, mimeType, md5Checksum, modifiedTime",
                  media,
                  requestBody: {
                    appProperties,
                    mimeType: normalized.contentType,
                    name: basename(key),
                    parents: [rootFolderId],
                  },
                },
                signalOpts(options?.signal)
              )
            : await driveClient.files.update(
                {
                  ...sharedDriveParams,
                  fields: "id, size, mimeType, md5Checksum, modifiedTime",
                  fileId: existingId,
                  media,
                  requestBody: {
                    appProperties,
                    mimeType: normalized.contentType,
                    name: basename(key),
                  },
                },
                signalOpts(options?.signal)
              );
        const { data } = res;
        const fileId = data.id;
        if (fileId) {
          fileIdCache.set(key, fileId);
        }
        if (publicByDefault && fileId) {
          await driveClient.permissions.create(
            {
              ...sharedDriveParams,
              fileId,
              requestBody: { role: "reader", type: "anyone" },
            },
            signalOpts(options?.signal)
          );
        }
        return {
          contentType: normalized.contentType,
          ...(data.md5Checksum && { etag: data.md5Checksum }),
          key,
          ...(data.modifiedTime && {
            lastModified: new Date(data.modifiedTime).getTime(),
          }),
          size: normalized.contentLength ?? Number(data.size ?? 0),
        };
      } catch (error) {
        throw mapDriveError(error);
      }
    },
    async url(key, urlOpts) {
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "google-drive: `responseContentDisposition` is not supported. Drive's webContentLink has no Content-Disposition override."
        );
      }
      if (!publicByDefault) {
        throw new FilesError(
          "Provider",
          "google-drive: url() requires the adapter to be constructed with `publicByDefault: true`. Drive has no signed URL primitive — use download() for private files."
        );
      }
      try {
        const fileId = await resolveFileId(key, urlOpts?.signal);
        return `https://drive.google.com/uc?export=download&id=${fileId}`;
      } catch (error) {
        throw mapDriveError(error);
      }
    },
  };
};
