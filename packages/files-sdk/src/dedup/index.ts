import type {
  FilesOperation,
  FilesPlugin,
  ListOptions,
  ListResult,
  PluginNext,
  StoredFile,
} from "../index.js";
import { collectStream, normalizeBody } from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface DedupOptions {
  /**
   * Where the content-addressed blobs live, as a key prefix. Defaults to
   * `".dedup"`. The bytes of `photos/a.jpg` are stored once at
   * `".dedup/<sha256>"`, and the logical key holds a small pointer to it.
   * Objects under this prefix are hidden from `list()` (unless you list within
   * it) and are never themselves de-duplicated. Don't store your own data here.
   */
  prefix?: string;
}

/** Prefix for every field this plugin stashes in a pointer's metadata. */
const META_PREFIX = "fsdedup_";
const META = {
  /** The content hash a pointer resolves to (also the "ours" marker). */
  ref: `${META_PREFIX}ref`,
  /** The logical (content) byte length, so `head`/`list` needn't fetch the blob. */
  size: `${META_PREFIX}size`,
} as const;

const RADIX = 10;
const HEX_WIDTH = 2;
/** A pointer carries no bytes of its own — the content lives in the blob. */
const EMPTY = new Uint8Array(0);

/**
 * Collapse leading/trailing slashes the way the SDK treats keys. The negative
 * lookbehind anchors the trailing run to its first slash so the match can't
 * backtrack across `"a////"` (the ReDoS shape a bare `\/+$` has).
 */
const normalizeDir = (prefix: string): string => {
  const normalized = prefix.replaceAll(/^\/+|(?<!\/)\/+$/gu, "");
  if (normalized.length === 0) {
    throw new FilesError(
      "Provider",
      "dedup: prefix must not be empty or all slashes"
    );
  }
  return normalized;
};

/** Lowercase-hex SHA-256 of `bytes` — the content address. */
const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // The digest input is a BufferSource that excludes SharedArrayBuffer-backed
  // views; our bodies never share, so assert the ArrayBuffer backing (as the
  // encryption plugin does).
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>
  );
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(HEX_WIDTH, "0");
  }
  return hex;
};

/** Drop this plugin's internal fields; return `undefined` when nothing remains. */
const stripInternalMeta = (
  metadata: Record<string, string>
): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith(META_PREFIX)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Re-report a pointer's logical (content) size and hide the internal metadata
 * fields, without fetching the blob. Used by `head` and `list`, which never
 * read the body. Objects this plugin didn't write (no marker) pass through.
 */
const correctMeta = (file: StoredFile): StoredFile => {
  const { metadata } = file;
  if (!metadata?.[META.ref]) {
    return file;
  }
  const size = Number.parseInt(metadata[META.size] ?? "", RADIX);
  return {
    ...file,
    metadata: stripInternalMeta(metadata),
    size: Number.isNaN(size) ? file.size : size,
  };
};

/**
 * Content-address object bodies so identical content is stored only once. On
 * `upload` the body is hashed (SHA-256); the bytes are written a single time to
 * a content-addressed blob under a store prefix (`.dedup/` by default), and the
 * logical key holds a tiny pointer (an empty object whose `metadata` records the
 * hash). Re-uploading content already in the store **skips the byte upload** and
 * just writes the pointer — and because the pointer is what `copy` / `move`
 * relocate, copying a de-duplicated file is near-free and shares the same blob.
 *
 * Reads are transparent: `download` follows the pointer to the blob (ranges
 * included — blobs are stored verbatim), and `head` / `list` report the logical
 * size with the internal fields stripped, all for `upload([...])` /
 * `download([...])` bulk calls too. Objects without this plugin's marker
 * (pre-existing or written elsewhere) pass straight through, so it's safe to
 * enable on a mixed bucket.
 *
 * Provider-agnostic: it uses only the Web Crypto API (no native deps) and the
 * `metadata` the SDK already round-trips, so it works on any adapter that
 * supports metadata. De-duplication is most effective on the **outside** of the
 * array, before any body-transforming plugin — encrypted bytes don't de-dup
 * (a random per-object key makes identical inputs encrypt differently), so place
 * it first: `plugins: [dedup(), compression(), encryption(key)]`.
 *
 * Trade-offs, by design:
 * - **Buffers the whole body** to hash it, so it's unsuitable for unknown-length
 *   streams and resumable uploads (the same gate `compression()` makes).
 * - **Reads cost a second fetch** — the pointer, then the blob (a ranged read
 *   does a `head` first). `head` / `list` add nothing; they read the pointer.
 * - **`url()` / `signedUploadUrl()` throw** — a presigned GET would hand out the
 *   empty pointer, and a presigned PUT would bypass content-addressing. Download
 *   through the instance instead.
 * - **Blobs aren't garbage-collected.** `delete` (and overwrite) drop the
 *   pointer but leave the content addressed, so it's reused if the content
 *   reappears; reclaim unreferenced blobs with a storage lifecycle rule or a
 *   periodic sweep.
 *
 * @param options optional `{ prefix }` — where blobs are stored.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { dedup } from "files-sdk/dedup";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [dedup()],
 * });
 *
 * await files.upload("a.png", bytes);
 * await files.upload("b.png", bytes); // same content — no second byte upload
 * await files.copy("a.png", "c.png"); // shares the one stored blob
 * ```
 */
