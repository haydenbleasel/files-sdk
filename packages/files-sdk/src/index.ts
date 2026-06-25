import {
  byteLengthOf,
  countingStream,
  deleteManyWithFallback,
  mapMany,
} from "./internal/core.js";
import { FilesError } from "./internal/errors.js";
import { globMatcher, globPrefix } from "./internal/glob.js";
import {
  buildReceipt,
  bufferedBodyBytes,
  receiptOpFor,
  resolveReceiptsConfig,
  sha256Hex,
} from "./internal/receipts.js";
import type { Receipt, ReceiptsConfig } from "./internal/receipts.js";
import { runResumableUpload } from "./internal/resumable.js";
import type {
  ResumableDriver,
  ResumableDriverOptions,
  UploadControl,
} from "./internal/resumable.js";
import {
  abortError,
  canRetry,
  maxRetries,
  mergeSignals,
  retryBackoff,
  runWithSignal,
  sleep,
} from "./internal/retry.js";
import { isSafeSearchRegex } from "./internal/search-regex.js";

export { FilesError, type FilesErrorCode } from "./internal/errors.js";
export { UploadControl } from "./internal/resumable.js";
export type {
  OffsetResumableDriver,
  PartMeta,
  PartsResumableDriver,
  ResumableDriver,
  ResumableDriverOptions,
  ResumableUploadSession,
  UploadControlStatus,
} from "./internal/resumable.js";
export type { Receipt, ReceiptOp } from "./internal/receipts.js";
export type { BodySource, StoredFileMeta } from "./internal/stored-file.js";
export { createStoredFile } from "./internal/stored-file.js";
export {
  sync,
  type SyncCompare,
  type SyncOptions,
  type SyncProgress,
  type SyncResult,
} from "./internal/sync.js";
export {
  transfer,
  type TransferOptions,
  type TransferProgress,
  type TransferResult,
} from "./internal/transfer.js";
// Provider catalog. The full data, per-provider env specs, and helpers live in
// the zero-dependency `files-sdk/providers` subpath; the name list and core
// types are surfaced here too so callers can discover providers without a
// second import.
export {
  type Provider,
  PROVIDER_NAMES,
  type ProviderSlug,
} from "./providers/index.js";

export type Body =
  | Blob
  | File
  | ReadableStream<Uint8Array>
  | ArrayBuffer
  | ArrayBufferView
  | Uint8Array
  | string;

export interface RetryBackoffContext {
  /**
   * Retry attempt number, starting at 1 for the first retry after the
   * initial failed call.
   */
  attempt: number;
  error: FilesError;
}

export type RetryOptions =
  | number
  | {
      max: number;
      backoff?: (ctx: RetryBackoffContext) => number;
    };

export interface OperationOptions {
  /**
   * Abort the operation when this signal is aborted. When both constructor
   * and per-call signals are provided, either one can abort the call.
   */
  signal?: AbortSignal;
  /**
   * Overall timeout in milliseconds, applied to each attempt. A timeout
   * aborts the operation and is not retried. `0` or a negative value
   * disables timeout handling.
   */
  timeout?: number;
  /**
   * Retry provider failures. A number is treated as `{ max: number }`.
   */
  retries?: RetryOptions;
}

/**
 * A single upload-progress report. Passed to {@link UploadOptions.onProgress}
 * (and {@link UploadManyOptions.onProgress}, which also carries the item `key`).
 */
export interface UploadProgress {
  /** Cumulative bytes sent so far. */
  loaded: number;
  /**
   * Total bytes to send, when known. Present for buffered bodies (`File`,
   * `Blob`, `ArrayBuffer`, `Uint8Array`, `string`); omitted for
   * `ReadableStream` bodies of unknown length, where only `loaded` can be
   * reported.
   */
  total?: number;
}

/**
 * Tuning for multipart uploads. Pass `multipart: true` for sensible defaults,
 * or an object to override them. See {@link UploadOptions.multipart}.
 */
export interface MultipartOptions {
  /**
   * Size of each uploaded part, in bytes. Defaults to 5 MiB
   * (`5 * 1024 * 1024`) — also the S3-enforced minimum for every part except
   * the last. Adapters that chunk natively round this to their own valid
   * granularity (OneDrive to a 320-KiB multiple, GCS/Firebase to 256 KiB).
   */
  partSize?: number;
  /**
   * How many parts upload in parallel. Defaults to `4`. Higher values trade
   * memory (up to `partSize * concurrency` buffered at once) for throughput.
   */
  concurrency?: number;
}

export interface UploadOptions extends OperationOptions {
  /**
   * MIME type stored alongside the object and returned to readers in the
   * `Content-Type` response header. Inferred from `File` / `Blob` `type`
   * when not set; falls back to `application/octet-stream`.
   */
  contentType?: string;
  /**
   * `Cache-Control` header stored on the object. Sent verbatim to the
   * provider; controls how downstream caches and browsers cache reads of
   * this key.
   *
   * **Throws** a {@link FilesError} on adapters with no cache-control field
   * (FTP, SFTP, Dropbox, Box, OneDrive, SharePoint, Cloudinary, Appwrite,
   * PocketBase, Bunny Storage, Convex, UploadThing, Bun's S3) rather than
   * silently dropping it — check {@link Adapter.supportsCacheControl} to branch
   * at runtime.
   */
  cacheControl?: string;
  /**
   * Arbitrary user metadata stored alongside the object. Returned by
   * `head()` and `list()` where the provider supports it.
   *
   * **Throws** a {@link FilesError} on adapters with no user-metadata primitive
   * (Vercel Blob, UploadThing, FTP, SFTP, Dropbox, Box, OneDrive, SharePoint,
   * Cloudinary, Appwrite, PocketBase, Bunny Storage, Convex, Bun's S3) rather
   * than silently dropping it, mirroring the {@link DownloadOptions.range} gate.
   * An empty object is treated as "no metadata" and never throws. Check
   * {@link Adapter.supportsMetadata} to branch at runtime.
   */
  metadata?: Record<string, string>;
  /**
   * Called as the upload makes progress, for driving a progress bar.
   *
   * Granularity depends on the body and the adapter:
   * - A `ReadableStream` body is reported byte-by-byte as the adapter
   *   consumes it (`total` is omitted unless the length is known).
   * - A buffered body (`File`, `Blob`, `ArrayBuffer`, `Uint8Array`, `string`)
   *   is handed to the provider whole, so it reports `{ loaded: 0, total }`
   *   then `{ loaded: total, total }` — unless the adapter reports true
   *   progress itself (see below).
   * - **S3 and the S3-compatible adapters** report true byte-level progress
   *   for every body type (including multipart for large files). This path
   *   uses `@aws-sdk/lib-storage`, an optional peer dependency that must be
   *   installed when `onProgress` is used with those adapters.
   *
   * Only fires while the upload is in flight and on success; a failed upload
   * does not emit a final event. On retry, progress restarts.
   */
  onProgress?: (progress: UploadProgress) => void;
  /**
   * Upload the body in parallel parts instead of a single request. Pass `true`
   * for sensible defaults (5 MiB parts, 4 in flight), or an object to tune
   * `partSize` / `concurrency`. Multipart is the robust path for large objects
   * and for `ReadableStream` bodies of unknown length: a single PUT must buffer
   * or know the length up front, while multipart streams part-by-part.
   *
   * On S3-family adapters this routes through `@aws-sdk/lib-storage` (an
   * optional peer dependency) and is **auto-engaged for unknown-length
   * streams** even when this flag is unset. OneDrive, GCS, Firebase, and Azure
   * map it to their native chunking; other adapters already stream or chunk
   * transparently and ignore it.
   */
  multipart?: boolean | MultipartOptions;
  /**
   * Drive the upload through a pause-able, resumable session. Construct an
   * {@link UploadControl}, pass it here, and call `pause()` / `resume()` /
   * `abort()` on it; persist `control.toJSON()` and rehydrate with
   * `UploadControl.from(token)` to resume in a later process.
   *
   * Requires a body with a known length (`File`, `Blob`, `ArrayBuffer`, a typed
   * array, or `string`) — a `ReadableStream` can't be re-read to resume.
   * Supported on S3 and the S3-compatible adapters, GCS, Firebase Storage,
   * Azure Blob, OneDrive, and Dropbox; other adapters throw. Not available in
   * the array (bulk) form of `upload`.
   */
  control?: UploadControl;
}

export interface UploadResult {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
  lastModified?: number;
}

export interface StoredFile {
  name: string;
  size: number;
  type: string;
  lastModified?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  stream(): ReadableStream<Uint8Array>;
  blob(): Promise<Blob>;
  key: string;
  etag?: string;
  metadata?: Record<string, string>;
}

/**
 * A contiguous byte range to download, mirroring the HTTP `Range` header
 * (`bytes=start-end`) the supporting adapters issue under the hood.
 *
 * Both bounds are **0-based**, and `end` is **inclusive** — `{ start: 0, end:
 * 99 }` is the first 100 bytes, matching the wire semantics of S3, GCS, Azure,
 * and `fetch`. This is deliberately *not* `slice()` semantics (where `end`
 * would be exclusive); the bytes returned line up with what a `Range` request
 * would yield.
 */
export interface ByteRange {
  /** First byte to return, 0-based and inclusive. Must be a non-negative integer. */
  start: number;
  /**
   * Last byte to return, 0-based and **inclusive**. Omit to read from `start`
   * to the end of the object (`bytes=start-`). When set, must be an integer
   * `>= start`.
   */
  end?: number;
}

export interface DownloadOptions extends OperationOptions {
  as?: "blob" | "stream";
  /**
   * Download only a contiguous slice of the object instead of the whole thing
   * — the building block for video seeking and resumable downloads. The
   * returned {@link StoredFile} carries just the requested bytes, and its
   * `size` reflects the range length (not the full object).
   *
   * **Supported** by the adapters with a native byte-range primitive: S3 and
   * the S3-compatible adapters (R2 over HTTP, MinIO, DigitalOcean Spaces,
   * Wasabi, Tigris, Backblaze B2, Storj, Hetzner, Akamai, and the rest of the
   * `s3()` family), Bun's S3, Google Cloud Storage, Firebase Storage, Azure
   * Blob, the local `fs` adapter, the in-memory adapter, and SFTP / FTP. SFTP
   * uses native read-stream offsets; FTP begins the transfer at the REST start
   * offset and trims a bounded `end` client-side (an open-ended range transfers
   * only what's needed).
   *
   * **Throws** a {@link FilesError} on adapters with no range primitive
   * (most SaaS/document providers) rather than silently downloading the whole
   * object and slicing it — so the bandwidth saving is never quietly lost.
   * Check {@link Adapter.supportsRange} to branch at runtime.
   */
  range?: ByteRange;
}

export interface ListOptions extends OperationOptions {
  /**
   * Filter results to keys that start with this string. Omit to list
   * everything in the bucket.
   */
  prefix?: string;
  /**
   * Continuation token from a prior result. Pass the `cursor` field of the
   * previous page back in to fetch the next page; omit on the first call.
   *
   * A cursor is only valid for the exact `prefix` **and** `delimiter` it was
   * produced with — hold both constant across a paginated sequence.
   */
  cursor?: string;
  /**
   * Maximum number of items to return per page. Capped per-provider (most
   * providers max around 1000). Defaults to 1000.
   */
  limit?: number;
  /**
   * Collapse keys at this boundary into "folders" (S3-style common prefixes),
   * the building block for a file-browser UI. With `delimiter: "/"` and
   * `prefix: "photos/"`, the page's `items` are only the direct files
   * (`photos/cover.jpg`) and {@link ListResult.prefixes} holds the subfolders
   * (`photos/2023/`, `photos/2024/`) — the keys nested deeper are folded into
   * those prefixes rather than listed.
   *
   * **Supported** by the object-store adapters with native common-prefix
   * listing (S3 and the whole `s3()` family, R2, Google Cloud Storage,
   * Firebase Storage, Azure Blob), the local `fs`, in-memory, FTP, SFTP,
   * Google Drive, and Cloudinary adapters (any delimiter string), plus the
   * folder-based providers (Vercel Blob, Netlify Blobs, Supabase, Dropbox,
   * Box, OneDrive, SharePoint) which only accept `"/"`.
   *
   * **Throws** a {@link FilesError} on adapters with no folder concept
   * (UploadThing, Appwrite, PocketBase, Convex, Bun's S3) rather than silently
   * returning a flat list. Check {@link Adapter.supportsDelimiter} to branch at
   * runtime. Must be a non-empty string.
   */
  delimiter?: string;
}

