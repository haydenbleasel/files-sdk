import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import SftpClient from "ssh2-sftp-client";

import type {
  Adapter,
  Body,
  DeleteManyError,
  DeleteManyOptions,
  DeleteManyResult,
  DownloadOptions,
  ListOptions,
  ListResult,
  OffsetResumableDriver,
  OperationOptions,
  ResumableUploadSession,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  collectStream,
  existsByProbe,
  joinPublicUrl,
  makeErrorMapper,
  normalizeBody,
  rangedSize,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { inferTypeFromName } from "../internal/mime.js";
import { joinRemotePath, trimSlashes } from "../internal/remote-path.js";
import { createStoredFile } from "../internal/stored-file.js";
import { compareKeys, pageKeyList } from "../internal/walk-paginate.js";

export interface SftpAdapterOptions {
  /** SFTP host. Falls back to `SFTP_HOST`. */
  host?: string;
  /** Port. Falls back to `SFTP_PORT`, then `22`. */
  port?: number;
  /** Username. Falls back to `SFTP_USERNAME`. */
  username?: string;
  /**
   * Password authentication. Falls back to `SFTP_PASSWORD`. When both this and
   * `privateKey` are set, ssh2 tries the key first, then the password.
   */
  password?: string;
  /** Private key (PEM) for key-based auth. Falls back to `SFTP_PRIVATE_KEY`. */
  privateKey?: string | Buffer;
  /** Passphrase for an encrypted `privateKey`. Falls back to `SFTP_PASSPHRASE`. */
  passphrase?: string;
  /**
   * Remote base directory. Virtual keys resolve under it; keys that escape it
   * (e.g. `../etc/passwd`) throw `Provider`. An absolute root (`/uploads`)
   * yields absolute paths; the default (`"."`) keeps paths relative to the
   * connection's login directory — the common chroot/home case.
   */
  root?: string;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` — useful when an HTTP server fronts the same
   * tree. When unset, `url()` throws: SFTP serves no HTTP and has no signing
   * primitive.
   */
  publicBaseUrl?: string;
  /** Connection-ready timeout in milliseconds, passed through to ssh2. */
  readyTimeout?: number;
  /**
   * Extra ssh2 connect options merged into the resolved config (e.g.
   * `hostVerifier`, `algorithms`, `agent`). Wins over the discrete fields.
   */
  connectOptions?: SftpClient.ConnectOptions;
  /**
   * Pre-connected `ssh2-sftp-client` instance. When passed, the adapter reuses
   * it for every call and never opens or closes a connection — the caller owns
   * the socket lifecycle. This is the high-throughput path: connect once and
   * inject, rather than paying a handshake per operation.
   */
  client?: SftpClient;
}

export type SftpRaw = SftpClient | { connect: () => Promise<SftpClient> };
export type SftpAdapter = Adapter<SftpRaw> & { readonly root: string };

const DEFAULT_PORT = 22;

// ssh2 surfaces SFTP protocol failures as small integer status codes; map the
// ones we classify to the errno-style strings the error mapper keys on.
const SFTP_STATUS_CODE: Readonly<Record<number, string>> = {
  2: "ENOENT",
  3: "EACCES",
  4: "FAILURE",
};

export const mapSftpError = makeErrorMapper({
  codes: {
    conflict: new Set(["EEXIST"]),
    notFound: new Set(["ENOENT", "ENOTDIR", "NO_SUCH_FILE"]),
    unauthorized: new Set(["EACCES", "EPERM", "EAUTH", "EAUTHFAIL"]),
  },
  // SFTP errors aren't HTTP — classify purely on the (normalized) string code,
  // with a message sniff for the auth/transport cases ssh2 reports as plain
  // Error without a useful `.code`. Leave `status` unset so the HTTP buckets
  // never fire.
  extract: (err) => {
    const e = err as { code?: number | string; message?: string };
    let code: string | undefined;
    if (typeof e?.code === "number") {
      code = SFTP_STATUS_CODE[e.code];
    } else if (typeof e?.code === "string") {
      ({ code } = e);
    }
    const message = typeof e?.message === "string" ? e.message : undefined;
    if (!code && message) {
      if (/no such file|not found/iu.test(message)) {
        code = "ENOENT";
      } else if (
        /permission denied|all configured authentication|authentication failed/iu.test(
          message
        )
      ) {
        code = "EACCES";
      }
    }
    return { ...(code && { code }), ...(message && { message }) };
  },
  providerLabel: "SFTP error",
});

const uint8ToBuffer = (u8: Uint8Array): Buffer =>
  Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

const bufferToUint8 = (buf: Buffer): Uint8Array =>
  new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

// Parent directory of a remote path. "" when the path has no directory
// component (a bare filename in the login dir); "/" stays "/".
const remoteDirname = (path: string): string => {
  const idx = path.lastIndexOf("/");
  if (idx === -1) {
    return "";
  }
  return idx === 0 ? "/" : path.slice(0, idx);
};

type Resolved =
  | { injected: SftpClient }
  | { connectConfig: SftpClient.ConnectOptions };

const resolveConnection = (opts: SftpAdapterOptions): Resolved => {
  if (opts.client) {
    return { injected: opts.client };
  }
  const host = opts.host ?? readEnv("SFTP_HOST");
  const username = opts.username ?? readEnv("SFTP_USERNAME");
  if (!(host && username)) {
    throw new FilesError(
      "Provider",
      "sftp adapter: missing connection. Pass `host` + `username` (and `password` or `privateKey`), set SFTP_HOST / SFTP_USERNAME / SFTP_PASSWORD / SFTP_PRIVATE_KEY, or pass a pre-connected `client`."
    );
  }
  const envPort = readEnv("SFTP_PORT");
  const password = opts.password ?? readEnv("SFTP_PASSWORD");
  const privateKey = opts.privateKey ?? readEnv("SFTP_PRIVATE_KEY");
  const passphrase = opts.passphrase ?? readEnv("SFTP_PASSPHRASE");
  const connectConfig: SftpClient.ConnectOptions = {
    host,
    port: opts.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),
    username,
    ...(password && { password }),
    ...(privateKey && { privateKey }),
    ...(passphrase && { passphrase }),
    ...(opts.readyTimeout !== undefined && { readyTimeout: opts.readyTimeout }),
    ...opts.connectOptions,
  };
  return { connectConfig };
};

export const sftp = (opts: SftpAdapterOptions = {}): SftpAdapter => {
  const resolved = resolveConnection(opts);
  const root = opts.root ?? ".";
  const { publicBaseUrl } = opts;

  // Starting directory for list(): the configured root as an absolute or
  // relative path, defaulting to "." (login dir) when empty.
  const remoteRoot = (() => {
    const inner = trimSlashes(root === "." ? "" : root);
    if (!inner) {
      return root.startsWith("/") ? "/" : ".";
    }
    return root.startsWith("/") ? `/${inner}` : inner;
  })();

  const keyToRemote = (key: string): string => joinRemotePath(root, key);

  const connectNew = async (): Promise<SftpClient> => {
    const client = new SftpClient();
    if ("connectConfig" in resolved) {
      await client.connect(resolved.connectConfig);
    }
    return client;
  };

  // Connect-per-operation with an injectable-client escape hatch. An injected
  // client is reused and never closed; an owned connection is opened fresh and
  // closed in the caller's `finally`. `release` is idempotent so the abort
  // listener and the `finally` can both call it.
  const acquire = async (): Promise<{
    client: SftpClient;
    release: () => Promise<void>;
  }> => {
    if ("injected" in resolved) {
      return { client: resolved.injected, release: () => Promise.resolve() };
    }
    const client = await connectNew();
    let released = false;
    return {
      client,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        try {
          await client.end();
        } catch {
          // best-effort: a close failure must not mask the operation result.
        }
      },
    };
  };

  const run = async <T>(
    signal: AbortSignal | undefined,
    fn: (client: SftpClient) => Promise<T>
  ): Promise<T> => {
    const { client, release } = await acquire();
    // On abort, tear the socket down so the in-flight op stops promptly. The
    // core (`runWithSignal`) has already rejected the caller's promise; this
    // just stops us holding the connection until the op finishes naturally.
    const onAbort = (): void => {
      void release();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await fn(client);
    } catch (error) {
      throw mapSftpError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await release();
    }
  };

  const ensureParentDir = async (
    client: SftpClient,
    remote: string
  ): Promise<void> => {
    const dir = remoteDirname(remote);
    if (dir && dir !== "/") {
      // recursive mkdir is idempotent in ssh2-sftp-client.
      await client.mkdir(dir, true);
    }
  };

  const lazyDownload = (key: string) => (): Promise<Uint8Array> =>
    run(undefined, async (client) => {
      const buf = (await client.get(keyToRemote(key))) as Buffer;
      return bufferToUint8(buf);
    });

  const adapter: SftpAdapter = {
    async copy(from, to, opts2) {
      const fromRemote = keyToRemote(from);
      const toRemote = keyToRemote(to);
      // SFTP has no portable server-side copy, so round-trip the bytes through
      // the client over a single connection. Buffers the whole object — see
      // the adapter docs for the large-file caveat.
      await run(opts2?.signal, async (client) => {
        const buf = (await client.get(fromRemote)) as Buffer;
        await ensureParentDir(client, toRemote);
        await client.put(buf, toRemote);
      });
    },
    async delete(key, opts2) {
      const remote = keyToRemote(key);
      await run(opts2?.signal, async (client) => {
        // noErrorOK=true → idempotent: a missing file is not an error.
        await client.delete(remote, true);
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
      // One connection, sequential deletes — opening a socket per key (the
      // default fan-out) would trip server session limits.
      await run(undefined, async (client) => {
        for (const key of keys) {
          try {
            await client.delete(keyToRemote(key), true);
            deleted.push(key);
          } catch (error) {
            errors.push({ error: mapSftpError(error), key });
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
      const range = downloadOpts?.range;
      // SFTP read streams take native `start`/`end` byte offsets (both
      // inclusive, like Node's fs streams and our ByteRange), so a range maps
      // straight through with no client-side slicing. An omitted `end` reads to
      // EOF.
      const readStreamOptions = range
        ? {
            start: range.start,
            ...(range.end !== undefined && { end: range.end }),
          }
        : undefined;
      if (downloadOpts?.as === "stream") {
        // Streaming holds the connection open until the stream is consumed, so
        // we bypass `run`'s finally-close and instead release when the stream
        // ends, errors, or closes.
        const { client, release } = await acquire();
        try {
          const stat = await client.stat(remote);
          const nodeStream = client.createReadStream(remote, readStreamOptions);
          const cleanup = (): void => {
            void release();
          };
          nodeStream.once("end", cleanup);
          nodeStream.once("error", cleanup);
          nodeStream.once("close", cleanup);
          if (downloadOpts.signal) {
            downloadOpts.signal.addEventListener(
              "abort",
              () => {
                nodeStream.destroy();
                void release();
              },
              { once: true }
            );
          }
          return createStoredFile(
            {
              key,
              ...(Number.isFinite(stat.modifyTime) && {
                lastModified: stat.modifyTime,
              }),
              size: range ? rangedSize(stat.size, range) : stat.size,
              type: inferTypeFromName(key),
            },
            {
              factory: () =>
                Readable.toWeb(
                  nodeStream as unknown as Readable
                ) as unknown as ReadableStream<Uint8Array>,
              kind: "stream",
            }
          );
        } catch (error) {
          await release();
          throw mapSftpError(error);
        }
      }
      return run(downloadOpts?.signal, async (client) => {
        const stat = await client.stat(remote);
        let bytes: Uint8Array;
        if (readStreamOptions) {
          // Ranged read: `createReadStream` carries the native start/end byte
          // offsets (the `get()` options type doesn't surface them). Drain it
          // into a buffer for the non-stream response.
          const nodeStream = client.createReadStream(remote, readStreamOptions);
          bytes = await collectStream(
            Readable.toWeb(
              nodeStream as unknown as Readable
            ) as unknown as ReadableStream<Uint8Array>
          );
        } else {
          const buf = (await client.get(remote)) as Buffer;
          bytes = bufferToUint8(buf);
        }
        return createStoredFile(
          {
            key,
            ...(Number.isFinite(stat.modifyTime) && {
              lastModified: stat.modifyTime,
            }),
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
            const type = await client.exists(remote);
            if (type === false || type === "d") {
              throw new FilesError(
                "NotFound",
                `sftp: ${key} is not a file (exists=${String(type)})`
              );
            }
          }),
        mapSftpError
      );
    },
    head(key, opts2?: OperationOptions): Promise<StoredFile> {
      const remote = keyToRemote(key);
      return run(opts2?.signal, async (client) => {
        const stat = await client.stat(remote);
        if (stat.isDirectory) {
          throw new FilesError("NotFound", `sftp: ${key} is a directory`);
        }
        return createStoredFile(
          {
            key,
            ...(Number.isFinite(stat.modifyTime) && {
              lastModified: stat.modifyTime,
            }),
            size: stat.size,
            type: inferTypeFromName(key),
          },
          { factory: lazyDownload(key), kind: "lazy" }
        );
      });
    },
    list(options?: ListOptions): Promise<ListResult> {
      return run(options?.signal, async (client) => {
        const keys: string[] = [];
        const meta = new Map<string, { size: number; modifyTime: number }>();
        const walk = async (dir: string, prefix: string): Promise<void> => {
          const entries = await client.list(dir);
          for (const entry of entries) {
            if (entry.type === "l") {
              // Skip symlinks: following them risks loops and root escapes.
              continue;
            }
            const childKey = prefix ? `${prefix}/${entry.name}` : entry.name;
            const childPath =
              dir === "/" ? `/${entry.name}` : `${dir}/${entry.name}`;
            if (entry.type === "d") {
              await walk(childPath, childKey);
            } else {
              keys.push(childKey);
              meta.set(childKey, {
                modifyTime: entry.modifyTime,
                size: entry.size,
              });
            }
          }
        };
        try {
          await walk(remoteRoot, "");
        } catch (error) {
          // An empty/nonexistent root lists as empty, matching the fs adapter.
          if (mapSftpError(error).code === "NotFound") {
            return { items: [] };
          }
          throw error;
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
              ...(m &&
                Number.isFinite(m.modifyTime) && {
                  lastModified: m.modifyTime,
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
          ...(page.prefixes && { prefixes: page.prefixes }),
        };
      });
    },
    async move(from, to, opts2) {
      const fromRemote = keyToRemote(from);
      const toRemote = keyToRemote(to);
      await run(opts2?.signal, async (client) => {
        // Native rename — no body round-trip. Ensure the destination's parent
        // exists first (rename won't create it). Base SFTP `rename` fails if
        // the destination already exists on many servers; that's the move
        // contract here (the caller deletes/overwrites the target first if
        // needed) and keeps the rename atomic.
        await ensureParentDir(client, toRemote);
        await client.rename(fromRemote, toRemote);
      });
    },
    name: "sftp",
    get raw(): SftpRaw {
      return "injected" in resolved
        ? resolved.injected
        : { connect: connectNew };
    },
    resumableUpload(key, resumableOpts): OffsetResumableDriver {
      const remote = keyToRemote(key);
      return {
        adopt(session: ResumableUploadSession) {
          if (session.provider !== "sftp") {
            throw new FilesError(
              "Provider",
              `Cannot resume a ${session.provider} session on an sftp adapter.`
            );
          }
          if (session.key !== key) {
            throw new FilesError(
              "Provider",
              "Resume token does not match this upload's key."
            );
          }
        },
        async begin(): Promise<ResumableUploadSession> {
          // `metadata` / `cacheControl` are rejected centrally by the Files
          // wrapper before a resumable upload ever reaches here.
          await run(undefined, async (client) => {
            await ensureParentDir(client, remote);
            // Clear any stale partial so appended chunks build a fresh file.
            await client.delete(remote, true);
          });
          return { key, provider: "sftp" };
        },
        complete(): Promise<UploadResult> {
          return run(undefined, async (client) => {
            const stat = await client.stat(remote);
            return {
              contentType: inferTypeFromName(key),
              key,
              ...(Number.isFinite(stat.modifyTime) && {
                lastModified: stat.modifyTime,
              }),
              size: stat.size,
            };
          });
        },
        async discard() {
          await run(undefined, (client) => client.delete(remote, true));
        },
        mode: "offset",
        partSize:
          typeof resumableOpts.multipart === "object" &&
          resumableOpts.multipart.partSize
            ? resumableOpts.multipart.partSize
            : 8 * 1024 * 1024,
        probe(): Promise<{ nextOffset: number }> {
          return run(undefined, async (client) => {
            try {
              const stat = await client.stat(remote);
              return { nextOffset: stat.size };
            } catch {
              // No partial yet — start from the top.
              return { nextOffset: 0 };
            }
          });
        },
        uploadAt({ offset, data, signal }): Promise<{ nextOffset: number }> {
          return run(signal, async (client) => {
            // append() writes at the server-side EOF, not at `offset` — so
            // verify the remote size still matches before appending. A
            // per-chunk retry after a partial append (or a lost success
            // reply) would otherwise append the whole chunk again, silently
            // corrupting the file with duplicated bytes. On a mismatch, skip
            // the write and report the server's real offset so the
            // orchestrator re-slices from there.
            let current: number | undefined;
            try {
              const stat = await client.stat(remote);
              current = stat.size;
            } catch {
              // No partial yet — append as-is.
            }
            if (current !== undefined && current !== offset) {
              return { nextOffset: current };
            }
            await client.append(uint8ToBuffer(data), remote);
            return { nextOffset: offset + data.byteLength };
          });
        },
      };
    },
    get root() {
      return root;
    },
    signedUploadUrl(_key, _signOpts): Promise<SignedUpload> {
      return Promise.reject(
        new FilesError(
          "Provider",
          "sftp: signedUploadUrl() is not supported. SFTP has no presigned-upload concept — use upload(), or inject a pre-connected `client` for batch transfers."
        )
      );
    },
    supportsDelimiter: true,
    supportsRange: true,
    upload(key, body: Body, options): Promise<UploadResult> {
      // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
      // (this adapter advertises neither) — SFTP files have no
      // arbitrary-metadata or cache-header field.
      //
      // No `reportsUploadProgress`: ssh2-sftp-client's `step` byte-progress
      // callback is only wired into `fastPut`/`fastGet` (local-file paths). The
      // `put` form we use for Buffer/stream bodies pipes through a write stream
      // with no progress hook, so rather than fake granular progress we leave it
      // unset and let the Files wrapper report generically (byte-level for
      // stream bodies, start/finish for buffered ones).
      const remote = keyToRemote(key);
      return run(options?.signal, async (client) => {
        const { data, contentType, contentLength } = await normalizeBody(
          body,
          options?.contentType
        );
        await ensureParentDir(client, remote);
        // Direct write (not temp+rename): base SFTP `rename` fails when the
        // destination exists on many servers, which would break overwrite —
        // and overwrite is the expected upload semantics everywhere else.
        const input =
          data instanceof ReadableStream
            ? Readable.fromWeb(data as never)
            : uint8ToBuffer(data);
        await client.put(input, remote);
        let size = contentLength;
        if (size === undefined) {
          const stat = await client.stat(remote);
          ({ size } = stat);
        }
        return { contentType, key, size } satisfies UploadResult;
      });
    },
    url(key, urlOpts): Promise<string> {
      // Validate the key (traversal guard) even though we don't connect.
      keyToRemote(key);
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "sftp: `responseContentDisposition` is not supported. SFTP publicBaseUrl URLs are static HTTP-front URLs, with no signature in which to bind the override."
        );
      }
      if (publicBaseUrl) {
        return Promise.resolve(joinPublicUrl(publicBaseUrl, key));
      }
      throw new FilesError(
        "Provider",
        "sftp: url() requires `publicBaseUrl`. SFTP serves no HTTP and has no signing primitive; configure `publicBaseUrl` to point at an HTTP server fronting the same tree, or use download()."
      );
    },
  };
  return adapter;
};
