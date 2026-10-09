import { isConditionalOperation, rejectConditional } from "../index.js";
import type {
  AdapterCapabilities,
  FileInfo,
  FilesOperation,
  FilesPlugin,
  ListOptions,
  ListResult,
  OperationResult,
  PluginNext,
  StoredFile,
  UploadOptions,
  UploadResult,
} from "../index.js";
import { collectStream, normalizeBody } from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { isNumber } from "../internal/is.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface DedupOptions {
  /**
   * Where the content-addressed blobs live, as a key prefix. Defaults to
   * `".dedup"`. The bytes of `photos/a.jpg` are stored once at
   * `".dedup/<sha256>"`, and the logical key holds a small pointer to it.
   * Objects under this prefix are hidden from `list()` (unless you list within
   * it) and are never themselves de-duplicated. Writes into it through the
   * instance (`upload`, `signedUploadUrl`, or a `copy` / `move` destination)
   * are rejected, so a caller can't overwrite the content every pointer
   * resolves to.
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
      "Invalid",
      "dedup: prefix must not be empty or all slashes"
    );
  }
  return normalized;
};

/** Lowercase-hex SHA-256 of `bytes` — the content address. */
const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // SAFETY: the digest input is a BufferSource that excludes
  // SharedArrayBuffer-backed views; our bodies never share, so the ArrayBuffer
  // backing holds (as in the encryption plugin).
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
 * Split a key into its path segments the way a filesystem would resolve it —
 * empty and `.` segments dropped, `..` popping its parent — lowercased, so a
 * spelling like `/.dedup//x`, `a/../.dedup/x`, or `.DEDUP/x` (the same file on
 * a case-insensitive filesystem) is still recognized as a store key.
 */
const resolvedSegments = (key: string): string[] => {
  const segments: string[] = [];
  for (const segment of key.toLowerCase().split("/")) {
    if (segment === "..") {
      segments.pop();
    } else if (segment !== "" && segment !== ".") {
      segments.push(segment);
    }
  }
  return segments;
};

/** Refuse a caller write that would land in the blob store. */
const rejectStoreWrite = (verb: string, key: string): never => {
  throw new FilesError(
    "Invalid",
    `dedup: ${verb} into the content store ("${key}") is refused — blobs are written only by the plugin, and overwriting one would change what every pointer to it returns`
  );
};

/**
 * Every conditional mode off: a pointer's native ETag never reflects its
 * content, so the plugin vetoes them all (see the `wrap` below).
 */