export interface ListResult {
  items: StoredFile[];
  /**
   * Common prefixes ("folders") when {@link ListOptions.delimiter} is set —
   * full keys including the trailing delimiter, e.g. `["photos/2023/",
   * "photos/2024/"]`. Omitted when no delimiter is set or none are found. When
   * the {@link Files} instance has a client `prefix`, these are scoped/stripped
   * identically to item keys.
   */
  prefixes?: string[];
  cursor?: string;
}

/**
 * How a string {@link SearchOptions.match | pattern} is interpreted by
 * {@link Files.search}. A `RegExp` pattern ignores this and always matches by
 * regex.
 *
 * - `"glob"` (default) — standard glob (via picomatch): `*` matches a run of
 *   characters within a path segment, `**` spans segments, `?` is a single
 *   non-`/` character, plus `[a-z]` classes, `{a,b}` braces, and a leading `!`
 *   to negate. Dotfiles are matched (keys are opaque, not hidden files). A glob
 *   with no wildcards (e.g. `"report.pdf"`) is an **exact** key match, not a
 *   substring match.
 * - `"regex"` — the string is compiled to a `RegExp` (with the `u` flag) and
 *   tested against the key.
 * - `"substring"` — matches keys that contain the pattern anywhere.
 * - `"exact"` — matches keys equal to the pattern.
 */
export type SearchMatch = "glob" | "regex" | "substring" | "exact";

export interface SearchOptions extends OperationOptions {
  /**
   * Restrict the underlying walk to keys starting with this prefix. For a glob
   * pattern a literal prefix is inferred automatically (`uploads/2024/*.pdf`
   * walks only the `uploads/2024` prefix); set this explicitly to bound a
   * `regex`, `substring`, or `caseInsensitive` search — which have no inferable
   * prefix — to part of a large bucket. Composes with the {@link Files}
   * instance `prefix` exactly like {@link ListOptions.prefix}.
   */
  prefix?: string;
  /**
   * Page size for each underlying `list()` call — the walk's batch size, not a
   * cap on results. See {@link ListOptions.limit}.
   */
  limit?: number;
  /**
   * Stop after yielding this many matches. Omit to yield every match (the walk
   * still pages lazily, so memory stays bounded).
   */
  maxResults?: number;
  /**
   * How to interpret a string `pattern`. Defaults to `"glob"`. Ignored when
   * `pattern` is a `RegExp`.
   */
  match?: SearchMatch;
  /**
   * Match case-insensitively. Adds the `i` flag for `glob` and `regex` and
   * lowercases both sides for `substring` and `exact`. A `RegExp` that already
   * sets its own `i` flag is honored regardless. When set, the automatic glob
   * prefix push-down is disabled (a provider prefix filter is case-sensitive),
   * so pass an explicit `prefix` to bound a case-insensitive search. Defaults
   * to `false`.
   */
  caseInsensitive?: boolean;
}

export interface DeleteManyOptions {
  /**
   * How many per-key deletes run in parallel when an adapter falls back to
   * repeated `delete()` calls. Defaults to `8`. Adapters with a native bulk
   * primitive (S3, Supabase, UploadThing) ignore this — they delete in one
   * request.
   */
  concurrency?: number;
  /**
   * When `true`, stop at the first failure and return immediately with the
   * keys deleted so far plus that error. When `false` (default), process
   * every key and collect per-key failures in `errors`.
   */
  stopOnError?: boolean;
}

export interface DeleteManyError {
  key: string;
  error: FilesError;
}

export interface DeleteManyResult {
  /** Keys that were deleted, in the order they were supplied. */
  deleted: string[];
  /** Per-key failures. Omitted entirely when every key succeeded. */
  errors?: DeleteManyError[];
}

/**
 * Shared controls for the array form of the bulk methods (`upload`,
 * `download`, `head`, `exists`). Unlike `delete`, none of these have a native
 * provider batch primitive, so the SDK always fans out to per-key calls.
 */
export interface BulkOptions {
  /**
   * How many per-key operations run in parallel. Defaults to `8`. Ignored
   * when `stopOnError` is set — that path runs sequentially.
   */
  concurrency?: number;
  /**
   * When `true`, stop at the first failure and return immediately with the
   * results gathered so far plus that error. When `false` (default), process
   * every item and collect per-key failures in `errors`.
   */
  stopOnError?: boolean;
}

/** A single per-key failure from the array form of a bulk method. */
export interface BulkError {
  key: string;
  error: FilesError;
}

/** One item in the array form of {@link Files.upload}. */
export interface UploadManyItem {
  key: string;
  body: Body;
  /** Per-item MIME type. See {@link UploadOptions.contentType}. */
  contentType?: string;
  /** Per-item `Cache-Control`. See {@link UploadOptions.cacheControl}. */
  cacheControl?: string;
  /** Per-item user metadata. See {@link UploadOptions.metadata}. */
  metadata?: Record<string, string>;
  /** Per-item multipart toggle/tuning. See {@link UploadOptions.multipart}. */
  multipart?: boolean | MultipartOptions;
}

export interface UploadManyResult {
  /** Successful uploads, in the order their items were supplied. */
  uploaded: UploadResult[];
  /** Per-item failures. Omitted entirely when every item succeeded. */
  errors?: BulkError[];
}

export interface UploadManyOptions extends BulkOptions {
  /**
   * Called as each item makes progress. Same semantics as
   * {@link UploadOptions.onProgress}, with the item's `key` added so callers
   * can attribute the report to a file when several upload concurrently.
   */
  onProgress?: (progress: UploadProgress & { key: string }) => void;
}

export interface DownloadManyOptions extends BulkOptions {
  /** Applied to every download. See {@link DownloadOptions.as}. */
  as?: "blob" | "stream";
}

export interface DownloadManyResult {
  /** Downloaded files, in the order their keys were supplied. */
  downloaded: StoredFile[];
  /** Per-key failures. Omitted entirely when every key succeeded. */
  errors?: BulkError[];
}

export interface HeadManyResult {
  /** Metadata results, in the order their keys were supplied. */
  files: StoredFile[];
  /** Per-key failures. Omitted entirely when every key succeeded. */
  errors?: BulkError[];
}

export interface ExistsManyResult {
  /** Keys that exist, in input order. */
  existing: string[];
  /** Keys the provider reports as missing, in input order. */
  missing: string[];
  /**
   * Keys whose existence couldn't be determined — a hard error (auth,
   * transport) rather than a clean present/absent answer. Omitted when none.
   */
  errors?: BulkError[];
}

export interface UrlOptions extends OperationOptions {
  /**
   * Override the adapter's default URL expiry, in seconds.
   *
   * **Honored** by adapters that sign (S3, Cloudflare R2 over HTTP, MinIO,
   * DigitalOcean Spaces, Storj, Hetzner, Akamai, Backblaze B2, Wasabi,
   * Tigris, and the R2 binding when HTTP credentials are also configured) — those
   * adapters return a presigned URL that expires after `expiresIn` seconds.
   *
   * **Ignored** by Vercel Blob (public): the underlying CDN URL has no
   * expiry, and the adapter returns it unchanged. If you need expiring
   * URLs there, you'll need a different provider — Vercel Blob has no
   * signing primitive.
   *
   * **N/A** for adapters where `url()` throws (Vercel Blob private; the
   * R2 binding without `publicBaseUrl` and without HTTP credentials).
   */
  expiresIn?: number;
  /**
   * Override the `Content-Disposition` header on the response.
   *
   * **Strongly recommended** for buckets that contain user-uploaded
   * content. Without this override, the browser uses the stored
   * Content-Type to decide whether to render or download, which means a
   * user-uploaded `.html` (or SVG with embedded scripts) will execute
   * inline at your bucket's origin — stored XSS in the trust context of
   * your domain. Pass `"attachment"` (or `'attachment; filename="..."'`)
   * to force a download.
   *
   * **Forces the signing path.** On signing adapters (S3, R2 HTTP, MinIO,
   * DigitalOcean Spaces, Storj, Hetzner, Akamai, Backblaze B2, Wasabi,
   * Tigris, R2 hybrid), passing this option always returns a
   * presigned URL —
   * even when `publicBaseUrl` is configured, because a permanent CDN URL
   * has no signature in which to bind the override. If `publicBaseUrl`
   * was the deliberate choice and you also need the security override,
   * the override wins (it's the safe default).
   *
   * **Throws** on Vercel Blob (no Content-Disposition primitive) and on
   * the R2 binding without HTTP credentials (can't sign). These cases
   * fail loudly rather than silently dropping the security ask.
   */
  responseContentDisposition?: string;
}

export interface SignUploadOptions extends OperationOptions {
  /**
   * How long the signed URL stays valid, in seconds. After it elapses, the
   * URL stops working and the client must request a new one.
   */
  expiresIn: number;
  /**
   * MIME type bound into the signature when the provider supports doing so.
   * Adapters that cannot enforce it at the signed URL layer throw rather
   * than returning an advisory header.
   */
  contentType?: string;
  /**
   * Maximum upload size in bytes, enforced server-side.
   *
   * **Strongly recommended when supported.** When omitted, the adapter falls
   * back to a presigned PUT URL with no server-side size limit — anyone with
   * the URL can upload an arbitrarily large file until `expiresIn` elapses.
   * When set, supporting adapters use a presigned POST form (S3/R2) that
   * enforces the size via a `content-length-range` policy. Adapters whose
   * direct-upload primitive cannot enforce this fail closed.
   */
  maxSize?: number;
  /**
   * Minimum upload size in bytes for the presigned POST policy. Defaults to
   * `1` — empty uploads are usually a sign of a broken client, and the most
   * common application assumption ("file present means real content") fails
   * silently when 0-byte objects can land. Pass `0` if you genuinely want to
   * allow empty uploads. Only used by adapters that can enforce `maxSize`;
   * adapters whose direct-upload primitive cannot enforce this fail closed.
   */
  minSize?: number;
}

export type SignedUpload =
  | {
      method: "PUT";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      method: "POST";
      url: string;
      fields: Record<string, string>;
    };

/** How an adapter's {@link Adapter.url} produces a download URL. */
export interface SignedUrlCapability {
  /**
   * `true` when `url()` mints a signed or tokenized download URL that grants
   * access without the caller's own credentials and is more than a permanent
   * public link (an S3 SigV4 URL, an Azure SAS, a GCS signed URL, a Box or
   * PocketBase access-token URL, …). Whether such a URL honors
   * {@link UrlOptions.expiresIn} exactly is a separate, per-provider detail —
   * some providers pin the lifetime server-side and ignore the request; see the
   * provider-gaps page. `false` when the adapter has no signing primitive: it
   * returns only a permanent public URL and ignores `expiresIn` (Vercel Blob,
   * Appwrite, Convex), or throws because it cannot mint a URL at all (the
   * filesystem, FTP/SFTP, OneDrive / Google Drive outside their public-link
   * mode). When `false`, prefer `download()`.
   */
  supported: boolean;
  /**
   * Hard upper bound on `expiresIn`, in seconds, when the provider enforces one
   * in code (e.g. Azure clamps user-delegation SAS to 7 days; Dropbox temporary
   * links are a fixed 4 hours). Omitted when there is no code-enforced cap —
   * note this is distinct from soft infra limits the SDK passes through without
   * checking (AWS SigV4's 604800-second ceiling is documented, not enforced
   * here; see the provider-gaps page).
   */
  maxExpiresIn?: number;
}

/**
 * A queryable snapshot of what the underlying adapter can do, exposed via
 * {@link Files.capabilities}. Lets callers, AI tool wrappers, and validators
 * branch on capability up front instead of relying on a throw at call time
 * (e.g. skip `range` planning when `rangeRead` is `false`, or fall back to
 * `download()` when `signedUrl.supported` is `false`).
 *
 * Every flag mirrors an operation the unified API actually exposes. The first
 * six are derived from the same per-adapter flags / optional methods the
 * {@link Files} wrapper already gates on, so they can never drift from the
 * runtime behavior. `serverSideCopy` and `signedUrl` are declared per-adapter
 * (no operation-level flag carries them) and default to the conservative value
 * when an adapter does not advertise them.
 */
