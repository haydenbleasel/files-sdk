import { handlers } from "../index.js";
import type {
  FileInfo,
  FilesOperation,
  FilesPlugin,
  StoredFile,
  UploadOptions,
} from "../index.js";
import { collectStream, normalizeBody } from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

/**
 * Compression algorithm for {@link compression}, matching the formats the
 * platform {@link CompressionStream} supports. `"gzip"` (the default) carries a
 * small header/footer and a checksum; `"deflate"` is zlib-wrapped raw deflate;
 * `"deflate-raw"` is the bare deflate stream with no framing. Brotli is
 * deliberately absent — it isn't part of the Compression Streams standard, so
 * supporting it would mean a native dependency and break isomorphism.
 */
export type CompressionFormat = "gzip" | "deflate" | "deflate-raw";

export interface CompressionOptions {
  /**
   * Which algorithm to compress new uploads with. Defaults to `"gzip"`. The
   * algorithm used for a given object is recorded in its metadata, so reads
   * always decompress with the right one — changing this option never breaks
   * objects written under the old format.
   */
  format?: CompressionFormat;
}

/** Prefix for every field this plugin stashes in object metadata. */
const META_PREFIX = "fscmp_";
const META = {
  /** The algorithm an object was stored with (also the "ours" marker). */
  alg: `${META_PREFIX}alg`,
  /** The original, uncompressed byte length. */
  size: `${META_PREFIX}size`,
} as const;

/**
 * Marker value for an object we touched but stored verbatim because compressing
 * it wouldn't have made it smaller (already-compressed inputs like JPEG/ZIP).
 * Borrowed from HTTP `Content-Encoding: identity`.
 */
const IDENTITY = "identity";
/** Real algorithms we can hand to {@link DecompressionStream} on read. */
const FORMATS = new Set(["deflate", "deflate-raw", "gzip"]);
const RADIX = 10;

type DownloadOp = Extract<FilesOperation, { kind: "download" }>;

/**
 * Run `data` through a {@link CompressionStream}/{@link DecompressionStream}.
 * We feed the writable and drain the readable concurrently: the transform
 * applies backpressure, so writing the whole buffer and only then reading could
 * deadlock on a large body.
 */
const through = async (
  data: Uint8Array,
  transform: CompressionStream | DecompressionStream
): Promise<Uint8Array> => {
  const collected = collectStream(transform.readable);
  const writer = transform.writable.getWriter();
  const pump = (async () => {
    // SAFETY: the writable's BufferSource excludes SharedArrayBuffer-backed
    // views; our bodies never share, so the ArrayBuffer backing holds (as in
    // the encryption plugin).
    await writer.write(data as Uint8Array<ArrayBuffer>);
    await writer.close();
  })();
  // Await both via Promise.all so a failure on either side (corrupt input
  // errors both the readable and the writable) is handled — never left to
  // surface later as an unhandled rejection.
  const [result] = await Promise.all([collected, pump]);
  return result;
};

const compress = (data: Uint8Array, format: CompressionFormat) =>
  through(data, new CompressionStream(format));

const decompress = (data: Uint8Array, format: CompressionFormat) =>
  through(data, new DecompressionStream(format));

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
 * Re-report an object's logical (uncompressed) size and hide the internal
 * metadata fields — what `head` / `list` return, and the bookkeeping fix for a
 * verbatim-stored (`identity`) download, whose stored bytes already are the
 * original. Objects this plugin didn't write — or a `list()` item with no
 * metadata at all, which S3 and the S3-compatibles return — pass through
 * untouched.
 */
const logical = (file: FileInfo): FileInfo => {
  const { metadata } = file;
  if (!metadata?.[META.alg]) {
    return file;
  }
  const size = Number.parseInt(metadata[META.size] ?? "", RADIX);
  return {
    contentType: file.contentType,
    etag: file.etag,
    key: file.key,
    lastModified: file.lastModified,
    metadata: stripInternalMeta(metadata),
    size: Number.isNaN(size) ? file.size : size,
  };
};

