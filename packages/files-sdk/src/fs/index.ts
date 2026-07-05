import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

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
  collectStream,
  existsByProbe,
  joinPublicUrl,
  rangedSize,
} from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import type { ProviderFilesErrorCode } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";
import { pageKeyList } from "../internal/walk-paginate.js";

export interface FsAdapterOptions {
  /**
   * Absolute or relative directory the adapter manages. Created on first
   * upload if it doesn't exist. All operations are scoped to this root —
   * keys that resolve outside it (e.g. `../etc/passwd`) throw `Provider`.
   */
  root: string;
  /**
   * Optional URL prefix for `url()`. When set, `url(key)` returns
   * `${urlBaseUrl}/${key}` — useful when a dev server (Next.js `/public`
   * mount, `serve-static`, etc.) is exposing the same root. When unset,
   * `url()` returns a `file://` URL — appropriate for CLIs/tests, not
   * for browsers.
   */
  urlBaseUrl?: string;
  /**
   * Accepted for backward compatibility but ignored. `url()` returns a
   * `file://` or static-server URL, and `signedUploadUrl()` fails closed
   * because the fs adapter has no built-in upload signer or verifier.
   */
  defaultUrlExpiresIn?: number;
}

export type FsAdapter = Adapter<{ root: string }> & { readonly root: string };

const SIDECAR_SUFFIX = ".meta.json";
// Partial body of an in-progress resumable upload. Reserved like the sidecar:
// `walk()` skips it so a paused upload's partial never surfaces in `list()`,
// and `resolveKeyPath` rejects keys that would land on one.
const RESUMABLE_SUFFIX = ".fls-part";
const ETAG_HEX_LEN = 16;

interface Sidecar {
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  etag: string;
  lastModified: number;
}

const errorCode = (err: unknown): string | undefined => {
  if (err && typeof err === "object" && "code" in err) {
    const { code } = err as { code?: unknown };
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
};

const classifyFsError = (code: string | undefined): ProviderFilesErrorCode => {
  if (code === "ENOENT" || code === "ENOTDIR") {
    return "NotFound";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "Unauthorized";
  }
  if (code === "EEXIST") {
    return "Conflict";
  }
  return "Provider";
};

const DEFAULT_MESSAGES: Record<ProviderFilesErrorCode, string> = {
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: "fs error",
  Unauthorized: "Unauthorized",
};

export const mapFsError = (err: unknown): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  const code = classifyFsError(errorCode(err));
  const message =
    err instanceof Error
      ? err.message
      : (DEFAULT_MESSAGES[code] ?? String(err));
  return new FilesError(code, message, err);
};

const stringBodyEncoder = new TextEncoder();

// Stream bodies are handled separately by `writeStreamToTempThenRename`, so
// this helper only sees the bytes-shaped variants.
type NonStreamBody = Exclude<Body, ReadableStream<Uint8Array>>;