export interface AdapterCapabilities {
  /** `download({ range })` returns only the requested bytes. From {@link Adapter.supportsRange}. */
  rangeRead: boolean;
  /** `upload({ onProgress })` reports byte-level progress natively. From {@link Adapter.reportsUploadProgress}. */
  uploadProgress: boolean;
  /** `list({ delimiter })` returns common prefixes. From {@link Adapter.supportsDelimiter}. */
  delimiter: boolean;
  /** `upload({ metadata })` persists arbitrary user metadata. From {@link Adapter.supportsMetadata}. */
  metadata: boolean;
  /** `upload({ cacheControl })` stores a Cache-Control header. From {@link Adapter.supportsCacheControl}. */
  cacheControl: boolean;
  /** `upload({ control })` resumable / multipart uploads. From {@link Adapter.resumableUpload}. */
  multipart: boolean;
  /** `copy()` runs server-side with no body re-transfer. From {@link Adapter.supportsServerSideCopy}. */
  serverSideCopy: boolean;
  /** How `url()` produces a download URL. From {@link Adapter.signedUrl}. */
  signedUrl: SignedUrlCapability;
}

export interface Adapter<Raw = unknown> {
  readonly name: string;
  readonly raw: Raw;
  /**
   * Set `true` when `upload` reports byte-level progress by calling
   * `opts.onProgress` itself (e.g. via a provider's native upload-progress
   * hook). The {@link Files} wrapper then defers progress entirely to the
   * adapter. When unset, the wrapper handles `onProgress` generically:
   * byte-level for `ReadableStream` bodies, start/finish for buffered ones.
   */
  readonly reportsUploadProgress?: boolean;
  /**
   * Set `true` when `download` honors {@link DownloadOptions.range} by issuing
   * a real byte-range request to the provider. The {@link Files} wrapper gates
   * on this: a `range` passed to an adapter without it throws before any
   * provider call, rather than silently downloading the whole object. Leave
   * unset for adapters whose provider has no range primitive.
   */
  readonly supportsRange?: boolean;
  /**
   * Set `true` when `list` honors {@link ListOptions.delimiter} by returning
   * S3-style common prefixes in {@link ListResult.prefixes}. The {@link Files}
   * wrapper gates on this: a `delimiter` passed to an adapter without it throws
   * before any provider call, rather than silently returning a flat list.
   * Leave unset for adapters whose provider has no folder/prefix concept.
   */
  readonly supportsDelimiter?: boolean;
  /**
   * Set `true` when `upload` persists {@link UploadOptions.metadata} (arbitrary
   * user metadata) on the stored object. The {@link Files} wrapper gates on
   * this exactly like {@link Adapter.supportsRange}: a non-empty `metadata`
   * passed to an adapter without it throws before any provider call, rather
   * than silently dropping it. Leave unset for adapters whose provider has no
   * arbitrary-metadata field.
   */
  readonly supportsMetadata?: boolean;
  /**
   * Set `true` when `upload` honors {@link UploadOptions.cacheControl} by
   * storing it on the object. The {@link Files} wrapper gates on this exactly
   * like {@link Adapter.supportsRange}: a `cacheControl` passed to an adapter
   * without it throws before any provider call, rather than silently dropping
   * it. Leave unset for adapters whose provider has no cache-control field.
   */
  readonly supportsCacheControl?: boolean;
  /**
   * Set `true` when `copy` runs server-side — a provider copy API call that
   * never re-transfers the body through this process (S3 `CopyObject`, Azure
   * `syncCopyFromURL`, a native filesystem rename, …). Leave unset for adapters
   * whose only copy path streams or buffers the bytes client-side
   * (download-then-reupload). Purely advisory — surfaced via
   * {@link Files.capabilities} as {@link AdapterCapabilities.serverSideCopy} so
   * callers can reason about the cost of a large `copy()`; it does not gate the
   * operation (every adapter's `copy` works regardless).
   */
  readonly supportsServerSideCopy?: boolean;
  /**
   * Describes how `url` produces a download URL, surfaced via
   * {@link Files.capabilities} as {@link AdapterCapabilities.signedUrl}. Leave
   * unset for adapters that cannot mint a usable URL — it defaults to
   * `{ supported: false }`, the conservative value, so a caller that doesn't
   * advertise still reads as "no signed URL" rather than a wrong `true`.
   * Advisory only; it does not gate `url()`.
   */
  readonly signedUrl?: SignedUrlCapability;
  upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult>;
  /**
   * Download an object's body and metadata. When {@link DownloadOptions.range}
   * is set, adapters that advertise {@link Adapter.supportsRange} must return
   * only the requested bytes, with `size` set to the range length.
   */
  download(key: string, opts?: DownloadOptions): Promise<StoredFile>;
  /**
   * Fetch metadata only — does not transfer the body.
   *
   * **Note:** the returned `StoredFile` still exposes `text()` /
   * `arrayBuffer()` / `blob()` / `stream()`, but those accessors lazily
   * issue a full GET on first use. If you only want metadata, don't call
   * the body accessors. They are not free.
   */
  head(key: string, opts?: OperationOptions): Promise<StoredFile>;
  /**
   * Check whether `key` exists without fetching its body.
   *
   * Returns `true` when the object exists, `false` when the provider reports
   * `NotFound`, and rethrows every other error (permissions, transport
   * failures, bad credentials, etc.).
   */
  exists(key: string, opts?: OperationOptions): Promise<boolean>;
  delete(key: string, opts?: OperationOptions): Promise<void>;
  /**
   * Delete many keys in one call. Optional: when an adapter omits it, the
   * SDK fans out to `delete()` with bounded concurrency. Adapters that
   * implement it should use a native bulk primitive where one exists.
   */
  deleteMany?(
    keys: string[],
    opts?: DeleteManyOptions
  ): Promise<DeleteManyResult>;
  copy(from: string, to: string, opts?: OperationOptions): Promise<void>;
  /**
   * Move (rename) `from` to `to`. Optional: when an adapter omits it, the SDK
   * falls back to `copy()` then `delete()`. Adapters should implement it when
   * the provider has a native rename that's atomic or avoids re-transferring
   * the body (the local filesystem, FTP, SFTP) — the copy+delete fallback on
   * those round-trips the bytes.
   */
  move?(from: string, to: string, opts?: OperationOptions): Promise<void>;
  list(opts?: ListOptions): Promise<ListResult>;
  /**
   * Return a URL the caller can use to fetch `key`.
   *
   * Adapters return the most direct URL they can produce:
   *
   * - **S3 / R2 (HTTP) / MinIO / DigitalOcean Spaces / Storj / Hetzner / Akamai / Backblaze B2 / Wasabi / Tigris** sign a `GetObject` request — the URL
   *   expires after `opts.expiresIn` seconds (or the adapter's default,
   *   typically 3600). If the adapter was constructed with
   *   `publicBaseUrl`, the URL is built against that origin instead and
   *   does not expire.
   * - **R2 (binding)** uses `publicBaseUrl` if configured, falls back to
   *   HTTP signing if HTTP credentials were also passed (hybrid mode),
   *   and otherwise throws.
   * - **Vercel Blob (public)** returns the permanent CDN URL.
   *   `expiresIn` is ignored.
   * - **Vercel Blob (private)** throws — there is no URL primitive for
   *   private blobs. Use `download()` instead.
   *
   * **Caller is responsible for URL-encoding.** Adapters do not escape
   * special characters in keys when building URLs against a
   * `publicBaseUrl` or Vercel Blob's fast path — the key is embedded
   * literally. If `key` is derived from untrusted input, callers should
   * validate or `encodeURIComponent`-style escape segments before
   * passing it in.
   */
  url(key: string, opts?: UrlOptions): Promise<string>;
  signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload>;
  /**
   * Build a {@link ResumableDriver} for a pause-able / resumable upload of
   * `key`. Optional: only adapters whose provider exposes a resumable or
   * multipart-with-listable-parts primitive implement it. When omitted, an
   * `upload()` call that passes {@link UploadOptions.control} throws an
   * unsupported-operation error before any provider call (mirroring the
   * {@link Adapter.supportsRange} gate). The returned driver is synchronous to
   * construct; it establishes the provider session lazily in `begin()`.
   */
  resumableUpload?(key: string, opts: ResumableDriverOptions): ResumableDriver;
}

/** The public {@link Files} method a hook event describes. */
export type FilesActionType =
  | "upload"
  | "download"
  | "head"
  | "exists"
  | "delete"
  | "copy"
  | "move"
  | "list"
  | "url"
  | "signedUploadUrl";

type WriteActionType = Extract<
  FilesActionType,
  "upload" | "delete" | "copy" | "move" | "signedUploadUrl"
>;

/**
 * Delivered to {@link FilesHooks.onAction} once when a public operation
 * settles — on success and on failure. The array form of an operation reports
 * the caller's `keys` and emits a single event carrying the aggregated
 * `result` (any per-item failures live in that result's `errors`); the single
 * form reports `key`, or `from` / `to` for `copy` and `move`. Keys are always
 * the ones the caller passed, never the internal prefixed path.
 */
export interface FilesActionEvent {
  type: FilesActionType;
  /** Caller-facing key, for single-key operations. */
  key?: string;
  /** Caller-facing keys, for the array form. */
  keys?: string[];
  /** `copy` source / destination, as passed by the caller. */
  from?: string;
  to?: string;
  status: "success" | "error";
  /** The resolved value, on success. */
  result?: unknown;
  /** The error, on failure — also delivered to {@link FilesHooks.onError}. */
  error?: FilesError;
  /** Wall-clock duration of the public call, in milliseconds. */
  durationMs: number;
  /**
   * A provenance {@link Receipt} for the call, present **only** when the
   * `receipts` option is on and `type` is a mutating verb (`upload`, `delete`,
   * `copy`, `move`) that **succeeded**. Absent on reads, on failures, on
   * `signedUploadUrl`, and on every instance with receipts off — so an existing
   * `onAction` consumer that never opted in sees the exact payload it always
   * has. See {@link FilesOptions.receipts}.
   */
  receipt?: Receipt;
}

/**
 * Delivered to {@link FilesHooks.onError} when a public call rejects, just
 * before the matching `onAction({ status: "error" })`. Partial failures
 * collected in a bulk result's `errors[]` are not rejections and do not fire
 * it.
 */
export interface FilesErrorEvent {
  type: FilesActionType;
  key?: string;
  keys?: string[];
  from?: string;
  to?: string;
  error: FilesError;
  durationMs: number;
}

/**
 * Delivered to {@link FilesHooks.onRetry} each time the SDK schedules a retry
 * for a single-operation call. Not fired on the first attempt, for
 * non-retryable errors, or for stream uploads (which never retry); bulk calls
 * do not retry, so they never fire it either.
 */
export interface FilesRetryEvent {
  type: FilesActionType;
  key?: string;
  from?: string;
  to?: string;
  /** The retry about to be scheduled — `1` is the first retry. */
  attempt: number;
  /** Total retries allowed for this call. */
  maxRetries: number;
  /** Milliseconds the SDK will wait before that attempt. */
  delayMs: number;
  /** The error that triggered the retry. */
  error: FilesError;
}

/**
 * Observability callbacks for a {@link Files} instance, passed as
 * `new Files({ hooks })`. Each mirrors the lightweight
 * {@link UploadOptions.onProgress} style — caller-facing payloads, no internal
 * adapter detail — and is fire-and-forget: the SDK calls it but does not await
 * it, and a hook that throws can never fail the operation it observes.
 */
export interface FilesHooks {
  onAction?: (event: FilesActionEvent) => void;
  onError?: (event: FilesErrorEvent) => void;
  onRetry?: (event: FilesRetryEvent) => void;
}

export interface FilesOptions<A extends Adapter> extends OperationOptions {
  adapter: A;
  prefix?: string;
  /**
   * When `true`, block every write surface on this instance (`upload`,
   * `delete`, `copy`, `move`, `signedUploadUrl`, and the write helpers on
   * `file(key)`) with `FilesError("ReadOnly", ...)`.
   */
  readonly?: boolean;
  /** Observability callbacks — see {@link FilesHooks}. */
  hooks?: FilesHooks;
  /**
   * Opt into provenance {@link Receipt}s for mutating calls (`upload`, `delete`,
   * `copy`, `move`). **Off by default** — when unset or `false`, the instance
   * behaves exactly as before: no receipt is built and nothing is hashed.
   *
   * - `true` — attach a {@link Receipt} (without `sha256`) to the success
   *   {@link FilesActionEvent} of each mutating call. Every field is derived
   *   from work the SDK already does, so this adds no per-call cost.
   * - `{ sha256: true }` — additionally fingerprint the upload body, taken
   *   **as passed to `upload()`** (before any plugin transform). This is the one
   *   field with a real per-call cost, so it stays off until asked for by name.
   *   The `sha256` is present only on an `upload` of a buffered body; a
   *   streaming upload (which the SDK never buffers) omits it. With a
   *   body-transforming plugin (`encryption`, `compression`) the stored bytes
   *   differ from this hash, but it matches what `download` returns.
   *
   * Receipts ride on the existing {@link FilesHooks.onAction} event as an
   * additive `receipt` field, so reading them is `new Files({ receipts: true,
   * hooks: { onAction: (e) => e.receipt && record(e.receipt) } })` — no new
   * operation, callback, or return-shape change.
   */
  receipts?: boolean | { sha256?: boolean };
  /**
   * Ordered list of {@link FilesPlugin}s wrapping this instance. `plugins[0]`
   * is the outermost layer of the onion. For plugins that add methods via
   * `extend`, use {@link createFiles} so the new surface shows up on the type.
   */
  plugins?: readonly FilesPlugin[];
}

