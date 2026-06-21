// Public client-facing option/result types for `createFilesClient` and the
// React `useFiles` hook. Where a shape already exists on the SDK (`StoredFile`,
// `ListResult`, the bulk result types, `SignedUpload`, `AdapterCapabilities`)
// it is reused verbatim so the browser surface is identical to the server SDK.

import type {
  AdapterCapabilities,
  ByteRange,
  DeleteManyResult,
  DownloadManyResult,
  ExistsManyResult,
  HeadManyResult,
  ListResult,
  SearchMatch,
  SignedUpload,
  StoredFile,
  UploadManyResult,
} from "../index.js";
import type { AggregateProgress, FileUploadState } from "./progress.js";
import type { Transport } from "./transport.js";

export interface FilesClientConfig {
  /** Gateway endpoint. Default `/api/files`. */
  endpoint?: string;
  /** Static or lazily-resolved headers (e.g. an auth token) sent on every gateway call. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Default fan-out for bulk ops. Default 4. */
  concurrency?: number;
  /** Upload transport seam (test injection). Defaults to XHR (progress) with a fetch fallback. */
  transport?: Transport;
  /** `fetch` implementation for JSON verbs + download (test/SSR injection). */
  fetchImpl?: typeof fetch;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface DownloadCallOptions extends CallOptions {
  range?: ByteRange;
  as?: "blob" | "stream";
}

export interface UrlCallOptions extends CallOptions {
  expiresIn?: number;
  responseContentDisposition?: string;
}

export interface ListCallOptions extends CallOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
  delimiter?: string;
}

export interface SearchCallOptions extends CallOptions {
  match?: SearchMatch;
  prefix?: string;
  limit?: number;
  maxResults?: number;
  caseInsensitive?: boolean;
}

export interface SignUploadCallOptions extends CallOptions {
  expiresIn: number;
  contentType?: string;
  maxSize?: number;
  minSize?: number;
}

export interface UploadCallOptions extends CallOptions {
  contentType?: string;
  /** Presign expiry for the keyless path, seconds. */
  expiresIn?: number;
  onProgress?: (
    progress: AggregateProgress,
    perFile: readonly FileUploadState[]
  ) => void;
}

export interface BulkCallOptions extends CallOptions {
  concurrency?: number;
  stopOnError?: boolean;
}

export interface UploadOutcome {
  key: string;
  size: number;
  type: string;
  etag?: string;
  lastModified?: number;
}

export type UploadBody = Blob | ArrayBuffer | ArrayBufferView | string;

export interface UploadManyClientItem {
  key: string;
  body: UploadBody;
  contentType?: string;
}

/**
 * A saved version returned by `versions()` (needs the `versioning()` plugin on
 * the server). Pass `versionId` back to `restoreVersion()`.
 */
export interface FileVersion {
  versionId: string;
  size: number;
  lastModified: number;
  etag?: string;
}

/**
 * A trashed object returned by `trashed()` (needs the `softDelete()` plugin on
 * the server). `key` is the original key — pass it to `restoreTrashed()` /
 * `purge()`.
 */
export interface TrashedFile {
  key: string;
  size: number;
  lastModified?: number;
  etag?: string;
}

export interface FilesClient {
  upload(file: Blob, opts?: UploadCallOptions): Promise<UploadOutcome>;
  upload(
    key: string,
    body: UploadBody,
    opts?: UploadCallOptions
  ): Promise<UploadOutcome>;
  upload(
    items: UploadManyClientItem[],
    opts?: BulkCallOptions
  ): Promise<UploadManyResult>;

  download(key: string, opts?: DownloadCallOptions): Promise<StoredFile>;
  download(
    keys: string[],
    opts?: BulkCallOptions & { as?: "blob" | "stream" }
  ): Promise<DownloadManyResult>;

  head(key: string, opts?: CallOptions): Promise<StoredFile>;
  head(keys: string[], opts?: BulkCallOptions): Promise<HeadManyResult>;

  exists(key: string, opts?: CallOptions): Promise<boolean>;
  exists(keys: string[], opts?: BulkCallOptions): Promise<ExistsManyResult>;

  delete(key: string, opts?: CallOptions): Promise<void>;
  delete(keys: string[], opts?: BulkCallOptions): Promise<DeleteManyResult>;

  copy(from: string, to: string, opts?: CallOptions): Promise<void>;
  move(from: string, to: string, opts?: CallOptions): Promise<void>;
  url(key: string, opts?: UrlCallOptions): Promise<string>;
  signedUploadUrl(
    key: string,
    opts: SignUploadCallOptions
  ): Promise<SignedUpload>;
  list(opts?: ListCallOptions): Promise<ListResult>;
  listAll(opts?: ListCallOptions): AsyncGenerator<StoredFile, void>;
  search(
    pattern: string | RegExp,
    opts?: SearchCallOptions
  ): AsyncGenerator<StoredFile, void>;
  capabilities(opts?: CallOptions): Promise<AdapterCapabilities>;

  // Plugin verbs — resolve only when the server gateway exposes the matching
  // plugin (`versioning()` / `softDelete()`); otherwise they reject with a
  // gateway error. See the relevant plugin docs.
  versions(key: string, opts?: CallOptions): Promise<FileVersion[]>;
  restoreVersion(
    key: string,
    versionId?: string,
    opts?: CallOptions
  ): Promise<StoredFile>;
  trashed(opts?: CallOptions): Promise<TrashedFile[]>;
  restoreTrashed(key: string, opts?: CallOptions): Promise<StoredFile>;
  purge(key?: string, opts?: CallOptions): Promise<void>;
}