const bodyToBytes = async (body: NonStreamBody): Promise<Uint8Array> => {
  if (typeof body === "string") {
    return stringBodyEncoder.encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return new Uint8Array(await body.arrayBuffer());
};

const defaultContentType = (body: Body, override?: string): string => {
  if (override) {
    return override;
  }
  if (typeof body === "string") {
    return "text/plain; charset=utf-8";
  }
  if (body instanceof Blob && body.type) {
    return body.type;
  }
  return "application/octet-stream";
};

const sha1Etag = (bytes: Uint8Array): string => {
  const hex = createHash("sha1").update(bytes).digest("hex");
  return `"${hex.slice(0, ETAG_HEX_LEN)}"`;
};

// Windows ignores trailing dots and spaces in a path segment, so
// `x.meta.json.` and `x.meta.json ` open the same file as `x.meta.json`.
// The `(?<![. ])` anchors each match to the first character of the trailing
// noise run, so the engine can't re-attempt at every dot/space — that
// backtracking is what makes a bare `[. ]+$` polynomial (ReDoS) on input like
// `"x.meta.json....    "`.
const FS_TRAILING_NOISE = /(?<![. ])[. ]+$/u;

// True when `resolved`'s final segment lands on a reserved sidecar path.
// We compare the basename the way the filesystem resolves names — folded
// to lower case for case-insensitive volumes (APFS, NTFS — the macOS /
// Windows machines this dev-oriented adapter mostly runs on) and with
// trailing dots/spaces stripped for Windows — so re-cased or dot-padded
// variants like `x.META.JSON` or `x.meta.json.` can't slip a body onto
// another key's sidecar. Operating on the resolved basename (not the raw
// key) also folds away `..` and trailing-slash dodges like `x.meta.json/`.
const aliasesSidecarPath = (resolved: string): boolean => {
  const name = path
    .basename(resolved)
    .replace(FS_TRAILING_NOISE, "")
    .toLowerCase();
  return name.endsWith(SIDECAR_SUFFIX) || name.endsWith(RESUMABLE_SUFFIX);
};

// `path.resolve` collapses `..` segments, so a key like
// `../../etc/passwd` resolves outside `root`. We compare the resolved path
// against `root` to reject those before any fs operation runs. Without
// this check, `download("../../../etc/passwd")` would happily exfiltrate
// from the host filesystem.
const resolveKeyPath = (root: string, key: string): string => {
  const resolved = path.resolve(root, key);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new FilesError(
      "Provider",
      `fs: key escapes adapter root: ${JSON.stringify(key)}`
    );
  }
  // Disallow keys that map directly to the root (empty segment after
  // resolve) — there's no meaningful body at the root path itself.
  if (resolved === root) {
    throw new FilesError(
      "Provider",
      "fs: key resolves to the adapter root directory"
    );
  }
  // The adapter stores per-object metadata in a sidecar at
  // `${bodyPath}${SIDECAR_SUFFIX}`. A key whose body path lands on another
  // key's sidecar lets a same-root caller silently rewrite that key's
  // stored contentType / etag / metadata (upload), wipe them (delete), or
  // hide bytes from `list()` (walk() filters the suffix). Reject anything
  // that resolves to a sidecar path so the namespace stays unambiguous.
  if (aliasesSidecarPath(resolved)) {
    throw new FilesError(
      "Provider",
      `fs: keys ending in ${SIDECAR_SUFFIX} are reserved for adapter sidecars: ${JSON.stringify(key)}`
    );
  }
  return resolved;
};

const realpathUnderRoot = async (
  root: string,
  target: string,
  key: string
): Promise<string> => {
  const [realRoot, realTarget] = await Promise.all([
    fsp.realpath(root),
    fsp.realpath(target),
  ]);
  const rootWithSep = realRoot.endsWith(path.sep)
    ? realRoot
    : realRoot + path.sep;
  if (realTarget !== realRoot && !realTarget.startsWith(rootWithSep)) {
    throw new FilesError(
      "Provider",
      `fs: key resolves outside adapter root: ${JSON.stringify(key)}`
    );
  }
  return realTarget;
};

const sidecarPathOf = (bodyPath: string): string => bodyPath + SIDECAR_SUFFIX;

const readSidecar = async (bodyPath: string): Promise<Sidecar | undefined> => {
  try {
    const raw = await fsp.readFile(sidecarPathOf(bodyPath), "utf-8");
    const parsed = JSON.parse(raw) as Partial<Sidecar>;
    if (
      typeof parsed.contentType === "string" &&
      typeof parsed.etag === "string" &&
      typeof parsed.lastModified === "number"
    ) {
      return parsed as Sidecar;
    }
    return undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw mapFsError(error);
  }
};

const writeSidecar = async (
  bodyPath: string,
  sidecar: Sidecar
): Promise<void> => {
  await fsp.writeFile(sidecarPathOf(bodyPath), JSON.stringify(sidecar));
};

const ensureDirFor = async (filePath: string): Promise<void> => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
};

// Best-effort delete used in error-recovery and copy-without-source-sidecar
// paths. We deliberately swallow errors: the calling site is already in a
// failure or cleanup branch where surfacing a secondary error obscures the
// real one (or in the copy case, a missing destination sidecar is the
// desired state, so any rm error is moot).
const bestEffortRm = async (target: string): Promise<void> => {
  try {
    await fsp.rm(target, { force: true });
  } catch {
    // ignore — this is a best-effort cleanup, see comment above
  }
};