export interface FileHandle {
  readonly key: string;
  upload(body: Body, opts?: UploadOptions): Promise<UploadResult>;
  download(opts?: DownloadOptions): Promise<StoredFile>;
  head(opts?: OperationOptions): Promise<StoredFile>;
  exists(opts?: OperationOptions): Promise<boolean>;
  delete(opts?: OperationOptions): Promise<void>;
  url(opts?: UrlOptions): Promise<string>;
  signedUploadUrl(opts: SignUploadOptions): Promise<SignedUpload>;
  copyTo(destinationKey: string, opts?: OperationOptions): Promise<void>;
  copyFrom(sourceKey: string, opts?: OperationOptions): Promise<void>;
  /** Move this key to `destinationKey`. See {@link Files.move}. */
  moveTo(destinationKey: string, opts?: OperationOptions): Promise<void>;
  /** Move `sourceKey` onto this key. See {@link Files.move}. */
  moveFrom(sourceKey: string, opts?: OperationOptions): Promise<void>;
}

/**
 * A single in-flight operation handed to a {@link FilesPlugin}. One variant per
 * public verb (mirroring {@link FilesActionType}), carrying the caller-facing,
 * **un-prefixed** inputs — a plugin never sees the internal prefixed path, the
 * same rule {@link FilesHooks} follow.
 *
 * The array form of `upload` / `download` / `head` / `exists` / `delete` fans
 * out to one op per item, each marked `bulk: true`, so a plugin can tell a
 * single call from one element of a batch. `copy`, `move`, `list`, `url`, and
 * `signedUploadUrl` have no array form and are always single.
 */
export type FilesOperation =
  | {
      kind: "upload";
      key: string;
      body: Body;
      options?: UploadOptions;
      bulk?: true;
    }
  | { kind: "download"; key: string; options?: DownloadOptions; bulk?: true }
  | { kind: "head"; key: string; options?: OperationOptions; bulk?: true }
  | { kind: "exists"; key: string; options?: OperationOptions; bulk?: true }
  | { kind: "delete"; key: string; options?: OperationOptions; bulk?: true }
  | { kind: "copy"; from: string; to: string; options?: OperationOptions }
  | { kind: "move"; from: string; to: string; options?: OperationOptions }
  | { kind: "list"; options?: ListOptions }
  | { kind: "url"; key: string; options?: UrlOptions }
  | { kind: "signedUploadUrl"; key: string; options?: SignUploadOptions };

/**
 * The value a given {@link FilesOperation} resolves to — the result map that
 * keeps a plugin's `wrap` / `next` fully typed per verb. Mirrors the return
 * type of the matching {@link Files} method; `delete` / `copy` / `move` resolve
 * to no value (`undefined`).
 */
export type OperationResult<O extends FilesOperation> = O extends {
  kind: "upload";
}
  ? UploadResult
  : O extends { kind: "download" | "head" }
    ? StoredFile
    : O extends { kind: "exists" }
      ? boolean
      : O extends { kind: "list" }
        ? ListResult
        : O extends { kind: "url" }
          ? string
          : O extends { kind: "signedUploadUrl" }
            ? SignedUpload
            : undefined;

/**
 * Continue inward through the plugin onion. Call it from a `wrap` to run the
 * next plugin (and ultimately the real operation), optionally passing a
 * transformed op. For a single operation `next` is retry-wrapped, so calling it
 * more than once re-enters the retry loop.
 */
export type PluginNext = <O extends FilesOperation>(
  op: O
) => Promise<OperationResult<O>>;

/**
 * An opt-in extension to a {@link Files} instance, passed as
 * `new Files({ plugins: [...] })`. Plugins compose as an **ordered onion** —
 * `plugins[0]` is outermost — and offer two independent capabilities:
 *
 * - `wrap` intercepts every operation: transform the op, veto it by throwing,
 *   or observe it. This is the interceptable superset of {@link FilesHooks},
 *   which can only observe. Reach for {@link handlers} to author a per-verb
 *   `wrap` with auto-passthrough instead of a raw one.
 * - `extend` contributes new namespaced surface (e.g. `files.usage()`). It runs
 *   once at construction against the fully-wrapped instance, so an extension
 *   method that calls back into `files.upload(...)` also goes through the onion.
 *   Use {@link createFiles} to surface the added methods on the static type.
 *
 * Plugins run **inside** the `onAction` / `onError` hooks but **outside** retry
 * and prefixing: a `wrap` runs once on caller-facing keys, and retries resend
 * whatever body it produced.
 */
export interface FilesPlugin<
  Ext extends Record<string, unknown> = Record<never, never>,
> {
  /** Identifies the plugin in collision errors and diagnostics. */
  readonly name: string;
  /** Tier A/B: wrap any operation. Call `next` to continue inward. */
  wrap?: <O extends FilesOperation>(
    op: O,
    next: PluginNext
  ) => Promise<OperationResult<O>>;
  /** Tier C: contribute namespaced surface. The only part that changes the type. */
  extend?: (files: Files) => Ext;
}

/**
 * A per-verb handler map for {@link handlers}: list only the operations you
 * care about, each typed to its own op and `next`. Verbs you omit pass straight
 * through untouched.
 */
export type PluginHandlers = {
  [K in FilesOperation["kind"]]?: (
    op: Extract<FilesOperation, { kind: K }>,
    next: (
      op: Extract<FilesOperation, { kind: K }>
    ) => Promise<OperationResult<Extract<FilesOperation, { kind: K }>>>
  ) => Promise<OperationResult<Extract<FilesOperation, { kind: K }>>>;
};

// Internal, non-generic working types for folding the onion. The public
// `wrap` / `PluginNext` are generic for authoring ergonomics, but a generic
// function can't be stored in an array or folded without per-call type
// parameters, so we erase to these inside the engine and cast at the boundary.
type InternalNext = (op: FilesOperation) => Promise<unknown>;
type InternalWrap = (
  op: FilesOperation,
  next: InternalNext
) => Promise<unknown>;

/** Distribute a union into the intersection of its members. */
type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

/**
 * The combined surface every plugin's `extend` contributes, as one
 * intersection — what {@link createFiles} grafts onto the {@link Files} type.
 */
export type ExtensionsOf<P extends readonly FilesPlugin[]> =
  UnionToIntersection<
    {
      [K in keyof P]: NonNullable<P[K]["extend"]> extends (
        files: Files
      ) => infer E
        ? E
        : unknown;
    }[number]
  >;

// Catch the obviously-broken cases at the SDK boundary so callers get a
// useful error from us instead of an opaque provider 400. We deliberately
// don't try to be exhaustive (length, allowed characters, leading slashes)
// — those rules differ across S3/R2/Vercel and we'd rather surface real
// provider errors than enforce the strictest superset.
const assertValidKey = (key: string, label = "key"): void => {
  if (typeof key !== "string" || key.length === 0) {
    throw new FilesError("Provider", `${label} must be a non-empty string`);
  }
  if (key.includes("\0")) {
    throw new FilesError("Provider", `${label} must not contain null bytes`);
  }
};

// Compile a search pattern into a key predicate once, up front, so the per-key
// cost during the walk is a single test/compare and an invalid regex throws
// before any provider call.
const buildSearchMatcher = (
  pattern: string | RegExp,
  match: SearchMatch,
  caseInsensitive: boolean
): ((key: string) => boolean) => {
  if (
    typeof pattern === "string" &&
    (match === "substring" || match === "exact")
  ) {
    const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
    const contains = match === "substring";
    return (key) => {
      const hay = caseInsensitive ? key.toLowerCase() : key;
      return contains ? hay.includes(needle) : hay === needle;
    };
  }
  if (typeof pattern === "string" && match === "glob") {
    return globMatcher(pattern, caseInsensitive);
  }
  // A RegExp instance, or a string compiled as a regex.
  let regexp: RegExp;
  if (pattern instanceof RegExp) {
    regexp = new RegExp(
      pattern.source,
      caseInsensitive && !pattern.flags.includes("i")
        ? `${pattern.flags}i`
        : pattern.flags
    );
  } else {
    try {
      regexp = new RegExp(pattern, caseInsensitive ? "iu" : "u");
    } catch (error) {
      throw new FilesError(
        "Provider",
        `search pattern is not a valid regular expression: ${pattern}`,
        error
      );
    }
  }
  if (!isSafeSearchRegex(regexp)) {
    throw new FilesError("Provider", "search pattern is too complex");
  }
  return (key) => {
    regexp.lastIndex = 0;
    return regexp.test(key);
  };
};

const assertNoRelativeSegments = (key: string, label = "key"): void => {
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new FilesError(
      "Provider",
      `${label} must not contain . or .. path segments`
    );
  }
};

// Normalize the prefix the same way the rest of the SDK treats keys: no
// leading slash (S3/R2 store `/users/x` under a literal empty-named folder,
// which is never what callers want), and no trailing slash so we control the
// single separator when joining. `"/users/"`, `"users/"`, and `"users"` all
// collapse to `"users"`.
const normalizePrefix = (prefix: string | undefined): string => {
  if (prefix === undefined) {
    return "";
  }
  if (typeof prefix !== "string") {
    throw new FilesError("Provider", "prefix must be a string");
  }
  // The `(?<!\/)` before the trailing-slash run anchors each match to the
  // first slash of the run, so the engine can't re-attempt at every slash —
  // that backtracking is what makes a bare `\/+$` polynomial (ReDoS) on input
  // like `"users////…"`.
  const normalized = prefix.replaceAll(/^\/+|(?<!\/)\/+$/gu, "");
  assertValidKey(normalized, "prefix");
  assertNoRelativeSegments(normalized, "prefix");
  return normalized;
};

/**
 * The caller-facing identity of an operation, shared by the action wrapper
 * (for `onAction` / `onError`) and {@link Files.#run} (for `onRetry`). Holds
 * only what the hook payloads expose — public keys, never internal paths.
 */
interface ActionContext {
  type: FilesActionType;
  key?: string;
  keys?: string[];
  from?: string;
  to?: string;
}

/**
 * Invoke a hook without letting it affect the operation it observes: a thrown
 * error is swallowed, and the return value is ignored — hooks are
 * fire-and-forget, like {@link UploadOptions.onProgress}.
 */
const emitHook = <E>(
  hook: ((event: E) => void) | undefined,
  event: E
): void => {
  if (!hook) {
    return;
  }
  try {
    hook(event);
  } catch {
    // Observability must not break the operation.
  }
};

export class Files<A extends Adapter = Adapter> {
  readonly #adapter: A;
  readonly #defaults: OperationOptions;
  readonly #hooks: FilesHooks | undefined;
  readonly #isReadOnly: boolean;
  readonly #prefix: string;
  /** The normalized `receipts` option — see {@link FilesOptions.receipts}. */
  readonly #receipts: ReceiptsConfig;
  /** The `receipts` option as supplied, carried verbatim into {@link Files.readonly}. */
  readonly #receiptsOption: FilesOptions<A>["receipts"];
  /** The plugin list as supplied, carried verbatim into {@link Files.readonly}. */
  readonly #plugins: readonly FilesPlugin[] | undefined;
  /**
   * The `wrap` functions of {@link Files.#plugins}, in order, type-erased for
   * folding. Empty when no plugin wraps — the hot path {@link Files.#dispatch}
   * short-circuits on its length so a plugin-free instance is byte-identical.
   */
  readonly #wraps: InternalWrap[];