const NO_CONDITIONAL: AdapterCapabilities["conditional"] = {
  copy: {
    atomicSourceDestination: false,
    destinationCreate: false,
    destinationReplace: false,
    sourceEtag: false,
  },
  create: false,
  delete: false,
  exactRead: false,
  multipart: { create: false, replace: false },
  replace: false,
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
 * `download([...])` bulk calls too. `head` / `list` return metadata only,
 * read from the pointer without fetching the blob. The reported `etag` is the
 * content hash (the pointer's own ETag is the same for every key), so it
 * changes exactly when the content does — `sync()`'s default etag comparison
 * and `versioning()` ids stay correct. Objects without this plugin's marker
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
 * - **Buffers the whole body** to hash it, so it's unsuitable for very large or
 *   unknown-length streams. `multipart` / `control` apply to the blob write
 *   only (the pointer is always a single empty write); when the content is
 *   already stored, no bytes are sent and a `control` is left undriven.
 * - **Reads cost a second fetch** — the pointer, then the blob (a ranged read
 *   does a `head` first). `head` / `list` add nothing; they read the pointer.
 *   On adapters whose `list()` returns no metadata (S3 and the
 *   S3-compatibles), `list()` items can't be recognized as pointers, so they
 *   report the pointer's own size (`0`) and ETag; a `download()` still follows
 *   the pointer to the content.
 * - **`url()` / `signedUploadUrl()` throw** — a presigned GET would hand out the
 *   empty pointer, and a presigned PUT would bypass content-addressing. Download
 *   through the instance instead. `files.capabilities` reports
 *   `signedUrl.supported` and `signedUpload.supported` as `false` to match, so
 *   the `files-sdk/api` gateway proxies uploads and downloads through the
 *   instance.
 * - **Blobs aren't garbage-collected.** `delete` (and overwrite) drop the
 *   pointer but leave the content addressed, so it's reused if the content
 *   reappears; reclaim unreferenced blobs with a storage lifecycle rule or a
 *   periodic sweep. Deleting a blob that a pointer still references makes
 *   that pointer's reads fail with `NotFound`.
 * - **The store is write-protected through the instance.** `upload`,
 *   `signedUploadUrl`, and `copy` / `move` into the store prefix throw, so no
 *   caller can overwrite `.dedup/<sha256>` and change what every pointer to it
 *   returns. Blob reads don't re-verify the hash (that would buffer every
 *   download), so anyone with raw provider write access to the store can
 *   still substitute content — lock that down like the rest of the bucket.
 * - **Conditional operations throw** — a pointer's native ETag is identical
 *   for every key, so no provider compare-and-set can guard its content.
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
  const storeSegments = resolvedSegments(store);
  /**
   * Whether a write to `key` would land in the blob store, however it's
   * spelled — stricter than {@link isStoreKey}, since a false positive only
   * refuses an odd key while a miss would let a caller overwrite a blob.
   */
  const targetsStore = (key: string): boolean => {
    const segments = resolvedSegments(key);
    return storeSegments.every((segment, index) => segments[index] === segment);
  };

  /** Build the caller-facing {@link StoredFile} for a followed pointer. */
  const rewrap = (
    key: string,
    ref: string,
    pointer: FileInfo,
    blob: StoredFile
  ): StoredFile =>
    createStoredFile(
      {
        contentType: pointer.contentType,
        // The content hash, not the pointer's own (always-empty-body) ETag.
        etag: ref,
        key,
        lastModified: pointer.lastModified,
        metadata: stripInternalMeta(pointer.metadata ?? {}),
        // The blob's size is the content length (the range length for a ranged
        // read); the pointer's own size is always 0.
        size: blob.size,
      },
      { factory: () => blob.stream(), kind: "stream" }
    );

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
      return rewrap(op.key, ref, pointer, blob);
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
    return rewrap(op.key, ref, pointer, blob);
  };

  /**
   * Re-report a pointer's logical (content) size and content-hash `etag`, and
   * hide the internal metadata fields, without fetching the blob — what `head`
   * and `list` return. Objects this plugin didn't write (no marker) pass
   * through, as does a `list()` item with no metadata at all (S3 and the
   * S3-compatibles don't return it from a listing), which can't be told apart
   * from a plain object.
   */
  const logical = (file: FileInfo): FileInfo => {
    const ref = file.metadata?.[META.ref];
    if (ref === undefined) {
      return file;
    }
    const size = Number.parseInt(file.metadata?.[META.size] ?? "", RADIX);
    return {
      contentType: file.contentType,
      etag: ref,
      key: file.key,
      lastModified: file.lastModified,
      metadata: stripInternalMeta(file.metadata ?? {}),
      size: Number.isNaN(size) ? file.size : size,
    };
  };

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
      file.key.startsWith(marker) ? [] : [logical(file)]
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
  ): Promise<UploadResult> => {
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
    // the hash and the content length. Progress reporting, multipart, and a
    // resumable `control` all belong to the blob write above — an
    // `UploadControl` drives exactly one upload, so forwarding it here would
    // throw after the blob landed — so they're dropped from this one.
    const uploadOptions: Omit<UploadOptions, "condition"> = op.options ?? {};
    const {
      control: _control,
      multipart: _multipart,
      onProgress: _onProgress,
      ...pointerOptions
    } = uploadOptions;
    const result = await next({
      ...op,
      body: EMPTY,
      options: {
        ...pointerOptions,
        contentType: normalized.contentType,
        metadata: {
          ...op.options?.metadata,
          [META.ref]: hash,
          [META.size]: String(bytes.byteLength),
        },
      },
    });
    return {
      ...result,
      contentType: normalized.contentType,
      // The content hash, matching what `head` / `list` / `download` report.
      etag: hash,
      size: bytes.byteLength,
    };
  };

  // SAFETY: the engine folds `wrap` over the erased `FilesOperation` union and
  // re-narrows the result per call; every branch below resolves with the value
  // the matching verb's `next` produces (or a same-typed rewrite of it), so
  // the non-generic function satisfies the generic `wrap` at each verb.
  const wrap = (async (
    op: FilesOperation,
    next: PluginNext
  ): Promise<OperationResult<FilesOperation>> => {
    // Every conditional mode is vetoed, not just the ones that touch the
    // blob. A pointer's body is always empty, so its ETag is the same for
    // every key and never changes when the pointer is rewritten to a new
    // blob — a compare-and-set delete or copy against it would succeed even
    // though the key's content had moved on, which is worse than failing.
    if (isConditionalOperation(op)) {
      rejectConditional(
        op,
        "dedup",
        "a pointer's ETag never reflects its content, so no native compare-and-set can guard it"
      );
    }
    // Blobs are written only by the plugin itself (through `next`, which this
    // wrap never sees). A caller write into the store could replace the
    // content every pointer to that hash resolves to, so it's refused.
    if (
      (op.kind === "upload" || op.kind === "signedUploadUrl") &&
      targetsStore(op.key)
    ) {
      rejectStoreWrite(op.kind, op.key);
    }
    if ((op.kind === "copy" || op.kind === "move") && targetsStore(op.to)) {
      rejectStoreWrite(op.kind, op.to);
    }
    // Direct reads of the blob store bypass the plugin: blobs are read
    // verbatim, never treated as pointers. Deleting a blob is allowed (it's how
    // a sweep reclaims unreferenced content).
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
        return logical(await next(op));
      }
      case "list": {
        return hideBlobs(await next(op), op.options);
      }
      case "url": {
        throw new FilesError(
          "Unsupported",
          "dedup: url() would return a link to the pointer (an empty placeholder), not the content; download through the Files instance instead"
        );
      }
      case "signedUploadUrl": {
        throw new FilesError(
          "Unsupported",
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
    // Advertise what the plugin refuses, so `files.capabilities` (and the
    // `files-sdk/api` gateway, which picks redirect vs proxy from it) never
    // plans a presigned URL, a direct upload, or a compare-and-set that would
    // throw. Ranges stay as the adapter reports them: they're applied to the
    // verbatim blob.
    capabilities: (caps) => ({
      ...caps,
      conditional: NO_CONDITIONAL,
      publicUrl: false,
      signedUpload: { contentType: false, maxSize: false, supported: false },
      signedUrl: { disposition: false, expiry: "none", supported: false },
    }),
    // Provider events: the content-addressed blobs are internal, so drop them.
    // A logical key this plugin wrote holds an empty pointer, whose size and
    // ETag aren't the caller's content, so those are cleared. A pointer is
    // never non-empty, though: an event reporting a body is for an object
    // dedup didn't write (a mixed bucket), and keeps its own size and ETag.
    event: (event) => {
      if (isStoreKey(event.key)) {
        return null;
      }
      if (isNumber(event.size) && event.size > 0) {
        return event;
      }
      const { etag: _pointerEtag, size: _pointerSize, ...rest } = event;
      return rest;
    },
    name: "dedup",
    wrap,
  };
};