// Walk the tree under `root`, yielding posix-style relative keys for every
// non-sidecar regular file. We use `withFileTypes` to avoid an extra `stat`
// per entry, and skip sidecars at the leaf so they never surface as
// user-visible objects.
const walk = async function* walk(root: string): AsyncIterable<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) {
      continue;
    }
    let entries: Dirent[];
    try {
      // eslint-disable-next-line no-await-in-loop -- stack-based tree walk reads one directory per iteration.
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (
        entry.name.endsWith(SIDECAR_SUFFIX) ||
        entry.name.endsWith(RESUMABLE_SUFFIX)
      ) {
        continue;
      }
      // Yield posix-style keys regardless of host OS so callers see the
      // same key shape on Windows and Unix. `path.relative` returns the
      // platform separator; replace it before yielding.
      const rel = path.relative(root, abs).split(path.sep).join("/");
      yield rel;
    }
  }
};

const compareKeys = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

const writeStreamToTempThenRename = async (
  bodyPath: string,
  stream: ReadableStream<Uint8Array>
): Promise<{ bytes: Uint8Array; size: number }> => {
  const tempPath = `${bodyPath}.${process.pid}.${Date.now()}.tmp`;
  // We need both the bytes (for hashing + size) and a written file. Drain
  // into a Uint8Array first, then write atomically via temp-file + rename.
  // The sole alternative — pipe to disk while hashing in parallel — needs
  // a tee, which doubles memory anyway for any source that isn't
  // back-pressured (and the typical caller passes a small dev body).
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- single stream reader; chunks arrive sequentially.
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    await fsp.writeFile(tempPath, bytes);
    await fsp.rename(tempPath, bodyPath);
  } catch (error) {
    // Best-effort cleanup of the temp file on failure. `rm` with `force`
    // swallows ENOENT if rename already moved it.
    await bestEffortRm(tempPath);
    throw error;
  }
  return { bytes, size: total };
};

