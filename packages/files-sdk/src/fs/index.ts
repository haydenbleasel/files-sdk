import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import type {
  Adapter,
  Body,
  ListResult,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  DEFAULT_URL_EXPIRES_IN,
  existsByProbe,
  joinPublicUrl,
} from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import type { FilesErrorCode } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

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
   * Default expiry, in seconds, threaded into the `?expires=...` query
   * string of `signedUploadUrl()` for parity with the cloud adapters. A
   * dev upload-handler can validate it; the fs adapter itself does not
   * enforce expiry. Defaults to 3600 (1 hour). Per-call
   * `signedUploadUrl(key, { expiresIn })` overrides.
   *
   * `url()` ignores this — `file://` and static-server URLs don't expire.
   */
  defaultUrlExpiresIn?: number;
}

export type FsAdapter = Adapter<{ root: string }> & { readonly root: string };

const SIDECAR_SUFFIX = ".meta.json";
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

const classifyFsError = (code: string | undefined): FilesErrorCode => {
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

const DEFAULT_MESSAGES: Record<FilesErrorCode, string> = {
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
  return resolved;
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
      if (entry.name.endsWith(SIDECAR_SUFFIX)) {
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
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

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
        await ensureDirFor(toPath);
        await fsp.copyFile(fromPath, toPath);
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
        const stat = await fsp.stat(bodyPath);
        const sidecar = await readSidecar(bodyPath);
        const baseMeta = {
          ...(sidecar?.etag && { etag: sidecar.etag }),
          key,
          lastModified: sidecar?.lastModified ?? stat.mtimeMs,
          ...(sidecar?.metadata && { metadata: sidecar.metadata }),
          type: sidecar?.contentType ?? "application/octet-stream",
        };
        if (downloadOpts?.as === "stream") {
          return createStoredFile(
            { ...baseMeta, size: stat.size },
            {
              factory: () =>
                Readable.toWeb(
                  createReadStream(bodyPath)
                ) as unknown as ReadableStream<Uint8Array>,
              kind: "stream",
            }
          );
        }
        const buf = await fsp.readFile(bodyPath);
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
      const bodyPath = resolveKeyPath(root, key);
      return existsByProbe(() => fsp.stat(bodyPath), mapFsError);
    },
    async head(key) {
      const bodyPath = resolveKeyPath(root, key);
      try {
        const stat = await fsp.stat(bodyPath);
        const sidecar = await readSidecar(bodyPath);
        return storedFromSidecar(
          key,
          bodyPath,
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
      const startIdx = cursor ? keys.findIndex((k) => k > cursor) : 0;
      const start = startIdx === -1 ? keys.length : startIdx;
      const slice = keys.slice(start, start + limit);
      const items: StoredFile[] = [];
      for (const key of slice) {
        const bodyPath = path.join(root, ...key.split("/"));
        try {
          const stat = await fsp.stat(bodyPath);
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
      const lastKey = slice.at(-1);
      const more = start + slice.length < keys.length;
      return {
        items,
        ...(more && lastKey && { cursor: lastKey }),
      };
    },
    name: "fs",
    raw: { root },
    get root() {
      return root;
    },
    signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      // Validate the key path even though we don't write — surfaces
      // traversal attempts at sign time, not at the eventual PUT.
      resolveKeyPath(root, key);
      if (!urlBaseUrl) {
        throw new FilesError(
          "Provider",
          "fs: signedUploadUrl() requires `urlBaseUrl`. The fs adapter has no built-in upload server, so there's no endpoint to sign against. Stand up a dev handler (Next.js route, express + multer, etc.) that writes to the same `root`, then construct the adapter with `urlBaseUrl: 'http://localhost:3000/upload'` (or wherever your handler lives)."
        );
      }
      const expiresIn = signOpts.expiresIn ?? defaultUrlExpiresIn;
      const expiresAtMs = Date.now() + expiresIn * 1000;
      const params = new URLSearchParams({
        expires: String(Math.floor(expiresAtMs / 1000)),
      });
      if (signOpts.contentType) {
        params.set("content-type", signOpts.contentType);
      }
      if (signOpts.maxSize !== undefined) {
        params.set("max-size", String(signOpts.maxSize));
      }
      return Promise.resolve({
        headers: {
          ...(signOpts.contentType && { "Content-Type": signOpts.contentType }),
        },
        method: "PUT",
        url: `${joinPublicUrl(urlBaseUrl, key)}?${params.toString()}`,
      });
    },
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
      if (urlBaseUrl) {
        const base = joinPublicUrl(urlBaseUrl, key);
        if (urlOpts?.responseContentDisposition) {
          const sep = base.includes("?") ? "&" : "?";
          return Promise.resolve(
            `${base}${sep}response-content-disposition=${encodeURIComponent(urlOpts.responseContentDisposition)}`
          );
        }
        return Promise.resolve(base);
      }
      // Without a `urlBaseUrl`, the only thing we can return is a
      // `file://` URL. There's no signature mechanism on `file://`, so
      // `responseContentDisposition` cannot be enforced — throw rather
      // than silently drop the security override (same stance as
      // vercel-blob and supabase).
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "fs: `responseContentDisposition` requires `urlBaseUrl`. A `file://` URL has no signature in which to bind the override; configure `urlBaseUrl` so the dev server can apply Content-Disposition itself."
        );
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