/**
 * Transparently compress object bodies at rest. On `upload` the body is
 * compressed (gzip by default) and the original byte length plus the algorithm
 * ride along in the object's `metadata`; on `download` it's decompressed back to
 * the original bytes — for `upload([...])` / `download([...])` bulk calls too.
 * If compressing wouldn't shrink an object (already-compressed data like
 * JPEG/ZIP/encrypted blobs), the original bytes are stored verbatim, so the
 * plugin never inflates your storage.
 *
 * Provider-agnostic: it uses only the platform {@link CompressionStream} (no
 * native deps) and the `metadata` the SDK already round-trips, so it works on
 * any adapter that supports metadata.
 *
 * Place it **before** `encryption()` in the plugin array — compression must see
 * plaintext, since encrypted bytes don't compress: `plugins: [compression(),
 * encryption(key)]`. Reads unwind the onion in reverse automatically (decrypt →
 * decompress).
 *
 * Trade-offs, by design:
 * - **Buffers the whole body** to compare compressed vs original size, so it's
 *   unsuitable for unknown-length streams.
 * - **Resumable uploads (`control`) throw** — compressed output isn't
 *   byte-for-byte stable across runtimes or versions (Node and Bun already
 *   differ), so a session resumed in another process could splice two
 *   different compressed streams into an object that can't be decompressed.
 *   `files.capabilities` reports `resumable` as `false` to match;
 *   `multipart: true` still splits a large body within one call.
 * - **Range downloads throw** — a byte range of the original maps to no fixed
 *   slice of the compressed bytes.
 * - **`url()` / `signedUploadUrl()` throw** — a presigned GET hands out
 *   compressed bytes with no `Content-Encoding`, which clients can't read, and a
 *   presigned PUT would silently bypass compression. `files.capabilities`
 *   reports `signedUrl.supported`, `signedUpload.supported`, and `rangeRead` as
 *   `false` to match, so the `files-sdk/api` gateway proxies uploads and
 *   downloads through the instance.
 * - **`head` / `list` never decompress** — they return metadata only,
 *   reporting the original size with the internal fields hidden; read the
 *   original bytes with `download()`. On adapters whose `list()` returns no
 *   metadata (S3 and the S3-compatibles), `list()` items report the stored
 *   (compressed) size.
 * - **`copy` / `move` just work** — the algorithm marker travels with the object.
 * - Objects without this plugin's marker (pre-existing or written elsewhere)
 *   **pass through** on read, so it's safe to enable on a mixed bucket.
 *
 * @param options optional `{ format }` — `"gzip"` (default), `"deflate"`, or
 *   `"deflate-raw"`.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { compression } from "files-sdk/compression";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [compression()],
 * });
 *
 * await files.upload("notes.txt", "a".repeat(10_000)); // stored gzipped
 * await (await files.download("notes.txt")).text(); // the original 10k string
 * ```
 */
