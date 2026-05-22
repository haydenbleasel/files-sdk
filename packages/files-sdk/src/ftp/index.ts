import { Buffer } from "node:buffer";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ConnectionOptions as TLSConnectionOptions } from "node:tls";

import { Client } from "basic-ftp";
import type { FileInfo } from "basic-ftp";

import type {
  Adapter,
  Body,
  DeleteManyError,
  DeleteManyOptions,
  DeleteManyResult,
  DownloadOptions,
  ListOptions,
  ListResult,
  OperationOptions,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  existsByProbe,
  joinPublicUrl,
  makeErrorMapper,
  normalizeBody,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { inferTypeFromName } from "../internal/mime.js";
import { joinRemotePath, trimSlashes } from "../internal/remote-path.js";
import { createStoredFile } from "../internal/stored-file.js";
import { compareKeys, paginateKeys } from "../internal/walk-paginate.js";

export interface FtpAdapterOptions {
  /** FTP host. Falls back to `FTP_HOST`. */
  host?: string;
  /** Port. Falls back to `FTP_PORT`, then `21`. */
  port?: number;
  /** Username. Falls back to `FTP_USERNAME` (alias `FTP_USER`), then `anonymous`. */
  user?: string;
  /** Password. Falls back to `FTP_PASSWORD`. */
  password?: string;
  /**
   * FTPS over TLS. `true` is preferred explicit TLS (AUTH TLS); `"implicit"`
   * is legacy implicit TLS. Defaults to `false` — **plain FTP transmits
   * credentials and data in cleartext; prefer `secure: true`.** Falls back to
   * `FTP_SECURE` (`"true"` or `"implicit"`).
   */
  secure?: boolean | "implicit";
  /** TLS options forwarded to the secure connection (e.g. `rejectUnauthorized`). */
  secureOptions?: TLSConnectionOptions;
  /**
   * Remote base directory. Virtual keys resolve under it; keys that escape it
   * (e.g. `../etc/passwd`) throw `Provider`. Defaults to `"."` (the login
   * directory). An absolute root (`/uploads`) yields absolute paths.
   */
  root?: string;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}`. When unset, `url()` throws: FTP serves no HTTP
   * and has no signing primitive.
   */
  publicBaseUrl?: string;
  /** Socket timeout in milliseconds for new connections (basic-ftp default 30s). */
  timeout?: number;
  /**
   * Pre-connected `basic-ftp` `Client`. When passed, the adapter reuses it for
   * every call and never opens or closes a connection — the caller owns the
   * socket lifecycle. The high-throughput path: connect once and inject rather
   * than paying a handshake per operation.
   */
  client?: Client;
}

export type FtpRaw = Client | { connect: () => Promise<Client> };
export type FtpAdapter = Adapter<FtpRaw> & { readonly root: string };

const DEFAULT_PORT = 21;

export const mapFtpError = makeErrorMapper({
  codes: {
    conflict: new Set(["552", "553"]),
    notFound: new Set(["550", "450", "551"]),
    unauthorized: new Set(["530", "532"]),
  },
  // basic-ftp's FTPError carries the numeric reply code on `.code`. Classify on
  // the stringified code; transport errors (ECONNREFUSED, timeouts) arrive as
  // plain Errors with a string code and fall through to Provider (retryable).
  extract: (err) => {
    const e = err as { code?: number | string; message?: string };
    return {
      ...(typeof e?.code === "number" && { code: String(e.code) }),
      ...(typeof e?.message === "string" && { message: e.message }),
    };
  },
  providerLabel: "FTP error",
});

const uint8ToBuffer = (u8: Uint8Array): Buffer =>
  Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

// Split a remote path into its directory and basename. dir is "" for a bare
// filename, "/" for a root-level file; base is the trailing segment.
const splitRemote = (remote: string): { dir: string; base: string } => {
  const idx = remote.lastIndexOf("/");
  if (idx === -1) {
    return { base: remote, dir: "" };
  }
  return {
    base: remote.slice(idx + 1),
    dir: idx === 0 ? "/" : remote.slice(0, idx),
  };
};

const lastModMs = (date: Date | undefined): number | undefined => {
  if (!date) {
    return;
  }
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : undefined;
};

// Write `source` to `remote`, creating parent directories first. basic-ftp's
// `ensureDir` changes the working directory into the target, so we upload the
// basename there and then restore the original cwd — otherwise a reused
// (injected) connection would resolve later paths against the wrong directory.
// Connect-per-op closes the socket anyway, so the restore is only a no-op cost
// there.
const uploadInto = async (
  client: Client,
  remote: string,
  source: Readable
): Promise<void> => {
  const { dir, base } = splitRemote(remote);
  if (!dir) {
    await client.uploadFrom(source, remote);
    return;
  }
  const savedCwd = await client.pwd();
  await client.ensureDir(dir);
  try {
    await client.uploadFrom(source, base);
  } finally {
    await client.cd(savedCwd);
  }
};

/* oxlint-disable promise/prefer-await-to-callbacks -- basic-ftp downloads into a Node Writable, whose write API is callback-based. */
const downloadToBuffer = async (
  client: Client,
  remote: string
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  await client.downloadTo(sink, remote);
  return Buffer.concat(chunks);
};
/* oxlint-enable promise/prefer-await-to-callbacks */

// Remote path to list a child directory during the walk (the recovered key is
// tracked separately, so this only feeds the next list() call).
const childListPath = (dir: string, name: string): string => {
  if (dir === "" || dir === ".") {
    return name;
  }
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
};

type Resolved = { injected: Client } | { access: () => Promise<Client> };

const resolveConnection = (opts: FtpAdapterOptions): Resolved => {
  if (opts.client) {
    return { injected: opts.client };
  }
  const host = opts.host ?? readEnv("FTP_HOST");
  if (!host) {
    throw new FilesError(
      "Provider",
      "ftp adapter: missing connection. Pass `host` (and `user` / `password`), set FTP_HOST / FTP_USERNAME / FTP_PASSWORD, or pass a pre-connected `client`."
    );
  }
  const envPort = readEnv("FTP_PORT");
  const envSecure = readEnv("FTP_SECURE");
  const user = opts.user ?? readEnv("FTP_USERNAME") ?? readEnv("FTP_USER");
  const password = opts.password ?? readEnv("FTP_PASSWORD");
  let { secure } = opts;
  if (secure === undefined) {
    if (envSecure === "implicit") {
      secure = "implicit";
    } else if (envSecure === "true") {
      secure = true;
    }
  }
  const accessConfig = {
    host,
    port: opts.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),
    ...(user && { user }),
    ...(password && { password }),
    ...(secure !== undefined && { secure }),
    ...(opts.secureOptions && { secureOptions: opts.secureOptions }),
  };
  const access = async (): Promise<Client> => {
    const client = new Client(opts.timeout);
    await client.access(accessConfig);
    return client;
  };
  return { access };
};

export const ftp = (opts: FtpAdapterOptions = {}): FtpAdapter => {
  const resolved = resolveConnection(opts);
  const root = opts.root ?? ".";
  const { publicBaseUrl } = opts;

  // Directory to start list() from: the configured root, defaulting to "."
  // (the login directory).
  const remoteRoot = (() => {
    const inner = trimSlashes(root === "." ? "" : root);
    if (!inner) {
      return root.startsWith("/") ? "/" : ".";
    }
    return root.startsWith("/") ? `/${inner}` : inner;
  })();

  const keyToRemote = (key: string): string => joinRemotePath(root, key);

  const acquire = async (): Promise<{
    client: Client;
    release: () => void;
  }> => {
    if ("injected" in resolved) {
      return {
        client: resolved.injected,
        release: () => {
          // injected client: the caller owns the connection lifecycle.
        },
      };
    }
    const client = await resolved.access();
    let released = false;
    return {
      client,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        try {
          client.close();
        } catch {
          // best-effort: a close failure must not mask the operation result.
        }
      },
    };
  };

  const run = async <T>(
    signal: AbortSignal | undefined,
    fn: (client: Client) => Promise<T>
  ): Promise<T> => {
    const { client, release } = await acquire();
    const onAbort = (): void => {
      release();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await fn(client);
    } catch (error) {
      throw mapFtpError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      release();
    }
  };

  // Last-modified is an optional MDTM probe; many servers don't support it, so
  // a failure just yields `undefined` rather than failing the whole call.
  const tryLastMod = async (
    client: Client,
    remote: string
  ): Promise<number | undefined> => {
    try {
      return lastModMs(await client.lastMod(remote));
    } catch {
      // MDTM unsupported by this server — leave last-modified undefined.
    }
  };

  const lazyDownload = (key: string) => async (): Promise<Uint8Array> => {
    const buf = await run(undefined, (client) =>
      downloadToBuffer(client, keyToRemote(key))
    );
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  };

  const adapter: FtpAdapter = {
    async copy(from, to, opts2) {
      const fromRemote = keyToRemote(from);
      const toRemote = keyToRemote(to);
      await run(opts2?.signal, async (client) => {
        // No server-side copy in FTP: download the bytes, then re-upload.
        // Download happens first, while cwd is still the login dir; ensureDir
        // (which changes cwd) only runs for the upload leg.
        const buf = await downloadToBuffer(client, fromRemote);
        await uploadInto(client, toRemote, Readable.from(buf));
      });
    },
    async delete(key, opts2) {
      const remote = keyToRemote(key);
      await run(opts2?.signal, async (client) => {
        // ignoreErrorCodes=true → idempotent: a missing file is not an error.
        await client.remove(remote, true);
      });
    },
    async deleteMany(
      keys,
      opts2?: DeleteManyOptions
    ): Promise<DeleteManyResult> {
      const deleted: string[] = [];
      const errors: DeleteManyError[] = [];
      if (keys.length === 0) {
        return { deleted };
      }
      // One connection, sequential deletes — a socket per key (the default
      // fan-out) would trip FTP servers' per-IP connection limits.
      await run(undefined, async (client) => {
        for (const key of keys) {
          try {
            await client.remove(keyToRemote(key), true);
            deleted.push(key);
          } catch (error) {
            errors.push({ error: mapFtpError(error), key });
            if (opts2?.stopOnError) {
              return;
            }
          }
        }
      });
      return errors.length === 0 ? { deleted } : { deleted, errors };
    },
    async download(key, downloadOpts?: DownloadOptions): Promise<StoredFile> {
      const remote = keyToRemote(key);
      if (downloadOpts?.as === "stream") {
        // The stream outlives this method, so we bypass `run`'s finally-close
        // and release the connection when the stream ends, errors, or closes.
        const { client, release } = await acquire();
        try {
          const size = await client.size(remote);
          const lastModified = await tryLastMod(client, remote);
          const pass = new PassThrough();
          const cleanup = (): void => {
            release();
          };
          pass.once("end", cleanup);
          pass.once("error", cleanup);
          pass.once("close", cleanup);
          if (downloadOpts.signal) {
            downloadOpts.signal.addEventListener(
              "abort",
              () => {
                pass.destroy();
                release();
              },
              { once: true }
            );
          }
          // Kick off the transfer without awaiting; basic-ftp pipes the data
          // socket into `pass` and resolves when it completes.
          // oxlint-disable-next-line promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- fire-and-forget: errors surface on the returned stream.
          client.downloadTo(pass, remote).catch((error: unknown) => {
            pass.destroy(error as Error);
          });
          return createStoredFile(
            {
              key,
              ...(lastModified !== undefined && { lastModified }),
              size,
              type: inferTypeFromName(key),
            },
            {
              factory: () =>
                Readable.toWeb(pass) as unknown as ReadableStream<Uint8Array>,
              kind: "stream",
            }
          );
        } catch (error) {
          release();
          throw mapFtpError(error);
        }
      }
      return run(downloadOpts?.signal, async (client) => {
        const buf = await downloadToBuffer(client, remote);
        const lastModified = await tryLastMod(client, remote);
        const bytes = new Uint8Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength
        );
        return createStoredFile(
          {
            key,
            ...(lastModified !== undefined && { lastModified }),
            size: bytes.byteLength,
            type: inferTypeFromName(key),
          },
          { data: bytes, kind: "buffer" }
        );
      });
    },
    exists(key, opts2?: OperationOptions) {
      const remote = keyToRemote(key);
      return existsByProbe(
        () =>
          run(opts2?.signal, async (client) => {
            await client.size(remote);
          }),
        mapFtpError
      );
    },
    head(key, opts2?: OperationOptions): Promise<StoredFile> {
      const remote = keyToRemote(key);
      return run(opts2?.signal, async (client) => {
        const size = await client.size(remote);
        const lastModified = await tryLastMod(client, remote);
        return createStoredFile(
          {
            key,
            ...(lastModified !== undefined && { lastModified }),
            size,
            type: inferTypeFromName(key),
          },
          { factory: lazyDownload(key), kind: "lazy" }
        );
      });
    },
    list(options?: ListOptions): Promise<ListResult> {
      return run(options?.signal, async (client) => {
        const keys: string[] = [];
        const meta = new Map<string, { size: number; lastModified?: number }>();
        const walk = async (dir: string, prefix: string): Promise<void> => {
          const entries: FileInfo[] = await client.list(dir);
          for (const entry of entries) {
            if (entry.isSymbolicLink) {
              // Skip symlinks: following them risks loops and root escapes.
              continue;
            }
            const childKey = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory) {
              await walk(childListPath(dir, entry.name), childKey);
            } else {
              keys.push(childKey);
              meta.set(childKey, {
                ...(lastModMs(entry.modifiedAt) !== undefined && {
                  lastModified: lastModMs(entry.modifiedAt),
                }),
                size: entry.size,
              });
            }
          }
        };
        try {
          await walk(remoteRoot, "");
        } catch (error) {
          // An empty/nonexistent root lists as empty, matching the fs adapter.
          if (mapFtpError(error).code === "NotFound") {
            return { items: [] };
          }
          throw error;
        }
        keys.sort(compareKeys);
        const page = paginateKeys(keys, {
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
              type: inferTypeFromName(key),
            },
            { factory: lazyDownload(key), kind: "lazy" }
          );
        });
        return {
          items,
          ...(page.cursor !== undefined && { cursor: page.cursor }),
        };
      });
    },
    name: "ftp",
    get raw(): FtpRaw {
      if ("injected" in resolved) {
        return resolved.injected;
      }
      return { connect: resolved.access };
    },
    get root() {
      return root;
    },
    signedUploadUrl(_key, _signOpts): Promise<SignedUpload> {
      return Promise.reject(
        new FilesError(
          "Provider",
          "ftp: signedUploadUrl() is not supported. FTP has no presigned-upload concept — use upload(), or inject a pre-connected `client` for batch transfers."
        )
      );
    },
    upload(key, body: Body, options): Promise<UploadResult> {
      if (options?.metadata && Object.keys(options.metadata).length > 0) {
        throw new FilesError(
          "Provider",
          "ftp: `metadata` is not supported. FTP files have no arbitrary-metadata field."
        );
      }
      if (options?.cacheControl) {
        throw new FilesError(
          "Provider",
          "ftp: `cacheControl` is not supported. FTP does not expose HTTP cache headers."
        );
      }
      const remote = keyToRemote(key);
      return run(options?.signal, async (client) => {
        const { data, contentType, contentLength } = await normalizeBody(
          body,
          options?.contentType
        );
        const source =
          data instanceof ReadableStream
            ? Readable.fromWeb(data as never)
            : Readable.from(uint8ToBuffer(data));
        await uploadInto(client, remote, source);
        let size = contentLength;
        if (size === undefined) {
          // Unknown-length stream: ask the server for the authoritative size.
          // cwd is restored to the login dir, so size the full remote path.
          size = await client.size(remote);
        }
        return { contentType, key, size } satisfies UploadResult;
      });
    },
    url(key, urlOpts): Promise<string> {
      // Validate the key (traversal guard) even though we don't connect.
      keyToRemote(key);
      if (publicBaseUrl) {
        const base = joinPublicUrl(publicBaseUrl, key);
        if (urlOpts?.responseContentDisposition) {
          const sep = base.includes("?") ? "&" : "?";
          return Promise.resolve(
            `${base}${sep}response-content-disposition=${encodeURIComponent(urlOpts.responseContentDisposition)}`
          );
        }
        return Promise.resolve(base);
      }
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "ftp: `responseContentDisposition` requires `publicBaseUrl`. FTP serves no HTTP and has no signature in which to bind the override."
        );
      }
      throw new FilesError(
        "Provider",
        "ftp: url() requires `publicBaseUrl`. FTP serves no HTTP and has no signing primitive; configure `publicBaseUrl` to point at an HTTP server fronting the same tree, or use download()."
      );
    },
  };
  return adapter;
};