export const fs = (opts: FsAdapterOptions): FsAdapter => {
  if (!opts.root) {
    throw new FilesError("Provider", "fs adapter: missing `root` directory.");
  }
  const root = path.resolve(opts.root);
  const { urlBaseUrl } = opts;

  const storedFromSidecar = (
    key: string,
    bodyPath: string,
    sidecar: Sidecar | undefined,
    size: number,
    mtimeMs: number
  ): StoredFile => {
    const meta = {
      ...(sidecar?.etag && { etag: sidecar.etag }),
      key,
      lastModified: sidecar?.lastModified ?? mtimeMs,
      ...(sidecar?.metadata && { metadata: sidecar.metadata }),
      size,
      type: sidecar?.contentType ?? "application/octet-stream",
    };
    return createStoredFile(meta, {
      factory: async () => {
        try {
          const buf = await fsp.readFile(bodyPath);
          return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        } catch (error) {
          throw mapFsError(error);
        }
      },
      kind: "lazy",
    });
  };

  return {
    async copy(from, to) {
      const fromPath = resolveKeyPath(root, from);
      const toPath = resolveKeyPath(root, to);
      try {
        const realFromPath = await realpathUnderRoot(root, fromPath, from);
        await ensureDirFor(toPath);
        await fsp.copyFile(realFromPath, toPath);
        // If the source had a sidecar, copy it (refreshing
        // `lastModified`). If not, mirror that by removing any stale
        // destination sidecar from a prior upload at the same key —
        // synthesizing one would require re-reading the body to hash it.
        const sidecar = await readSidecar(fromPath);
        await (sidecar
          ? writeSidecar(toPath, { ...sidecar, lastModified: Date.now() })
          : bestEffortRm(sidecarPathOf(toPath)));
      } catch (error) {
        throw mapFsError(error);
      }
    },
    async delete(key) {
      const bodyPath = resolveKeyPath(root, key);
      try {
        // `force: true` makes both unlinks idempotent — matches the
        // silent-on-missing behavior of S3/Azure.
        await fsp.rm(bodyPath, { force: true });
        await fsp.rm(sidecarPathOf(bodyPath), { force: true });
      } catch (error) {
        throw mapFsError(error);
      }
    },
    async download(key, downloadOpts) {
      const bodyPath = resolveKeyPath(root, key);
      try {
        const realBodyPath = await realpathUnderRoot(root, bodyPath, key);
        const stat = await fsp.stat(realBodyPath);
        const sidecar = await readSidecar(bodyPath);
        const baseMeta = {
          ...(sidecar?.etag && { etag: sidecar.etag }),
          key,
          lastModified: sidecar?.lastModified ?? stat.mtimeMs,
          ...(sidecar?.metadata && { metadata: sidecar.metadata }),
          type: sidecar?.contentType ?? "application/octet-stream",
        };
        const range = downloadOpts?.range;
        // Node's createReadStream takes inclusive `start`/`end` byte offsets,
        // matching ByteRange; an omitted `end` reads to EOF.
        const streamRange = range
          ? {
              start: range.start,
              ...(range.end !== undefined && { end: range.end }),
            }
          : undefined;
        if (downloadOpts?.as === "stream") {
          return createStoredFile(
            {
              ...baseMeta,
              size: range ? rangedSize(stat.size, range) : stat.size,
            },
            {
              factory: () =>
                Readable.toWeb(
                  createReadStream(realBodyPath, streamRange)
                ) as unknown as ReadableStream<Uint8Array>,
              kind: "stream",
            }
          );
        }
        if (range) {
          // Read just the slice off disk rather than buffering the whole file
          // and trimming — the point of a range request is to touch less data.
          const bytes = await collectStream(
            Readable.toWeb(
              createReadStream(realBodyPath, streamRange)
            ) as unknown as ReadableStream<Uint8Array>
          );
          return createStoredFile(
            { ...baseMeta, size: bytes.byteLength },
            { data: bytes, kind: "buffer" }
          );
        }
        const buf = await fsp.readFile(realBodyPath);
        const bytes = new Uint8Array(
          buf.buffer,
          buf.byteOffset,
          buf.byteLength
        );
        return createStoredFile(
          { ...baseMeta, size: bytes.byteLength },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapFsError(error);
      }
    },
    exists(key) {
      // stat resolves for both files and directories, matching head()'s
      // permissive behavior. Tighten both together if file-only semantics
      // are ever needed.
      const bodyPath = resolveKeyPath(root, key);
      return existsByProbe(
        async () => fsp.stat(await realpathUnderRoot(root, bodyPath, key)),
        mapFsError
      );
    },
    async head(key) {
      const bodyPath = resolveKeyPath(root, key);
      try {
        const realBodyPath = await realpathUnderRoot(root, bodyPath, key);
        const stat = await fsp.stat(realBodyPath);
        const sidecar = await readSidecar(bodyPath);
        return storedFromSidecar(
          key,
          realBodyPath,
          sidecar,
          stat.size,
          stat.mtimeMs
        );
      } catch (error) {
        throw mapFsError(error);
      }
    },
    async list(options): Promise<ListResult> {
      const prefix = options?.prefix ?? "";
      const limit = options?.limit ?? 1000;
      const cursor = options?.cursor;
      const keys: string[] = [];
      try {
        for await (const key of walk(root)) {
          if (key.startsWith(prefix)) {
            keys.push(key);
          }
        }
      } catch (error) {
        throw mapFsError(error);
      }
      keys.sort(compareKeys);
      // Cursor is the last key returned in the previous page — start at
      // the first key strictly greater. Same scheme as the in-memory fake
      // adapter, so callers see consistent pagination semantics across
      // the fake (`test/fake-adapter.ts`) and fs adapters.
      const page = pageKeyList(keys, {
        ...(options?.delimiter && { delimiter: options.delimiter }),
        limit,
        ...(prefix && { prefix }),
        ...(cursor !== undefined && { cursor }),
      });
      const items: StoredFile[] = [];
      for (const key of page.keys) {
        const bodyPath = path.join(root, ...key.split("/"));
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential stat per page key; small bounded page, order preserved.
          const stat = await fsp.stat(bodyPath);
          // eslint-disable-next-line no-await-in-loop -- sidecar read follows this key's stat within the same page iteration.
          const sidecar = await readSidecar(bodyPath);
          items.push(
            storedFromSidecar(key, bodyPath, sidecar, stat.size, stat.mtimeMs)
          );
        } catch (error) {
          // A file that vanished between walk and stat — skip rather
          // than fail the whole list. Matches how cloud listings behave
          // when an object is deleted mid-page.
          if (errorCode(error) === "ENOENT") {
            continue;
          }
          throw mapFsError(error);
        }
      }
      return {
        items,
        ...(page.cursor !== undefined && { cursor: page.cursor }),
        ...(page.prefixes && { prefixes: page.prefixes }),
      };
    },
    async move(from, to) {
      const fromPath = resolveKeyPath(root, from);
      const toPath = resolveKeyPath(root, to);
      try {
        await ensureDirFor(toPath);
        // Atomic per-file rename — no byte round-trip, unlike copy()+delete().
        await fsp.rename(fromPath, toPath);
        // Move the sidecar alongside the body. If the source had none, mirror
        // that by clearing any stale destination sidecar from a prior upload
        // at the same key (same stance as copy()).
        try {
          await fsp.rename(sidecarPathOf(fromPath), sidecarPathOf(toPath));
        } catch (error) {
          if (errorCode(error) === "ENOENT") {
            await bestEffortRm(sidecarPathOf(toPath));
          } else {
            throw error;
          }
        }
      } catch (error) {
        throw mapFsError(error);
      }
    },
    name: "fs",
    raw: { root },
    resumableUpload(key, resumableOpts): OffsetResumableDriver {
      const bodyPath = resolveKeyPath(root, key);
      const tempPath = bodyPath + RESUMABLE_SUFFIX;
      let contentType = "application/octet-stream";
      return {
        adopt(session: ResumableUploadSession) {
          if (session.provider !== "fs") {
            throw new FilesError(
              "Provider",
              `Cannot resume a ${session.provider} session on an fs adapter.`
            );
          }
          if (session.key !== key) {
            throw new FilesError(
              "Provider",
              "Resume token does not match this upload's key."
            );
          }
          // The temp path is fully derived from the traversal-checked key, so
          // never adopt the token's copy — a persisted token is outside the
          // trust boundary, and a doctored `tempPath` would otherwise hand
          // `uploadAt`/`complete`/`discard` writes, renames, and deletes at an
          // arbitrary filesystem path. A mismatch also catches a token minted
          // against a different adapter root.
          if (session.tempPath !== tempPath) {
            throw new FilesError(
              "Provider",
              "Resume token's temp path does not match this adapter's root."
            );
          }
          ({ contentType } = session);
        },
        async begin(meta): Promise<ResumableUploadSession> {
          ({ contentType } = meta);
          try {
            await ensureDirFor(tempPath);
            // Start (or truncate) the partial file so positional writes have a
            // target. A leftover partial from a prior, abandoned attempt is
            // overwritten — `begin` always starts fresh.
            await fsp.writeFile(tempPath, "");
          } catch (error) {
            throw mapFsError(error);
          }
          return { contentType, key, provider: "fs", tempPath };
        },
        async complete(): Promise<UploadResult> {
          try {
            const buf = await fsp.readFile(tempPath);
            const bytes = new Uint8Array(
              buf.buffer,
              buf.byteOffset,
              buf.byteLength
            );
            const lastModified = Date.now();
            const sidecar: Sidecar = {
              contentType,
              etag: sha1Etag(bytes),
              lastModified,
              ...(resumableOpts.cacheControl && {
                cacheControl: resumableOpts.cacheControl,
              }),
              ...(resumableOpts.metadata && {
                metadata: resumableOpts.metadata,
              }),
            };
            await writeSidecar(bodyPath, sidecar);
            await fsp.rename(tempPath, bodyPath);
            return {
              contentType,
              etag: sidecar.etag,
              key,
              lastModified,
              size: bytes.byteLength,
            };
          } catch (error) {
            throw mapFsError(error);
          }
        },
        discard() {
          return bestEffortRm(tempPath);
        },
        mode: "offset",
        partSize:
          typeof resumableOpts.multipart === "object" &&
          resumableOpts.multipart.partSize
            ? resumableOpts.multipart.partSize
            : 8 * 1024 * 1024,
        async probe(): Promise<{ nextOffset: number }> {
          try {
            const stat = await fsp.stat(tempPath);
            return { nextOffset: stat.size };
          } catch (error) {
            if (errorCode(error) === "ENOENT") {
              return { nextOffset: 0 };
            }
            throw mapFsError(error);
          }
        },
        async uploadAt({ offset, data }): Promise<{ nextOffset: number }> {
          // O_RDWR | O_CREAT: positional write, creating the partial if it's
          // missing (e.g. resuming after it was cleaned up) without truncating
          // an existing one.
          const handle = await fsp.open(
            tempPath,
            // eslint-disable-next-line no-bitwise -- POSIX open flags are a bitmask
            fsConstants.O_RDWR | fsConstants.O_CREAT
          );
          try {
            await handle.write(data, 0, data.byteLength, offset);
          } finally {
            await handle.close();
          }
          return { nextOffset: offset + data.byteLength };
        },
      };
    },
    get root() {
      return root;
    },
    signedUploadUrl(key, _signOpts): Promise<SignedUpload> {
      // Validate the key path even though we don't write — surfaces
      // traversal attempts before reporting unsupported capability.
      resolveKeyPath(root, key);
      return Promise.reject(
        new FilesError(
          "Provider",
          "fs: signedUploadUrl() is not supported. The fs adapter has no built-in upload server, signer, or verifier, so it cannot bind expiresIn, contentType, maxSize, or minSize into an upload capability. Upload through files.upload() or through an application route that enforces those controls server-side."
        )
      );
    },
    // `url()` returns a `file://` or static-server URL — never a signed,
    // time-limited one (there's no signature to bind an expiry into).
    signedUrl: { supported: false },
    supportsCacheControl: true,
    supportsDelimiter: true,
    supportsMetadata: true,
    supportsRange: true,
    // `copy()` is a local `fs.copyFile` — no body round-trip.
    supportsServerSideCopy: true,
    async upload(key, body, options) {
      const bodyPath = resolveKeyPath(root, key);
      const contentType = defaultContentType(body, options?.contentType);
      try {
        await ensureDirFor(bodyPath);
        let bytes: Uint8Array;
        let size: number;
        if (body instanceof ReadableStream) {
          ({ bytes, size } = await writeStreamToTempThenRename(bodyPath, body));
        } else {
          bytes = await bodyToBytes(body);
          size = bytes.byteLength;
          // Write to a temp path then rename so a crash mid-write doesn't
          // leave a half-written body that subsequent reads would see.
          const tempPath = `${bodyPath}.${process.pid}.${Date.now()}.tmp`;
          try {
            await fsp.writeFile(tempPath, bytes);
            await fsp.rename(tempPath, bodyPath);
          } catch (error) {
            await bestEffortRm(tempPath);
            throw error;
          }
        }
        const lastModified = Date.now();
        const sidecar: Sidecar = {
          contentType,
          etag: sha1Etag(bytes),
          lastModified,
          ...(options?.cacheControl && { cacheControl: options.cacheControl }),
          ...(options?.metadata && { metadata: options.metadata }),
        };
        await writeSidecar(bodyPath, sidecar);
        return {
          contentType,
          etag: sidecar.etag,
          key,
          lastModified,
          size,
        } satisfies UploadResult;
      } catch (error) {
        throw mapFsError(error);
      }
    },
    url(key, urlOpts): Promise<string> {
      const bodyPath = resolveKeyPath(root, key);
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "fs: `responseContentDisposition` is not supported. fs URLs are either `file://` URLs or static-server URLs, with no signature in which to bind the override."
        );
      }
      if (urlBaseUrl) {
        return Promise.resolve(joinPublicUrl(urlBaseUrl, key));
      }
      // Note: this does not check whether the file exists. file:// URLs
      // are inert (the browser/OS resolves them at fetch time), so
      // returning one for a missing key is the same behavior cloud
      // adapters give for a deleted-but-still-cached key — the URL just
      // 404s when used. Skipping the stat keeps url() cheap.
      return Promise.resolve(pathToFileURL(bodyPath).href);
    },
  };
};