  constructor(opts: FilesOptions<A>) {
    const {
      adapter,
      hooks,
      prefix,
      readonly: readOnly,
      plugins,
      receipts,
      ...defaults
    } = opts;
    this.#adapter = adapter;
    this.#hooks = hooks;
    this.#isReadOnly = readOnly === true;
    this.#prefix = normalizePrefix(prefix);
    this.#receiptsOption = receipts;
    this.#receipts = resolveReceiptsConfig(receipts);
    this.#defaults = defaults;
    this.#plugins = plugins;
    // A generic `wrap` can't be folded without per-call type parameters, so
    // erase to the internal signature here; the typed boundary is restored in
    // `#dispatch`. The double cast is required — `unknown`'s return type isn't
    // assignable to the generic `OperationResult<O>` the contravariant `next`
    // demands. Plugin authors never see this; their `(op, next)` stays typed.
    this.#wraps = (plugins ?? []).flatMap((plugin) =>
      plugin.wrap ? [plugin.wrap as unknown as InternalWrap] : []
    );
    // `extend` runs against the fully-wrapped instance (fields + `#wraps` are
    // already set), so an extension method that calls back into `this.upload()`
    // goes through the onion too.
    if (plugins) {
      this.#applyExtensions(plugins);
    }
  }

  /**
   * Graft each plugin's `extend` surface onto this instance, failing closed on
   * any collision. A new own property would shadow a real method (`#private`
   * fields are unreachable by `Object.assign`, so methods are the only hazard),
   * so we throw at construction rather than let a plugin silently break
   * `upload` / `download` / etc. — or make the instance thenable via a `then`
   * key, which would corrupt `await files`.
   */
  #applyExtensions(plugins: readonly FilesPlugin[]): void {
    const contributed = new Set<string>();
    for (const plugin of plugins) {
      if (!plugin.extend) {
        continue;
      }
      const surface = plugin.extend(this as Files);
      for (const key of Object.keys(surface)) {
        // A new own property would shadow a real method or getter (every one
        // lives on the prototype, including inherited `Object` members), and a
        // `then` key would make the instance thenable and corrupt `await files`.
        if (key === "then" || key in Files.prototype) {
          throw new FilesError(
            "Provider",
            `plugin "${plugin.name}": extension "${key}" collides with an existing Files member`
          );
        }
        if (contributed.has(key)) {
          throw new FilesError(
            "Provider",
            `plugin "${plugin.name}": extension "${key}" collides with another plugin's extension`
          );
        }
        contributed.add(key);
      }
      Object.assign(this, surface);
    }
  }

  /**
   * Run `op` through the plugin onion, then `base` (the real operation).
   * `plugins[0]` is outermost. Short-circuits straight to `base` when nothing
   * wraps, so the no-plugin path costs nothing. Lives **inside** the
   * `#action` / `#writeAction` hooks but **outside** `#run` retry and `#path`
   * prefixing — plugins see caller-facing keys and run once per logical op.
   */
  #dispatch<O extends FilesOperation>(
    op: O,
    base: InternalNext
  ): Promise<OperationResult<O>> {
    if (this.#wraps.length === 0) {
      return base(op) as Promise<OperationResult<O>>;
    }
    // Fold from the innermost wrap outward so `plugins[0]` ends up outermost.
    let chain: InternalNext = base;
    for (const wrap of this.#wraps.toReversed()) {
      const next = chain;
      chain = (nextOp) => wrap(nextOp, next);
    }
    return chain(op) as Promise<OperationResult<O>>;
  }

  /**
   * The real operation behind a single {@link FilesOperation} — the innermost
   * layer of the onion, and the one place every single-key verb does its
   * `#path` prefixing, capability gating, `#run` retry, and result
   * prefix-stripping. Centralizing it (rather than passing each method's
   * closure) lets a raw `wrap` re-route by calling `next` with a different
   * `kind`. The array forms keep their own per-item closure for the item's own
   * verb (retry-free, no per-item hooks) but fall back here for any verb a
   * plugin re-routes to, so a cross-kind sub-op behaves the same inside a bulk
   * call as in a single one.
   */
  #perform(op: FilesOperation): Promise<unknown> {
    switch (op.kind) {
      case "upload": {
        return this.#runUpload(op.key, op.body, op.options, {
          key: op.key,
          type: "upload",
        });
      }
      case "download": {
        const ctx: ActionContext = { key: op.key, type: "download" };
        const path = this.#path(op.key);
        if (op.options?.range) {
          this.#assertRangeSupported(op.options.range);
        }
        return this.#run(
          op.options,
          async (attemptOpts) =>
            this.#storedFile(await this.#adapter.download(path, attemptOpts)),
          true,
          ctx
        );
      }
      case "head": {
        const ctx: ActionContext = { key: op.key, type: "head" };
        const path = this.#path(op.key);
        return this.#run(
          op.options,
          async (attemptOpts) =>
            this.#storedFile(await this.#adapter.head(path, attemptOpts)),
          true,
          ctx
        );
      }
      case "exists": {
        const ctx: ActionContext = { key: op.key, type: "exists" };
        const path = this.#path(op.key);
        return this.#run(
          op.options,
          (attemptOpts) => this.#adapter.exists(path, attemptOpts),
          true,
          ctx
        );
      }
      case "delete": {
        const ctx: ActionContext = { key: op.key, type: "delete" };
        const path = this.#path(op.key);
        return this.#run(
          op.options,
          (attemptOpts) => this.#adapter.delete(path, attemptOpts),
          true,
          ctx
        );
      }
      case "copy": {
        const ctx: ActionContext = { from: op.from, to: op.to, type: "copy" };
        const fromPath = this.#path(op.from, "copy source");
        const toPath = this.#path(op.to, "copy destination");
        return this.#run(
          op.options,
          (attemptOpts) => this.#adapter.copy(fromPath, toPath, attemptOpts),
          true,
          ctx
        );
      }
      case "move": {
        const ctx: ActionContext = { from: op.from, to: op.to, type: "move" };
        const fromPath = this.#path(op.from, "move source");
        const toPath = this.#path(op.to, "move destination");
        return this.#run(
          op.options,
          (attemptOpts) => this.#move(fromPath, toPath, attemptOpts),
          true,
          ctx
        );
      }
      case "list": {
        return this.#performList(op.options);
      }
      case "url": {
        const ctx: ActionContext = { key: op.key, type: "url" };
        const path = this.#path(op.key);
        return this.#run(
          op.options,
          (attemptOpts) => this.#adapter.url(path, attemptOpts),
          true,
          ctx
        );
      }
      default: {
        const ctx: ActionContext = { key: op.key, type: "signedUploadUrl" };
        const path = this.#path(op.key);
        return this.#run(
          op.options,
          (attemptOpts) =>
            this.#adapter.signedUploadUrl(
              path,
              attemptOpts as SignUploadOptions
            ),
          true,
          ctx
        );
      }
    }
  }

  /** The prefix-aware `list` body, extracted so {@link Files.#perform} stays flat. */
  #performList(opts?: ListOptions): Promise<ListResult> {
    const ctx: ActionContext = { type: "list" };
    this.#assertDelimiterSupported(opts);
    if (!this.#prefix) {
      return this.#run(
        opts,
        (attemptOpts) => this.#adapter.list(attemptOpts),
        true,
        ctx
      );
    }
    const prefix = opts?.prefix
      ? `${this.#prefix}/${opts.prefix.replace(/^\/+/u, "")}`
      : `${this.#prefix}/`;
    return this.#run(
      opts,
      async (attemptOpts) => {
        const result = await this.#adapter.list({ ...attemptOpts, prefix });
        return {
          ...result,
          items: result.items.map((item) => this.#storedFile(item)),
          ...(result.prefixes && {
            prefixes: result.prefixes.map((p) => this.#stripPrefix(p)),
          }),
        };
      },
      true,
      ctx
    );
  }

  /**
   * Wrap a public operation so it reports a single `onAction` event when it
   * settles, plus `onError` when it rejects. Short-circuits to the bare call
   * when neither hook is set, so the no-hooks path stays cheap. `onRetry` is
   * emitted separately, from {@link Files.#run}.
   */
  async #action<T>(
    ctx: ActionContext,
    fn: () => Promise<T>,
    sha256Of?: () => Promise<string | undefined>
  ): Promise<T> {
    const hooks = this.#hooks;
    if (!(hooks?.onAction || hooks?.onError)) {
      return fn();
    }
    const startedAt = Date.now();
    try {
      const result = await fn();
      const settledAt = Date.now();
      const durationMs = settledAt - startedAt;
      if (hooks.onAction) {
        // The fingerprint is resolved here — on the success path, and only when
        // an `onAction` is present to receive it — so a missing receipt
        // consumer, or an upload that failed, never reads or hashes the body.
        // `sha256Of` swallows its own read/hash errors: a receipt must never
        // break the operation it observes.
        const sha256 =
          this.#receipts.sha256 && sha256Of ? await sha256Of() : undefined;
        const receipt = this.#makeReceipt(
          ctx,
          result,
          durationMs,
          settledAt,
          sha256
        );
        emitHook(hooks.onAction, {
          ...ctx,
          durationMs,
          result,
          status: "success",
          ...(receipt && { receipt }),
        });
      }
      return result;
    } catch (error) {
      const wrapped = FilesError.wrap(error);
      const durationMs = Date.now() - startedAt;
      emitHook(hooks.onError, { ...ctx, durationMs, error: wrapped });
      emitHook(hooks.onAction, {
        ...ctx,
        durationMs,
        error: wrapped,
        status: "error",
      });
      throw wrapped;
    }
  }

  /**
   * Build the provenance {@link Receipt} for a settled mutating call, or
   * `undefined` when receipts are off or the verb isn't one a receipt describes
   * (reads, `signedUploadUrl`). Every field but `sha256` is derived from what
   * the action already holds — the caller-facing key (`ctx.key` for
   * `upload` / `delete`, `ctx.to` for `copy` / `move`), the adapter name, and
   * `bytes` / `etag` read off a single-`upload` {@link UploadResult}. `sha256`
   * is the only value passed in pre-computed, and only by the upload path.
   */
  #makeReceipt(
    ctx: ActionContext,
    result: unknown,
    durationMs: number,
    ts: number,
    sha256?: string
  ): Receipt | undefined {
    if (!this.#receipts.enabled) {
      return;
    }
    const op = receiptOpFor(ctx.type);
    // Receipts describe content landing at a key. `copy` / `move` report the
    // destination; everything else reports its own key. The bulk array forms
    // carry `keys` rather than `key` and aggregate many results, so they don't
    // map onto a single per-object receipt — skip them.
    const key = op === "copy" || op === "move" ? ctx.to : ctx.key;
    if (op === undefined || key === undefined) {
      return;
    }
    const upload =
      op === "upload" && result !== null && typeof result === "object"
        ? (result as Partial<UploadResult>)
        : undefined;
    return buildReceipt({
      durationMs,
      key,
      op,
      provider: this.#adapter.name,
      ts,
      ...(typeof upload?.size === "number" && { bytes: upload.size }),
      ...(typeof upload?.etag === "string" && { etag: upload.etag }),
      ...(sha256 !== undefined && { sha256 }),
    });
  }

  get raw(): A["raw"] {
    return this.#adapter.raw;
  }

  get adapter(): A {
    return this.#adapter;
  }

  /**
   * The instance's key prefix (normalized — no leading/trailing slashes), or
   * `""` when none was configured. Plugins that build an internal
   * {@link Files} over {@link Files.adapter} (e.g. `extend` methods that
   * address the same store directly) must re-apply it, or their keys won't
   * line up with operations that ran through the instance.
   */
  get prefix(): string {
    return this.#prefix;
  }

  /**
   * A queryable snapshot of what the underlying adapter can do — see
   * {@link AdapterCapabilities}. Lets callers branch on capability up front
   * (e.g. skip a `range` request when `rangeRead` is `false`, or fall back to
   * `download()` when `signedUrl.supported` is `false`) instead of discovering
   * the limit by catching a throw at call time.
   *
   * Derived live from the adapter on each read, so a plugin that swaps
   * behaviors is always reflected. The derived flags read the exact per-adapter
   * flags / optional methods the wrapper gates on, so they cannot drift from
   * runtime behavior; `serverSideCopy` and `signedUrl` come from what the
   * adapter declares, defaulting to the conservative value when it declares
   * nothing.
   */
  get capabilities(): AdapterCapabilities {
    const a = this.#adapter;
    return {
      cacheControl: a.supportsCacheControl === true,
      delimiter: a.supportsDelimiter === true,
      metadata: a.supportsMetadata === true,
      multipart: typeof a.resumableUpload === "function",
      rangeRead: a.supportsRange === true,
      serverSideCopy: a.supportsServerSideCopy === true,
      signedUrl: a.signedUrl ?? { supported: false },
      uploadProgress: a.reportsUploadProgress === true,
    };
  }

  readonly(): Files<A> {
    return new Files({
      ...this.#defaults,
      adapter: this.#adapter,
      hooks: this.#hooks,
      prefix: this.#prefix || undefined,
      readonly: true,
      ...(this.#receiptsOption !== undefined && {
        receipts: this.#receiptsOption,
      }),
      // Carry plugins so the read-only clone keeps the same onion and surface;
      // `extend` re-runs in the clone's constructor.
      ...(this.#plugins && { plugins: this.#plugins }),
    });
  }

  file(key: string): FileHandle {
    assertValidKey(key);
    return {
      copyFrom: (sourceKey, opts) => this.copy(sourceKey, key, opts),
      copyTo: (destinationKey, opts) => this.copy(key, destinationKey, opts),
      delete: (opts) => this.delete(key, opts),
      download: (opts) => this.download(key, opts),
      exists: (opts) => this.exists(key, opts),
      head: (opts) => this.head(key, opts),
      key,
      moveFrom: (sourceKey, opts) => this.move(sourceKey, key, opts),
      moveTo: (destinationKey, opts) => this.move(key, destinationKey, opts),
      signedUploadUrl: (opts) => this.signedUploadUrl(key, opts),
      upload: (body, opts) => this.upload(key, body, opts),
      url: (opts) => this.url(key, opts),
    };
  }

  #writeAction<T>(
    ctx: ActionContext & { type: WriteActionType },
    fn: () => Promise<T>,
    sha256Of?: () => Promise<string | undefined>
  ): Promise<T> {
    return this.#action(
      ctx,
      () => {
        this.#assertWritable(ctx.type);
        return fn();
      },
      sha256Of
    );
  }

  /**
   * The SHA-256 to stamp on a single `upload`'s receipt, or `undefined` when
   * the body is a stream the SDK won't buffer, or reading/hashing it fails.
   * This is the **only** per-call cost the receipts feature can incur; it's
   * invoked from {@link Files.#action} on the success path, gated on
   * `receipts: { sha256: true }`. A read or digest error degrades to no
   * fingerprint rather than rejecting — a receipt must never break the upload
   * it describes.
   */
  async #uploadSha256(body: Body): Promise<string | undefined> {
    if (!(this.#receipts.enabled && this.#receipts.sha256)) {
      return;
    }
    try {
      const bytes = await bufferedBodyBytes(body);
      return bytes === undefined ? undefined : await sha256Hex(bytes);
    } catch {
      return undefined;
    }
  }

  /**
   * Upload one object or many.
   *
   * - `upload(key, body, opts)` stores a single object and resolves to its
   *   {@link UploadResult}. A failure **throws** a {@link FilesError}.
   * - `upload(items)` stores many in one call — each item carries its own
   *   `key`, `body`, and optional `contentType` / `cacheControl` / `metadata`
   *   — and resolves to an {@link UploadManyResult}. It does **not** throw on
   *   partial failure: successes land in `uploaded`, per-item failures
   *   (including invalid keys) in `errors`, both in the order supplied. The
   *   SDK fans out with bounded `concurrency` (default 8); `stopOnError`
   *   short-circuits at the first failure.
   *
   * Both forms honor the client's `prefix`; the array form reports the keys
   * the caller passed, not the internal prefixed paths.
   */
  upload(key: string, body: Body, opts?: UploadOptions): Promise<UploadResult>;
  upload(
    items: UploadManyItem[],
    opts?: UploadManyOptions
  ): Promise<UploadManyResult>;
  upload(
    keyOrItems: string | UploadManyItem[],
    bodyOrOpts?: Body | UploadManyOptions,
    opts?: UploadOptions
  ): Promise<UploadResult | UploadManyResult> {
    if (Array.isArray(keyOrItems)) {
      const items = keyOrItems;
      const bulkOpts = bodyOrOpts as UploadManyOptions | undefined;
      return this.#writeAction(
        { keys: items.map((item) => item.key), type: "upload" },
        () => this.#uploadMany(items, bulkOpts)
      );
    }
    const body = bodyOrOpts as Body;
    const ctx: ActionContext & { type: "upload" } = {
      key: keyOrItems,
      type: "upload",
    };
    // The body is handed to the adapter untouched. Any `sha256` is taken from it
    // lazily on the success path (see `#action`), so an upload with no receipt
    // consumer — or one that fails — never reads or hashes the body.
    return this.#writeAction(
      ctx,
      () =>
        this.#dispatch(
          { body, key: keyOrItems, kind: "upload", options: opts },
          (op) => this.#perform(op)
        ),
      () => this.#uploadSha256(body)
    );
  }

  /**
   * Run a single upload, threading {@link UploadOptions.onProgress} through.
   *
   * When the adapter reports progress itself
   * ({@link Adapter.reportsUploadProgress}) the callback is passed straight to
   * it. Otherwise the wrapper reports generically: a `ReadableStream` body is
   * wrapped so bytes are counted as the adapter drains it; a buffered body
   * brackets the call with a `0` and a final event.
   */
  #runUpload(
    key: string,
    body: Body,
    opts?: UploadOptions,
    ctx?: ActionContext
  ): Promise<UploadResult> {
    this.#assertUploadOptionsSupported(opts);
    const path = this.#path(key);
    if (opts?.control) {
      return this.#runResumable(path, body, opts, opts.control);
    }
    const isStream = body instanceof ReadableStream;
    const onProgress = opts?.onProgress;

    if (!onProgress || this.#adapter.reportsUploadProgress) {
      return this.#run(
        opts,
        async (attemptOpts) =>
          this.#uploadResult(
            await this.#adapter.upload(path, body, attemptOpts)
          ),
        !isStream,
        ctx
      );
    }

    // Generic progress: the adapter does not report it, so the wrapper does.
    // Strip `onProgress` from the options the adapter sees — it would ignore
    // it anyway, and dropping it keeps `total` ownership here.
    const { onProgress: _onProgress, ...rest } = opts ?? {};
    const total = byteLengthOf(body);

    if (isStream) {
      const tracked = countingStream(body, (loaded) =>
        // `onProgress` is fire-and-forget: route it through `emitHook` so a
        // throwing reporter can't error the stream and fail the upload.
        emitHook(
          onProgress,
          total === undefined ? { loaded } : { loaded, total }
        )
      );
      return this.#run(
        rest,
        async (attemptOpts) =>
          this.#uploadResult(
            await this.#adapter.upload(path, tracked, attemptOpts)
          ),
        false,
        ctx
      );
    }

    // `emitHook` swallows a throw from `onProgress` — a buffered upload's final
    // report runs inside the retryable attempt below, so an unguarded throw
    // there would be caught by `#run` and wrongly retried as a provider error,
    // re-uploading the body. See the fire-and-forget contract on `FilesHooks`.
    emitHook(
      onProgress,
      total === undefined ? { loaded: 0 } : { loaded: 0, total }
    );
    return this.#run(
      rest,
      async (attemptOpts) => {
        const result = this.#uploadResult(
          await this.#adapter.upload(path, body, attemptOpts)
        );
        const done = total ?? result.size;
        emitHook(onProgress, { loaded: done, total: done });
        return result;
      },
      true,
      ctx
    );
  }

  /**
   * Drive a pause-able / resumable upload via {@link UploadOptions.control}.
   * Gates on the adapter's optional {@link Adapter.resumableUpload} capability
   * (mirroring {@link Files.#assertRangeSupported}) and on a re-readable body,
   * then hands off to the orchestrator. Bypasses {@link Files.#run} — the
   * orchestrator owns per-chunk retry and abort, so retrying the whole call
   * would restart the upload from zero.
   */
  #runResumable(
    path: string,
    body: Body,
    opts: UploadOptions,
    control: UploadControl
  ): Promise<UploadResult> {
    if (!this.#adapter.resumableUpload) {
      throw new FilesError(
        "Provider",
        `${this.#adapter.name}: pause-able/resumable uploads are not supported by this adapter`
      );
    }
    const driver = this.#adapter.resumableUpload(path, {
      ...(opts.multipart !== undefined && { multipart: opts.multipart }),
      ...(opts.cacheControl && { cacheControl: opts.cacheControl }),
      ...(opts.metadata && { metadata: opts.metadata }),
    });
    const signals = [this.#defaults.signal, opts.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );
    const timeout = opts.timeout ?? this.#defaults.timeout;
    return runResumableUpload({
      body,
      control,
      driver,
      signals,
      ...(opts.contentType && { contentTypeHint: opts.contentType }),
      ...(opts.multipart !== undefined && { multipart: opts.multipart }),
      ...(opts.onProgress && { onProgress: opts.onProgress }),
      retries: opts.retries ?? this.#defaults.retries,
      ...(timeout !== undefined && { timeout }),
    }).then((result) => this.#uploadResult(result));
  }

  async #uploadMany(
    items: UploadManyItem[],
    opts?: UploadManyOptions
  ): Promise<UploadManyResult> {
    const onProgress = opts?.onProgress;
    const { errors, results } = await mapMany(
      items,
      (item) => item.key,
      (item) => {
        const itemOpts: UploadOptions = {
          cacheControl: item.cacheControl,
          contentType: item.contentType,
          metadata: item.metadata,
          ...(item.multipart !== undefined && { multipart: item.multipart }),
          ...(onProgress && {
            onProgress: (progress: UploadProgress) =>
              onProgress({ ...progress, key: item.key }),
          }),
        };
        // Route each item through the onion (so a transform/veto sees bulk
        // uploads too). The item's own upload uses #runUpload as the base —
        // no `ctx`, so bulk items retry the buffered body without firing
        // `onRetry`, exactly as before.
        return this.#dispatch(
          {
            body: item.body,
            bulk: true,
            key: item.key,
            kind: "upload",
            options: itemOpts,
          },
          (op) => {
            // A plugin may re-route to a different verb (e.g. an `exists`
            // probe); those sub-ops take the full single-op path. Only the
            // item's own `upload` stays on the retry-free, hook-quiet base.
            if (op.kind !== "upload") {
              return this.#perform(op);
            }
            return this.#runUpload(op.key, op.body, op.options);
          }
        );
      },
      opts
    );
    return errors.length === 0
      ? { uploaded: results }
      : { errors, uploaded: results };
  }

  /**
   * Download one object or many.
   *
   * - `download(key, opts)` resolves to a single {@link StoredFile}; a missing
   *   key (or any failure) **throws** a {@link FilesError}.
   * - `download(keys, opts)` resolves to a {@link DownloadManyResult} and does
   *   **not** throw on partial failure: successes land in `downloaded`,
   *   per-key failures (a missing key included) in `errors`, both in input
   *   order. `as` applies to every download; the SDK fans out with bounded
   *   `concurrency` (default 8) and `stopOnError` stops at the first failure.
   *
   * Both forms honor the client's `prefix` and report the caller's keys.
   */
  download(key: string, opts?: DownloadOptions): Promise<StoredFile>;
  download(
    keys: string[],
    opts?: DownloadManyOptions
  ): Promise<DownloadManyResult>;
  download(
    keyOrKeys: string | string[],
    opts?: DownloadOptions | DownloadManyOptions
  ): Promise<StoredFile | DownloadManyResult> {
    if (Array.isArray(keyOrKeys)) {
      const keys = keyOrKeys;
      return this.#action({ keys, type: "download" }, () =>
        this.#downloadMany(keys, opts as DownloadManyOptions | undefined)
      );
    }
    const ctx: ActionContext = { key: keyOrKeys, type: "download" };
    return this.#action(ctx, () =>
      this.#dispatch(
        {
          key: keyOrKeys,
          kind: "download",
          options: opts as DownloadOptions | undefined,
        },
        (op) => this.#perform(op)
      )
    );
  }

  /**
   * Validate a requested byte range and confirm the adapter can serve it.
   * Runs inside the `#action` wrapper so a bad range or an unsupported adapter
   * surfaces through `onError` like any other download failure, and short of a
   * real byte-range primitive we throw rather than quietly fetch-and-slice the
   * whole object (which would forfeit the bandwidth saving callers reach for
   * range to get).
   */
  #assertRangeSupported(range: ByteRange): void {
    const { start, end } = range;
    if (!Number.isInteger(start) || start < 0) {
      throw new FilesError(
        "Provider",
        "range.start must be a non-negative integer"
      );
    }
    if (end !== undefined && (!Number.isInteger(end) || end < start)) {
      throw new FilesError(
        "Provider",
        "range.end must be an integer greater than or equal to range.start"
      );
    }
    if (!this.#adapter.supportsRange) {
      throw new FilesError(
        "Provider",
        `${this.#adapter.name}: range downloads are not supported by this adapter`
      );
    }
  }

  /**
   * Reject upload options the adapter can't honor, before any provider call —
   * the metadata/cacheControl analogue of {@link Files.#assertRangeSupported}.
   * An adapter advertises support via {@link Adapter.supportsMetadata} /
   * {@link Adapter.supportsCacheControl}; without it, passing the option throws
   * rather than silently dropping the caller's metadata. An empty `metadata`
   * object is treated as "none" so callers can pass `{}` unconditionally. Runs
   * for both the single and bulk upload paths and ahead of the resumable
   * branch, so it is the one place every adapter is gated.
   */
  #assertUploadOptionsSupported(opts?: UploadOptions): void {
    if (
      opts?.metadata &&
      Object.keys(opts.metadata).length > 0 &&
      !this.#adapter.supportsMetadata
    ) {
      throw new FilesError(
        "Provider",
        `${this.#adapter.name}: \`metadata\` is not supported by this adapter`
      );
    }
    if (opts?.cacheControl && !this.#adapter.supportsCacheControl) {
      throw new FilesError(
        "Provider",
        `${this.#adapter.name}: \`cacheControl\` is not supported by this adapter`
      );
    }
  }

  async #downloadMany(
    keys: string[],
    opts?: DownloadManyOptions
  ): Promise<DownloadManyResult> {
    const as = opts?.as;
    const { errors, results } = await mapMany(
      keys,
      (key) => key,
      (key) =>
        // Per-item onion with the existing adapter call as the base — no #run,
        // so bulk reads stay retry-free, as documented.
        this.#dispatch(
          {
            bulk: true,
            key,
            kind: "download",
            options: as ? { as } : undefined,
          },
          async (op) => {
            // A plugin re-routing to another verb takes the full single-op
            // path; only the item's own `download` stays on this base —
            // retry-free, but still under the constructor `signal`/`timeout`
            // via the non-retryable #run.
            if (op.kind !== "download") {
              return this.#perform(op);
            }
            return this.#storedFile(
              await this.#run(
                op.options,
                (o) => this.#adapter.download(this.#path(op.key), o),
                false
              )
            );
          }
        ),
      opts
    );
    return errors.length === 0
      ? { downloaded: results }
      : { downloaded: results, errors };
  }

  /**
   * Fetch metadata only — does not transfer the body. Pass one key for a
   * single {@link StoredFile} (throws on failure), or an array for a
   * {@link HeadManyResult} (`files` + per-key `errors`, never throws on
   * partial failure; honors `concurrency` / `stopOnError`).
   *
   * **Note:** the returned `StoredFile` still exposes `text()` /
   * `arrayBuffer()` / `blob()` / `stream()`, but those accessors lazily
   * issue a full GET on first use. If you only want metadata, don't call
   * the body accessors. They are not free.
   */
  head(key: string, opts?: OperationOptions): Promise<StoredFile>;
  head(keys: string[], opts?: BulkOptions): Promise<HeadManyResult>;
  head(
    keyOrKeys: string | string[],
    opts?: OperationOptions | BulkOptions
  ): Promise<StoredFile | HeadManyResult> {
    if (Array.isArray(keyOrKeys)) {
      const keys = keyOrKeys;
      return this.#action({ keys, type: "head" }, () =>
        this.#headMany(keys, opts as BulkOptions | undefined)
      );
    }
    const ctx: ActionContext = { key: keyOrKeys, type: "head" };
    return this.#action(ctx, () =>
      this.#dispatch(
        {
          key: keyOrKeys,
          kind: "head",
          options: opts as OperationOptions | undefined,
        },
        (op) => this.#perform(op)
      )
    );
  }

  async #headMany(keys: string[], opts?: BulkOptions): Promise<HeadManyResult> {
    const { errors, results } = await mapMany(
      keys,
      (key) => key,
      (key) =>
        this.#dispatch(
          { bulk: true, key, kind: "head", options: undefined },
          async (op) => {
            // A plugin re-routing to another verb takes the full single-op
            // path; only the item's own `head` stays on this base —
            // retry-free, but still under the constructor `signal`/`timeout`
            // via the non-retryable #run.
            if (op.kind !== "head") {
              return this.#perform(op);
            }
            return this.#storedFile(
              await this.#run(
                op.options,
                (o) => this.#adapter.head(this.#path(op.key), o),
                false
              )
            );
          }
        ),
      opts
    );
    return errors.length === 0
      ? { files: results }
      : { errors, files: results };
  }

  /**
   * Check whether one key or many exist, without fetching bodies.
   *
   * - `exists(key)` resolves to `true` when the object exists and `false` when
   *   the adapter reports `NotFound`. Other failures still propagate so
   *   callers do not treat auth or transport errors as "missing file".
   * - `exists(keys)` resolves to an {@link ExistsManyResult}: keys split into
   *   `existing` / `missing` (both in input order), with hard errors (auth,
   *   transport) collected in `errors` rather than thrown. The SDK fans out
   *   with bounded `concurrency` (default 8); `stopOnError` stops at the first
   *   hard error.
   */
  exists(key: string, opts?: OperationOptions): Promise<boolean>;
  exists(keys: string[], opts?: BulkOptions): Promise<ExistsManyResult>;
  exists(
    keyOrKeys: string | string[],
    opts?: OperationOptions | BulkOptions
  ): Promise<boolean | ExistsManyResult> {
    if (Array.isArray(keyOrKeys)) {
      const keys = keyOrKeys;
      return this.#action({ keys, type: "exists" }, () =>
        this.#existsMany(keys, opts as BulkOptions | undefined)
      );
    }
    const ctx: ActionContext = { key: keyOrKeys, type: "exists" };
    return this.#action(ctx, () =>
      this.#dispatch(
        {
          key: keyOrKeys,
          kind: "exists",
          options: opts as OperationOptions | undefined,
        },
        (op) => this.#perform(op)
      )
    );
  }

  async #existsMany(
    keys: string[],
    opts?: BulkOptions
  ): Promise<ExistsManyResult> {
    const { errors, results } = await mapMany(
      keys,
      (key) => key,
      async (key) => ({
        exists: await this.#dispatch(
          { bulk: true, key, kind: "exists", options: undefined },
          (op) => {
            // A plugin re-routing to another verb takes the full single-op
            // path; only the item's own `exists` stays on this base —
            // retry-free, but still under the constructor `signal`/`timeout`
            // via the non-retryable #run.
            if (op.kind !== "exists") {
              return this.#perform(op);
            }
            return this.#run(
              op.options,
              (o) => this.#adapter.exists(this.#path(op.key), o),
              false
            );
          }
        ),
        key,
      }),
      opts
    );
    const existing: string[] = [];
    const missing: string[] = [];
    for (const result of results) {
      (result.exists ? existing : missing).push(result.key);
    }
    return errors.length === 0
      ? { existing, missing }
      : { errors, existing, missing };
  }

  /**
   * Remove one key or many.
   *
   * - `delete(key)` removes a single object and resolves to `void`. A failure
   *   (including a missing key on providers that don't treat delete as
   *   idempotent) **throws** a {@link FilesError}.
   * - `delete(keys)` removes many in one call and resolves to a
   *   {@link DeleteManyResult}. It does **not** throw on partial failure —
   *   per-key failures (and invalid keys) are collected in `errors`, deleted
   *   keys in `deleted`, both in the order supplied. The adapter's native
   *   bulk primitive is used when available, otherwise the SDK fans out to
   *   single deletes with bounded `concurrency`. With `stopOnError`, the first
   *   failure short-circuits and returns the keys deleted so far plus that
   *   error.
   *
   * Both forms honor the client's `prefix`; the array form reports the keys
   * the caller passed, not the internal prefixed paths.
   */
  delete(key: string, opts?: OperationOptions): Promise<void>;
  delete(keys: string[], opts?: DeleteManyOptions): Promise<DeleteManyResult>;
  delete(
    key: string | string[],
    opts?: OperationOptions | DeleteManyOptions
  ): Promise<void | DeleteManyResult> {
    if (Array.isArray(key)) {
      const keys = key;
      return this.#writeAction({ keys, type: "delete" }, () =>
        this.#deleteMany(keys, opts as DeleteManyOptions | undefined)
      );
    }
    const ctx: ActionContext & { type: "delete" } = { key, type: "delete" };
    return this.#writeAction(ctx, () =>
      this.#dispatch(
        {
          key,
          kind: "delete",
          options: opts as OperationOptions | undefined,
        },
        (op) => this.#perform(op)
      )
    );
  }

  async #deleteMany(
    keys: string[],
    opts?: DeleteManyOptions
  ): Promise<DeleteManyResult> {
    // With a wrapping plugin installed, the native batch primitive would delete
    // many keys in one call no plugin could intercept, so fan out per key
    // through the onion instead — at the cost of the batch round-trip.
    // `deleteManyWithFallback` gives the same input-order errors, `stopOnError`,
    // and bounded `concurrency`; an invalid key throws in `#path` inside the
    // per-key call and is collected like any other failure.
    if (this.#wraps.length > 0) {
      return deleteManyWithFallback(
        keys,
        (key) =>
          this.#dispatch(
            { bulk: true, key, kind: "delete", options: undefined },
            (op) => {
              // A plugin re-routing to another verb (e.g. a snapshot `head` +
              // `copy`) takes the full single-op path; only the item's own
              // `delete` stays on this base — retry-free, but still under
              // the constructor `signal`/`timeout` via the non-retryable
              // #run.
              if (op.kind !== "delete") {
                return this.#perform(op);
              }
              return this.#run(
                op.options,
                (o) => this.#adapter.delete(this.#path(op.key), o),
                false
              );
            }
          ),
        opts
      );
    }
    // Track each error's position in the caller's array so the final
    // `errors` list stays in input order, even when invalid keys (caught
    // here) interleave with provider failures (reported by the adapter).
    const errors: (DeleteManyError & { index: number })[] = [];
    // Adapters operate on prefixed paths; map each back so the result
    // reflects the keys the caller passed, not the internal path.
    const paths: string[] = [];
    const keyByPath = new Map<string, string>();
    const indexByPath = new Map<string, number>();

    for (const [index, key] of keys.entries()) {
      let path: string;
      try {
        path = this.#path(key);
      } catch (error) {
        if (opts?.stopOnError) {
          // Short-circuit before any delete is attempted.
          return {
            deleted: [],
            errors: [{ error: FilesError.wrap(error), key: String(key) }],
          };
        }
        errors.push({ error: FilesError.wrap(error), index, key: String(key) });
        continue;
      }
      paths.push(path);
      if (!keyByPath.has(path)) {
        keyByPath.set(path, key);
        indexByPath.set(path, index);
      }
    }

    const toKey = (path: string): string => keyByPath.get(path) ?? path;

    // Retry-free (as documented for bulk), but still under the constructor
    // `signal`/`timeout` via the non-retryable #run. The native bulk
    // primitive takes no per-call signal, so the whole batch runs under one
    // #run; the fan-out fallback runs one per key.
    const nativeDeleteMany = this.#adapter.deleteMany?.bind(this.#adapter);
    const result = nativeDeleteMany
      ? await this.#run(undefined, () => nativeDeleteMany(paths, opts), false)
      : await deleteManyWithFallback(
          paths,
          (path) =>
            this.#run(undefined, (o) => this.#adapter.delete(path, o), false),
          opts
        );

    const deleted = result.deleted.map(toKey);
    for (const entry of result.errors ?? []) {
      errors.push({
        error: entry.error,
        index: indexByPath.get(entry.key) ?? Number.MAX_SAFE_INTEGER,
        key: toKey(entry.key),
      });
    }

    if (errors.length === 0) {
      return { deleted };
    }
    errors.sort((a, b) => a.index - b.index);
    return {
      deleted,
      errors: errors.map(({ error, key }) => ({ error, key })),
    };
  }

  copy(from: string, to: string, opts?: OperationOptions): Promise<void> {
    const ctx: ActionContext & { type: "copy" } = {
      from,
      to,
      type: "copy",
    };
    return this.#writeAction(ctx, () =>
      this.#dispatch({ from, kind: "copy", options: opts, to }, (op) =>
        this.#perform(op)
      )
    );
  }

  /**
   * Move (rename) `from` to `to`, resolving to `void`. A failure (e.g. a
   * missing source) **throws** a {@link FilesError}.
   *
   * Uses the adapter's native rename when it has one (the local filesystem,
   * FTP, SFTP) and otherwise falls back to `copy()` then `delete()` — the same
   * two-step every object store does, since none offer an atomic move. The
   * fallback is therefore **not atomic**: a crash between the copy and the
   * delete can leave the object at both keys.
   *
   * Moving a key onto itself (`from === to`, after the client `prefix` is
   * applied) is a no-op — the fallback would otherwise copy the object onto
   * itself and then delete it, destroying it.
   *
   * Honors the client's `prefix`; the action hook reports the keys the caller
   * passed, not the internal prefixed paths.
   */
  move(from: string, to: string, opts?: OperationOptions): Promise<void> {
    const ctx: ActionContext & { type: "move" } = {
      from,
      to,
      type: "move",
    };
    return this.#writeAction(ctx, () =>
      this.#dispatch({ from, kind: "move", options: opts, to }, (op) =>
        this.#perform(op)
      )
    );
  }

  async #move(
    fromPath: string,
    toPath: string,
    opts?: OperationOptions
  ): Promise<void> {
    if (fromPath === toPath) {
      return;
    }
    if (this.#adapter.move) {
      await this.#adapter.move(fromPath, toPath, opts);
      return;
    }
    await this.#adapter.copy(fromPath, toPath, opts);
    await this.#adapter.delete(fromPath, opts);
  }

  list(opts?: ListOptions): Promise<ListResult> {
    const ctx: ActionContext = { type: "list" };
    return this.#action(ctx, () =>
      this.#dispatch({ kind: "list", options: opts }, (op) => this.#perform(op))
    );
  }

  /**
   * Iterate every object, transparently following the cursor across pages.
   *
   * `list()` returns one page plus a `cursor`; most callers actually want
   * "walk everything under this prefix", which means a manual cursor loop.
   * This is that loop as an async iterable:
   *
   * ```ts
   * for await (const file of files.listAll({ prefix: "avatars/" })) {
   *   console.log(file.key, file.size);
   * }
   * ```
   *
   * `prefix` scopes the walk and `limit` sets the page size (how many keys
   * each underlying `list()` fetches), not a total cap — pass a `cursor` to
   * resume from a prior position. Each page is a real `list()` call, so it
   * honors the client `prefix`, retries/timeouts, and fires one `onAction`
   * `list` hook per page. Stop early by `break`ing out of the loop; no further
   * pages are fetched.
   *
   * @yields {StoredFile} each stored object, one page at a time, following the cursor.
   */
  async *listAll(opts?: ListOptions): AsyncGenerator<StoredFile, void> {
    // `delimiter` would collapse nested keys into folders, so `listAll` would
    // silently walk only the top level. It yields objects, so strip it and
    // always walk the full tree; use `list()` directly for the folder view.
    const { delimiter: _delimiter, ...rest } = opts ?? {};
    let { cursor } = rest;
    do {
      const page = await this.list(cursor ? { ...rest, cursor } : rest);
      yield* page.items;
      ({ cursor } = page);
    } while (cursor);
  }

  /**
   * Find objects whose key matches `pattern`, walking every page like
   * {@link listAll}.
   *
   * `pattern` is a glob by default (standard glob via picomatch: `*` stays
   * within a path segment, `**` spans segments, `?` is one character, plus
   * `[a-z]` classes, `{a,b}` braces, and `!` negation). Pass a `RegExp`, or
   * `match: "regex" | "substring" | "exact"`, to switch how a string is
   * interpreted (see {@link SearchMatch}). Matching is against the
   * caller-facing key, so the instance `prefix` is already stripped.
   *
   * ```ts
   * for await (const file of files.search("photos/*.jpg")) {
   *   console.log(file.key, file.size);
   * }
   * // "**" spans path segments — every object under uploads/, at any depth:
   * const all = await Array.fromAsync(files.search("uploads/**"));
   * ```
   *
   * For a glob, the literal head is pushed down as a `list()` prefix so the
   * walk is scoped (`uploads/2024/*.pdf` only lists the `uploads/2024` prefix);
   * for other modes pass {@link SearchOptions.prefix} to bound it. Search reads
   * every page under that prefix — use {@link SearchOptions.maxResults} or
   * `break` to stop early. Matching against `file.key` reuses the same page walk
   * as {@link listAll}, so retries/timeouts and the `onAction` `list` hook apply
   * per page.
   *
   * @yields {StoredFile} each matching object, following the cursor across pages.
   */
  async *search(
    pattern: string | RegExp,
    opts?: SearchOptions
  ): AsyncGenerator<StoredFile, void> {
    const {
      prefix,
      limit,
      maxResults,
      match = "glob",
      caseInsensitive = false,
      ...rest
    } = opts ?? {};
    if (maxResults !== undefined && maxResults <= 0) {
      return;
    }
    const matches = buildSearchMatcher(pattern, match, caseInsensitive);
    // Only a glob carries an inferable literal prefix, and only when matching
    // case-sensitively (a provider prefix filter can't be case-folded).
    const walkPrefix =
      prefix ??
      (typeof pattern === "string" && match === "glob" && !caseInsensitive
        ? globPrefix(pattern)
        : "");
    const listOpts: ListOptions = { ...rest };
    if (walkPrefix) {
      listOpts.prefix = walkPrefix;
    }
    if (limit !== undefined) {
      listOpts.limit = limit;
    }
    let yielded = 0;
    for await (const file of this.listAll(listOpts)) {
      if (matches(file.key)) {
        yield file;
        yielded += 1;
        if (maxResults !== undefined && yielded >= maxResults) {
          return;
        }
      }
    }
  }

  /**
   * Return a URL the caller can use to fetch `key`.
   *
   * The exact URL kind depends on the adapter — see {@link Adapter.url}
   * for the per-provider behavior. In short: signing adapters (S3, R2
   * HTTP, MinIO, DigitalOcean Spaces, Storj, Hetzner, Akamai, Backblaze B2,
   * Wasabi, Tigris) return an expiring presigned URL by default;
   * Vercel-Blob-public returns its permanent CDN URL; configurations
   * with no URL primitive (Vercel-Blob-private, R2 binding without
   * `publicBaseUrl`/HTTP creds) throw.
   *
   * **Caller is responsible for URL-encoding.** Adapters do not escape
   * special characters in keys when building URLs against a
   * `publicBaseUrl` or Vercel Blob's fast path. If `key` is derived
   * from untrusted input, callers should validate or escape it.
   */
  url(key: string, opts?: UrlOptions): Promise<string> {
    const ctx: ActionContext = { key, type: "url" };
    return this.#action(ctx, () =>
      this.#dispatch({ key, kind: "url", options: opts }, (op) =>
        this.#perform(op)
      )
    );
  }

  signedUploadUrl(key: string, opts: SignUploadOptions): Promise<SignedUpload> {
    const ctx: ActionContext & { type: "signedUploadUrl" } = {
      key,
      type: "signedUploadUrl",
    };
    return this.#writeAction(ctx, () =>
      this.#dispatch({ key, kind: "signedUploadUrl", options: opts }, (op) =>
        this.#perform(op)
      )
    );
  }

  async #run<O extends OperationOptions, T>(
    opts: O | undefined,
    fn: (opts: O | undefined) => Promise<T>,
    retryable = true,
    ctx?: ActionContext
  ): Promise<T> {
    const { retries: _retries, timeout: _timeout, ...adapterOpts } = opts ?? {};
    const baseOpts = opts ? (adapterOpts as O) : undefined;
    const retryOptions = opts?.retries ?? this.#defaults.retries;
    const maxAttempts = maxRetries(retryOptions, retryable);
    const signals = [this.#defaults.signal, opts?.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined
    );

    for (let attempt = 0; ; attempt += 1) {
      const runtime = mergeSignals(
        signals,
        opts?.timeout ?? this.#defaults.timeout
      );
      const attemptOpts = runtime.signal
        ? ({ ...baseOpts, signal: runtime.signal } as O)
        : baseOpts;
      try {
        return await runWithSignal(runtime.signal, () => fn(attemptOpts));
      } catch (error) {
        const wrapped = runtime.signal?.aborted
          ? abortError(runtime.signal.reason)
          : FilesError.wrap(error);
        if (!canRetry(wrapped, attempt, maxAttempts)) {
          throw wrapped;
        }
        const delayMs = retryBackoff(retryOptions, attempt + 1, wrapped);
        if (ctx && this.#hooks?.onRetry) {
          emitHook(this.#hooks.onRetry, {
            attempt: attempt + 1,
            delayMs,
            error: wrapped,
            from: ctx.from,
            key: ctx.key,
            maxRetries: maxAttempts,
            to: ctx.to,
            type: ctx.type,
          });
        }
        const wait = mergeSignals(signals);
        try {
          await sleep(delayMs, wait.signal);
        } finally {
          wait.cleanup?.();
        }
      } finally {
        runtime.cleanup?.();
      }
    }
  }

  #path(key: string, label = "key"): string {
    assertValidKey(key, label);
    if (!this.#prefix) {
      return key;
    }
    const normalized = key.replace(/^\/+/u, "");
    assertNoRelativeSegments(normalized, label);
    return `${this.#prefix}/${normalized}`;
  }

  #assertWritable(operation: WriteActionType): void {
    if (!this.#isReadOnly) {
      return;
    }
    throw new FilesError(
      "ReadOnly",
      `Cannot call ${operation}() on a read-only Files instance.`
    );
  }

  #assertDelimiterSupported(opts?: ListOptions): void {
    if (opts?.delimiter === undefined) {
      return;
    }
    if (opts.delimiter === "") {
      throw new FilesError("Provider", "delimiter must be a non-empty string");
    }
    if (!this.#adapter.supportsDelimiter) {
      throw new FilesError(
        "Provider",
        `${this.#adapter.name}: directory-style listing (delimiter) is not supported by this adapter`
      );
    }
  }

  #storedFile(file: StoredFile): StoredFile {
    if (!this.#prefix) {
      return file;
    }
    // `name` is an alias for the full key (see createStoredFile), so strip it
    // alongside `key` — otherwise the result is internally inconsistent.
    return {
      ...file,
      key: this.#stripPrefix(file.key),
      name: this.#stripPrefix(file.name),
    };
  }

  #uploadResult(result: UploadResult): UploadResult {
    return this.#prefix
      ? { ...result, key: this.#stripPrefix(result.key) }
      : result;
  }

  #stripPrefix(key: string): string {
    const scoped = `${this.#prefix}/`;
    return key.startsWith(scoped) ? key.slice(scoped.length) : key;
  }
}