export const dedup = (options: DedupOptions = {}): FilesPlugin => {
  const store = normalizeDir(options.prefix ?? ".dedup");
  const blobKeyOf = (hash: string): string => `${store}/${hash}`;
  /** Whether a key lives in the blob store — those bypass de-duplication. */
  const isStoreKey = (key: string): boolean =>
    key === store || key.startsWith(`${store}/`);

  /** Build the caller-facing {@link StoredFile} for a followed pointer. */
  const rewrap = (
    key: string,
    pointer: StoredFile,
    blob: StoredFile
  ): StoredFile =>
    createStoredFile(
      {
        etag: pointer.etag,
        key,
        lastModified: pointer.lastModified,
        metadata: stripInternalMeta(pointer.metadata ?? {}),
        // The blob's size is the content length (the range length for a ranged
        // read); the pointer's own size is always 0.
        size: blob.size,
        type: pointer.type,
      },
      { factory: () => blob.stream(), kind: "stream" }
    );

  /**
   * Hide blob objects from listings so the store doesn't pollute `list()` —
   * unless the caller is explicitly listing within it — and correct the logical
   * size of the pointers that remain. Keeps the page's `cursor` so pagination
   * still resumes; pages may just come back shorter.
   */
  const hideBlobs = (
    result: ListResult,
    listOptions: ListOptions | undefined
  ): ListResult => {
    const requested = listOptions?.prefix;
    if (
      requested !== undefined &&
      (requested === store || requested.startsWith(`${store}/`))
    ) {
      return result;
    }
    const marker = `${store}/`;
    const items = result.items.flatMap((file) =>
      file.key.startsWith(marker) ? [] : [correctMeta(file)]
    );
    const prefixes = result.prefixes?.filter(
      (entry) => !entry.startsWith(marker)
    );
    return {
      items,
      ...(result.cursor !== undefined && { cursor: result.cursor }),
      ...(prefixes && prefixes.length > 0 && { prefixes }),
    };
  };

  const upload = async (
    op: Extract<FilesOperation, { kind: "upload" }>,
    next: PluginNext
  ): Promise<unknown> => {
    const normalized = await normalizeBody(op.body, op.options?.contentType);
    const bytes =
      normalized.data instanceof Uint8Array
        ? normalized.data
        : await collectStream(normalized.data);
    const hash = await sha256Hex(bytes);
    const blobKey = blobKeyOf(hash);
    // Store the content once: skip the byte upload when this hash is already
    // stored (an `exists` probe — re-routed cross-kind, which works in single
    // and bulk calls alike). The metadata describing the logical object rides
    // on the pointer, not the blob, so the blob stays a pure function of its
    // content.
    if (!(await next({ key: blobKey, kind: "exists" }))) {
      await next({
        body: bytes,
        key: blobKey,
        kind: "upload",
        options: {
          ...op.options,
          contentType: normalized.contentType,
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = "no metadata on the blob write"; null would change the op shape.
          metadata: undefined,
        },
      });
    }
    // The logical key becomes a pointer: an empty object whose metadata carries
    // the hash and the content length. Progress reporting belongs to the blob
    // write above, so it's dropped here.
    const result = await next({
      ...op,
      body: EMPTY,
      options: {
        ...op.options,
        contentType: normalized.contentType,
        metadata: {
          ...op.options?.metadata,
          [META.ref]: hash,
          [META.size]: String(bytes.byteLength),
        },
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = "drop progress on the pointer write"; null would change the op shape.
        onProgress: undefined,
      },
    });
    return {
      ...result,
      contentType: normalized.contentType,
      size: bytes.byteLength,
    };
  };

  const download = async (
    op: Extract<FilesOperation, { kind: "download" }>,
    next: PluginNext
  ): Promise<StoredFile> => {
    if (op.options?.range) {
      // A range can't be applied to the empty pointer, so read its metadata
      // with a `head`, then apply the range to the verbatim blob.
      const pointer = await next({
        key: op.key,
        kind: "head",
        options: op.options,
      });
      const ref = pointer.metadata?.[META.ref];
      if (ref === undefined) {
        return next(op);
      }
      const blob = await next({
        key: blobKeyOf(ref),
        kind: "download",
        options: op.options,
      });
      return rewrap(op.key, pointer, blob);
    }
    const pointer = await next(op);
    const ref = pointer.metadata?.[META.ref];
    // No marker → an object we didn't write; hand it straight back.
    if (ref === undefined) {
      return pointer;
    }
    const blob = await next({
      key: blobKeyOf(ref),
      kind: "download",
      options: op.options,
    });
    return rewrap(op.key, pointer, blob);
  };

  const wrap = (async (
    op: FilesOperation,
    next: PluginNext
  ): Promise<unknown> => {
    // Direct traffic to the blob store bypasses the plugin: blobs are stored
    // and read verbatim, never treated as pointers or re-de-duplicated.
    if ("key" in op && isStoreKey(op.key)) {
      return next(op);
    }
    switch (op.kind) {
      case "upload": {
        return upload(op, next);
      }
      case "download": {
        return download(op, next);
      }
      case "head": {
        return correctMeta(await next(op));
      }
      case "list": {
        return hideBlobs(await next(op), op.options);
      }
      case "url": {
        throw new FilesError(
          "Provider",
          "dedup: url() would return a link to the pointer (an empty placeholder), not the content; download through the Files instance instead"
        );
      }
      case "signedUploadUrl": {
        throw new FilesError(
          "Provider",
          "dedup: signedUploadUrl() bypasses content-addressing (the client writes directly, never through the plugin); upload through the Files instance instead"
        );
      }
      // copy / move relocate the pointer (sharing the blob); delete drops it;
      // exists reports the pointer — all pass straight through.
      default: {
        return next(op);
      }
    }
  }) as NonNullable<FilesPlugin["wrap"]>;

  return {
    name: "dedup",
    wrap,
  };
};
