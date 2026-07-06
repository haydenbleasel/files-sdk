import { AuthType, createClient } from "webdav";
import type { FileStat, OAuthToken, WebDAVClient } from "webdav";

import type {
  Adapter,
  Body,
  DownloadOptions,
  ListOptions,
  ListResult,
  OperationOptions,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  assertRangeHonored,
  collectStream,
  existsByProbe,
  httpRangeHeader,
  joinPublicUrl,
  makeErrorMapper,
  normalizeBody,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { inferTypeFromName } from "../internal/mime.js";
import { joinRemotePath, trimSlashes } from "../internal/remote-path.js";
import { createStoredFile } from "../internal/stored-file.js";
import { compareKeys, pageKeyList } from "../internal/walk-paginate.js";

/**
 * Named auth strategy. `"basic"` is an alias for `"password"`. Maps onto the
 * `webdav` library's `AuthType`. Defaults: `"token"` when a `token` is passed,
 * `"password"` when a `username` is passed, otherwise `"none"`.
 */
export type WebdavAuthType =
  | "auto"
  | "basic"
  | "digest"
  | "none"
  | "password"
  | "token";

export interface WebdavAdapterOptions {
  /**
   * WebDAV server base URL — the collection virtual keys resolve under (e.g.
   * `https://dav.example.com/remote.php/dav/files/alice`). Falls back to
   * `WEBDAV_URL` (alias `WEBDAV_BASE_URL`).
   */
  baseUrl?: string;
  /** Username for basic/digest auth. Falls back to `WEBDAV_USERNAME` (alias `WEBDAV_USER`). */
  username?: string;
  /** Password for basic/digest auth. Falls back to `WEBDAV_PASSWORD`. */
  password?: string;
  /**
   * Auth strategy. Inferred when omitted (see {@link WebdavAuthType}). Falls
   * back to `WEBDAV_AUTH_TYPE`.
   */
  authType?: WebdavAuthType;
  /** OAuth token for `authType: "token"`. */
  token?: OAuthToken;
  /** Extra headers sent on every request (e.g. a custom auth header). */
  headers?: Record<string, string>;
  /**
   * Remote base directory. Virtual keys resolve under it; keys that escape it
   * (e.g. `../secret`) throw `Provider`. Defaults to `"/"` (the collection the
   * `baseUrl` points at).
   */
  root?: string;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}`. When unset, `url()` throws: a WebDAV `GET`
   * needs auth, so there's no unauthenticated URL to hand out, and the
   * protocol has no signing primitive.
   */
  publicBaseUrl?: string;
  /**
   * Pre-configured `webdav` client. When passed, the adapter reuses it and
   * ignores the connection options above — the caller owns its configuration.
   */
  client?: WebDAVClient;
}

export type WebdavRaw = WebDAVClient;
export type WebdavAdapter = Adapter<WebdavRaw> & { readonly root: string };

// WebDAV errors from the `webdav` library carry the HTTP status on `.status`;
// classify on the standard status buckets. Transport failures (fetch rejected:
// DNS, connection refused, TLS) arrive with no status and fall through to
// Provider (retryable).
export const mapWebdavError = makeErrorMapper({
  codes: {
    conflict: new Set<string>(),
    notFound: new Set<string>(),
    unauthorized: new Set<string>(),
  },
  extract: (err) => {
    const e = err as { status?: number; message?: string };
    return {
      ...(typeof e?.status === "number" && { status: e.status }),
      ...(typeof e?.message === "string" && { message: e.message }),
    };
  },
  providerLabel: "WebDAV error",
});

const LAST_MODIFIED_HEADER = "last-modified";

const AUTH_TYPES: Readonly<Record<WebdavAuthType, AuthType>> = {
  auto: AuthType.Auto,
  basic: AuthType.Password,
  digest: AuthType.Digest,
  none: AuthType.None,
  password: AuthType.Password,
  token: AuthType.Token,
};

const resolveAuthType = (value: string | undefined): AuthType | undefined => {
  if (!value) {
    return;
  }
  const mapped = AUTH_TYPES[value as WebdavAuthType];
  if (!mapped) {
    throw new FilesError(
      "Provider",
      `webdav: unknown authType ${JSON.stringify(value)}. Expected one of ${Object.keys(AUTH_TYPES).join(", ")}.`
    );
  }
  return mapped;
};

// WebDAV's detailed-response headers are a plain record; HTTP header names are
// case-insensitive, so look them up defensively rather than assuming a casing.
const headerValue = (
  headers: Record<string, string>,
  name: string
): string | undefined => {
  const lower = name.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return val;
    }
  }
};

const parseLastMod = (value: string | undefined | null): number | undefined => {
  if (!value) {
    return;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
};

// getFileContents (binary) returns a Node Buffer, ArrayBuffer, or a typed-array
// view depending on the runtime — normalize every shape to a Uint8Array without
// copying.
const toUint8 = (data: ArrayBuffer | ArrayBufferView): Uint8Array => {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};

// A tight ArrayBuffer over the bytes — putFileContents takes ArrayBuffer/Buffer,
// not an arbitrary Uint8Array view, so hand it a buffer with no slack.
const toArrayBuffer = (u8: Uint8Array): ArrayBuffer => {
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) {
    return u8.buffer as ArrayBuffer;
  }
  return new Uint8Array(u8).buffer;
};

// Parent collection of a remote path, or "/" when the path sits at the root.
const parentOf = (remote: string): string => {
  const idx = remote.lastIndexOf("/");
  return idx <= 0 ? "/" : remote.slice(0, idx);
};

const resolveClient = (opts: WebdavAdapterOptions): WebDAVClient => {
  if (opts.client) {
    return opts.client;
  }
  const baseUrl =
    opts.baseUrl ?? readEnv("WEBDAV_URL") ?? readEnv("WEBDAV_BASE_URL");
  if (!baseUrl) {
    throw new FilesError(
      "Provider",
      "webdav adapter: missing connection. Pass `baseUrl` (and `username` / `password`), set WEBDAV_URL / WEBDAV_USERNAME / WEBDAV_PASSWORD, or pass a pre-configured `client`."
    );
  }
  const username =
    opts.username ?? readEnv("WEBDAV_USERNAME") ?? readEnv("WEBDAV_USER");
  const password = opts.password ?? readEnv("WEBDAV_PASSWORD");
  const authType = resolveAuthType(
    opts.authType ?? readEnv("WEBDAV_AUTH_TYPE")
  );
  return createClient(baseUrl, {
    ...(username && { username }),
    ...(password && { password }),
    ...(authType !== undefined && { authType }),
    ...(opts.token && { token: opts.token }),
    ...(opts.headers && { headers: opts.headers }),
  });
};

export const webdav = (opts: WebdavAdapterOptions = {}): WebdavAdapter => {
  const client = resolveClient(opts);
  const root = opts.root ?? "/";
  const { publicBaseUrl } = opts;

  // Directory to start list() from: the configured root as an absolute WebDAV
  // path, defaulting to "/" (the collection the baseUrl points at).
  const remoteRoot = (() => {
    const inner = trimSlashes(root === "." ? "" : root);
    return inner ? `/${inner}` : "/";
  })();

  const keyToRemote = (key: string): string => joinRemotePath(root, key);

  // WebDAV PUT/COPY/MOVE won't create missing parent collections — MKCOL them
  // first. Recursive createDirectory is idempotent on an existing tree; a
  // failure here (e.g. the collection already exists on a server that answers
  // 405) is swallowed, since the following operation surfaces any real problem.
  const ensureParentDir = async (
    remote: string,
    signal: AbortSignal | undefined
  ): Promise<void> => {
    const dir = parentOf(remote);
    if (dir === "/") {
      return;
    }
    try {
      await client.createDirectory(dir, {
        recursive: true,
        ...(signal && { signal }),
      });
    } catch {
      // best-effort: the collection may already exist.
    }
  };

  const lazyDownload = (key: string) => async (): Promise<Uint8Array> => {
    try {
      const data = (await client.getFileContents(keyToRemote(key), {
        format: "binary",
      })) as ArrayBuffer | ArrayBufferView;
      return toUint8(data);
    } catch (error) {
      throw mapWebdavError(error);
    }
  };

  const adapter: WebdavAdapter = {
    async copy(from, to, opts2) {
      const fromRemote = keyToRemote(from);
      const toRemote = keyToRemote(to);
      try {
        // Native server-side COPY — no body round-trip through this process.
        await ensureParentDir(toRemote, opts2?.signal);
        await client.copyFile(fromRemote, toRemote, {
          ...(opts2?.signal && { signal: opts2.signal }),
        });
      } catch (error) {
        throw mapWebdavError(error);
      }
    },
    async delete(key, opts2) {
      const remote = keyToRemote(key);
      try {
        await client.deleteFile(remote, {
          ...(opts2?.signal && { signal: opts2.signal }),
        });
      } catch (error) {
        const mapped = mapWebdavError(error);
        // Idempotent: a missing file is not an error.
        if (mapped.code === "NotFound") {
          return;
        }
        throw mapped;
      }
    },
    async download(key, downloadOpts?: DownloadOptions): Promise<StoredFile> {
      const remote = keyToRemote(key);
      const range = downloadOpts?.range;
      const rangeHeaders = range
        ? { Range: httpRangeHeader(range) }
        : undefined;
      if (downloadOpts?.as === "stream") {
        try {
          // customRequest returns the raw fetch Response with an unread body,
          // so response.body streams straight through — no buffering, and
          // isomorphic (Node undici + the browser both give a web stream).
          const res = await client.customRequest(remote, {
            method: "GET",
            ...(rangeHeaders && { headers: rangeHeaders }),
            ...(downloadOpts.signal && { signal: downloadOpts.signal }),
          });
          if (range) {
            assertRangeHonored(res.status, "webdav");
          }
          const stream = res.body;
          if (!stream) {
            throw new FilesError(
              "Provider",
              `webdav: GET ${key} returned no response body`
            );
          }
          const contentLength = res.headers.get("content-length");
          return createStoredFile(
            {
              key,
              ...(parseLastMod(res.headers.get(LAST_MODIFIED_HEADER)) !==
                undefined && {
                lastModified: parseLastMod(
                  res.headers.get(LAST_MODIFIED_HEADER)
                ),
              }),
              size: contentLength ? Number(contentLength) : 0,
              type: res.headers.get("content-type") ?? inferTypeFromName(key),
            },
            {
              factory: () => stream as unknown as ReadableStream<Uint8Array>,
              kind: "stream",
            }
          );
        } catch (error) {
          throw mapWebdavError(error);
        }
      }
      try {
        const result = (await client.getFileContents(remote, {
          details: true,
          format: "binary",
          ...(rangeHeaders && { headers: rangeHeaders }),
          ...(downloadOpts?.signal && { signal: downloadOpts.signal }),
        })) as {
          data: ArrayBuffer | ArrayBufferView;
          headers: Record<string, string>;
          status: number;
        };
        if (range) {
          assertRangeHonored(result.status, "webdav");
        }
        const bytes = toUint8(result.data);
        const lastModified = parseLastMod(
          headerValue(result.headers, LAST_MODIFIED_HEADER)
        );
        return createStoredFile(
          {
            key,
            ...(lastModified !== undefined && { lastModified }),
            size: bytes.byteLength,
            type:
              headerValue(result.headers, "content-type") ??
              inferTypeFromName(key),
          },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapWebdavError(error);
      }
    },
    exists(key, opts2?: OperationOptions) {
      const remote = keyToRemote(key);
      return existsByProbe(async () => {
        const stat = (await client.stat(remote, {
          ...(opts2?.signal && { signal: opts2.signal }),
        })) as FileStat;
        if (stat.type === "directory") {
          throw new FilesError("NotFound", `webdav: ${key} is a directory`);
        }
      }, mapWebdavError);
    },
    async head(key, opts2?: OperationOptions): Promise<StoredFile> {
      const remote = keyToRemote(key);
      try {
        const stat = (await client.stat(remote, {
          ...(opts2?.signal && { signal: opts2.signal }),
        })) as FileStat;
        if (stat.type === "directory") {
          throw new FilesError("NotFound", `webdav: ${key} is a directory`);
        }
        const lastModified = parseLastMod(stat.lastmod);
        return createStoredFile(
          {
            key,
            ...(lastModified !== undefined && { lastModified }),
            size: stat.size,
            type: stat.mime ?? inferTypeFromName(key),
          },
          { factory: lazyDownload(key), kind: "lazy" }
        );
      } catch (error) {
        throw mapWebdavError(error);
      }
    },
    async list(options?: ListOptions): Promise<ListResult> {
      const signal = options?.signal;
      const keys: string[] = [];
      const meta = new Map<
        string,
        { size: number; lastModified?: number; type?: string }
      >();
      const walk = async (dir: string, prefix: string): Promise<void> => {
        const entries = (await client.getDirectoryContents(dir, {
          details: false,
          ...(signal && { signal }),
        })) as FileStat[];
        for (const entry of entries) {
          const childKey = prefix
            ? `${prefix}/${entry.basename}`
            : entry.basename;
          if (entry.type === "directory") {
            const childPath =
              dir === "/" ? `/${entry.basename}` : `${dir}/${entry.basename}`;
            // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- recursive walk: WebDAV has no native prefix scan across collections.
            await walk(childPath, childKey);
          } else {
            keys.push(childKey);
            meta.set(childKey, {
              ...(parseLastMod(entry.lastmod) !== undefined && {
                lastModified: parseLastMod(entry.lastmod),
              }),
              size: entry.size,
              ...(entry.mime && { type: entry.mime }),
            });
          }
        }
      };
      try {
        await walk(remoteRoot, "");
      } catch (error) {
        const mapped = mapWebdavError(error);
        // An empty/nonexistent root lists as empty, matching the fs adapter.
        if (mapped.code === "NotFound") {
          return { items: [] };
        }
        throw mapped;
      }
      keys.sort(compareKeys);
      const page = pageKeyList(keys, {
        ...(options?.delimiter && { delimiter: options.delimiter }),
        ...(options?.cursor !== undefined && { cursor: options.cursor }),
        ...(options?.limit !== undefined && { limit: options.limit }),
        ...(options?.prefix !== undefined && { prefix: options.prefix }),
      });
      const items: StoredFile[] = page.keys.map((key) => {
        const m = meta.get(key);
        return createStoredFile(
          {
            key,
            ...(m?.lastModified !== undefined && {
              lastModified: m.lastModified,
            }),
            size: m?.size ?? 0,
            type: m?.type ?? inferTypeFromName(key),
          },
          { factory: lazyDownload(key), kind: "lazy" }
        );
      });
      return {
        items,
        ...(page.cursor !== undefined && { cursor: page.cursor }),
        ...(page.prefixes && { prefixes: page.prefixes }),
      };
    },
    async move(from, to, opts2) {
      const fromRemote = keyToRemote(from);
      const toRemote = keyToRemote(to);
      try {
        // Native server-side MOVE — no body round-trip.
        await ensureParentDir(toRemote, opts2?.signal);
        await client.moveFile(fromRemote, toRemote, {
          ...(opts2?.signal && { signal: opts2.signal }),
        });
      } catch (error) {
        throw mapWebdavError(error);
      }
    },
    name: "webdav",
    get raw(): WebdavRaw {
      return client;
    },
    get root() {
      return root;
    },
    signedUploadUrl(_key, _signOpts): Promise<SignedUpload> {
      return Promise.reject(
        new FilesError(
          "Provider",
          "webdav: signedUploadUrl() is not supported. WebDAV has no presigned-upload concept — use upload()."
        )
      );
    },
    // A WebDAV GET requires auth and the protocol has no signing primitive —
    // `url()` returns a `publicBaseUrl` front URL when configured, else throws.
    signedUrl: { supported: false },
    supportsDelimiter: true,
    supportsRange: true,
    // COPY / MOVE run server-side.
    supportsServerSideCopy: true,
    async upload(key, body: Body, options): Promise<UploadResult> {
      // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
      // (this adapter advertises neither). `contentType` is sent as the PUT
      // Content-Type so servers that persist it round-trip it on read.
      const remote = keyToRemote(key);
      try {
        const { data, contentType, contentLength } = await normalizeBody(
          body,
          options?.contentType
        );
        // Unknown-length streams are buffered: WebDAV PUT needs a length up
        // front, and this adapter has no resumable/chunked path.
        const bytes =
          data instanceof ReadableStream ? await collectStream(data) : data;
        await ensureParentDir(remote, options?.signal);
        await client.putFileContents(remote, toArrayBuffer(bytes), {
          contentLength: bytes.byteLength,
          headers: { "Content-Type": contentType },
          overwrite: true,
          ...(options?.signal && { signal: options.signal }),
        });
        return {
          contentType,
          key,
          size: contentLength ?? bytes.byteLength,
        } satisfies UploadResult;
      } catch (error) {
        throw mapWebdavError(error);
      }
    },
    url(key, urlOpts): Promise<string> {
      // Validate the key (traversal guard) even though we don't connect.
      keyToRemote(key);
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "webdav: `responseContentDisposition` is not supported. WebDAV publicBaseUrl URLs are static HTTP-front URLs, with no signature in which to bind the override."
        );
      }
      if (publicBaseUrl) {
        return Promise.resolve(joinPublicUrl(publicBaseUrl, key));
      }
      throw new FilesError(
        "Provider",
        "webdav: url() requires `publicBaseUrl`. A WebDAV GET needs authentication and the protocol has no signing primitive; configure `publicBaseUrl` to point at an HTTP server fronting the same tree, or use download()."
      );
    },
  };
  return adapter;
};