/**
 * Author a {@link FilesPlugin.wrap} as a per-verb map instead of a single
 * function over the whole {@link FilesOperation} union. List only the verbs you
 * care about — each handler is typed to its own op and a same-kind `next` — and
 * every other verb passes straight through untouched.
 *
 * ```ts
 * const encryption = (key: CryptoKey): FilesPlugin => ({
 *   name: "encryption",
 *   wrap: handlers({
 *     upload: (op, next) =>
 *       seal(op.body, key).then(({ body, iv }) =>
 *         next({ ...op, body, options: { ...op.options, metadata: { ...op.options?.metadata, iv } } })
 *       ),
 *     download: (op, next) => next(op).then((file) => unseal(file, key)),
 *   }),
 * });
 * ```
 *
 * The internal casts are confined here so plugin authors never write one.
 */
export const handlers = (
  map: PluginHandlers
): NonNullable<FilesPlugin["wrap"]> => {
  const wrap = (op: FilesOperation, next: InternalNext): Promise<unknown> => {
    const handler = map[op.kind] as InternalWrap | undefined;
    return handler ? handler(op, next) : next(op);
  };
  return wrap as unknown as NonNullable<FilesPlugin["wrap"]>;
};

/**
 * Construct a {@link Files} instance whose static type includes the methods
 * contributed by each plugin's `extend`. Identical to `new Files(opts)` at
 * runtime — a class constructor can't return `this & Ext` keyed off its
 * arguments, so this factory is the seam that surfaces e.g. `files.usage()` or
 * `files.image.resize(...)` on the type.
 *
 * ```ts
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [usage()],
 * });
 * files.usage(); // typed, from usage().extend
 * ```
 *
 * Plugins that only `wrap` (no `extend`) work with plain `new Files({ plugins })`
 * — they add no surface, so there is nothing extra to type.
 */
export const createFiles = <
  A extends Adapter,
  const P extends readonly FilesPlugin[],
>(
  opts: FilesOptions<A> & { plugins?: P }
): Files<A> & ExtensionsOf<P> => new Files(opts) as Files<A> & ExtensionsOf<P>;