export const compression = (options: CompressionOptions = {}): FilesPlugin => {
  const format = options.format ?? "gzip";

  const download = async (
    op: DownloadOp,
    next: (op: DownloadOp) => Promise<StoredFile>
  ): Promise<StoredFile> => {
    if (op.options?.range) {
      throw new FilesError(
        "Unsupported",
        `compression: range downloads are unsupported on compressed objects ("${op.key}")`
      );
    }
    const file = await next(op);
    const alg = file.metadata?.[META.alg];
    // No marker → an object we didn't write; pass it straight through.
    // Stored verbatim → only the bookkeeping needs fixing, not the bytes.
    if (!alg) {
      return file;
    }
    if (alg === IDENTITY) {
      const { metadata, size } = logical(file);
      return { ...file, metadata, size };
    }
    if (!FORMATS.has(alg)) {
      // A marker this version can't decode (a newer writer's algorithm, or a
      // hand-edited one) is a capability gap, not a provider failure: the
      // same read can only fail the same way, so it's never retried.
      throw new FilesError(
        "Unsupported",
        `compression: "${op.key}" was stored with an unknown algorithm "${alg}"`
      );
    }
    const compressed = new Uint8Array(await file.arrayBuffer());
    let original: Uint8Array;
    try {
      // SAFETY: `FORMATS` holds exactly the `CompressionFormat` names this
      // plugin writes, and the `has` check above rejected anything else.
      original = await decompress(compressed, alg as CompressionFormat);
    } catch (error) {
      throw new FilesError(
        "Provider",
        `compression: failed to decompress "${op.key}" (corrupted data)`,
        error,
        { permanent: true }
      );
    }
    return createStoredFile(
      {
        contentType: file.contentType,
        etag: file.etag,
        key: file.key,
        lastModified: file.lastModified,
        metadata: stripInternalMeta(file.metadata ?? {}),
        size: original.byteLength,
      },
      { data: original, kind: "buffer" }
    );
  };

  return {
    // Advertise what the plugin refuses, so `files.capabilities` (and the
    // `files-sdk/api` gateway, which picks redirect vs proxy from it) never
    // plans a presigned URL, a direct upload, a ranged read, or a resumable
    // upload that would throw.
    capabilities: (caps) => ({
      ...caps,
      publicUrl: false,
      rangeRead: false,
      resumable: false,
      signedUpload: { contentType: false, maxSize: false, supported: false },
      signedUrl: { disposition: false, expiry: "none", supported: false },
    }),
    // A provider event reports the stored object's size, not the caller's
    // (the transformed body); the stored ETag and type still describe it. The
    // event carries no object metadata, so an object this plugin didn't write
    // (a mixed bucket) can't be told apart: its size is cleared too.
    event: ({ size: _stored, ...event }) => event,
    name: "compression",
    wrap: handlers({
      download,
      head: async (op, next) => logical(await next(op)),
      list: async (op, next) => {
        const result = await next(op);
        return { ...result, items: result.items.map((file) => logical(file)) };
      },
      signedUploadUrl: () => {
        throw new FilesError(
          "Unsupported",
          "compression: signedUploadUrl() bypasses compression (the client would store uncompressed bytes); upload through the Files instance instead"
        );
      },
      upload: async (op, next) => {
        const uploadOptions: Omit<UploadOptions, "condition"> | undefined =
          op.options;
        if (uploadOptions?.control) {
          throw new FilesError(
            "Unsupported",
            `compression: resumable uploads (\`control\`) are unsupported ("${op.key}") — compressed output isn't byte-for-byte stable across runtimes or versions, so a session resumed in another process could splice two different compressed streams into an object that can't be decompressed; upload without \`control\``
          );
        }
        const normalized = await normalizeBody(
          op.body,
          op.options?.contentType
        );
        const original =
          normalized.data instanceof Uint8Array
            ? normalized.data
            : await collectStream(normalized.data);
        const compressed = await compress(original, format);
        // Storing whichever is smaller means we never grow an object on disk;
        // an incompressible body is kept verbatim and marked `identity`.
        const useCompressed = compressed.byteLength < original.byteLength;
        const result = await next({
          ...op,
          body: useCompressed ? compressed : original,
          options: {
            ...op.options,
            contentType: normalized.contentType,
            metadata: {
              ...op.options?.metadata,
              [META.alg]: useCompressed ? format : IDENTITY,
              [META.size]: String(original.byteLength),
            },
          },
        });
        return { ...result, size: original.byteLength };
      },
      url: () => {
        throw new FilesError(
          "Unsupported",
          "compression: url() returns a link to compressed bytes that clients receive as-is (no Content-Encoding) and cannot read; download through the Files instance instead"
        );
      },
    }),
  };
};
