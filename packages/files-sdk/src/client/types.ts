// Public client-facing option/result types for `createFilesClient` and the
// React `useFiles` hook. Where a shape already exists on the SDK (`FileInfo`,
// `StoredFile`, `ListResult`, the bulk result types, `SignedUpload`,
// `AdapterCapabilities`) it is reused verbatim so the browser surface is
// identical to the server SDK.

import type {
  AdapterCapabilities,
  BulkResult,
  ByteRange,
  DeleteManyResult,
  DownloadManyResult,
  ExistsManyResult,
  FileInfo,
  HeadManyResult,
  ListResult,
  SearchMatch,
  SignedUpload,
  StoredFile,
} from "../index.js";
import { isObject, isString } from "../internal/is.js";
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

/**
 * Upload progress callback. Fires on every change to any file's state: once
 * when a file starts (`"uploading"`), on each byte-progress event, and a final
 * time after the file reaches a terminal status — `"success"`, `"error"` (with
 * `state.error` set), or `"aborted"` — on every path, including failures. Each
 * file is one `FileUploadState` object for the whole upload, mutated in place,
 * so `perFile` entries can be tracked by identity.
 */
export type UploadProgressCallback<TData = unknown> = (
  progress: AggregateProgress,
  perFile: readonly FileUploadState<TData>[]
) => void;

export interface UploadCallOptions<TData = unknown> extends CallOptions {
  /**
   * The stored `Content-Type`. On the keyless path it is what `presign` binds
   * (overriding the file's own `type`); on the keyed path it is the PUT header.
   */
  contentType?: string;
  /** Presign expiry for the keyless path, seconds. */
  expiresIn?: number;
  onProgress?: UploadProgressCallback<TData>;
}

export interface BulkCallOptions extends CallOptions {
  concurrency?: number;
  stopOnError?: boolean;
}

export interface UploadManyCallOptions<
  TData = unknown,
> extends BulkCallOptions {
  /**
   * Progress across the batch: `perFile` holds one state per item, in `items`
   * order. Items still `"pending"` when a `stopOnError` failure ends the batch
   * are reported `"aborted"`.
   */
  onProgress?: UploadProgressCallback<TData>;
}

/**
 * What a client upload resolves to: the stored object's {@link FileInfo}, as on
 * the server, plus `data` — what the gateway's `onUploadComplete` returned for
 * it, if it returned anything.
 */
export type UploadOutcome<TData = unknown> = FileInfo & { data?: TData };

/** A bulk `upload([...])` result: one {@link UploadOutcome} per stored item. */
export type UploadManyClientResult<TData = unknown> = BulkResult<
  UploadOutcome<TData>
>;

/**
 * A React Native file reference — the `{ uri, name, type }` shape Expo's
 * pickers return and React Native's `FormData` streams from disk. Pass one
 * anywhere an upload body goes; on a presigned-POST target it rides the form
 * untouched (native streaming), on every other path the client resolves the
 * `uri` to a Blob first. Only meaningful in React Native — on the web, pass a
 * `Blob`/`File` instead.
 */
export interface NativeFileRef {
  uri: string;
  name?: string;
  type?: string;
  /** Bytes, when the picker reports it; informs presign info and progress totals. */
  size?: number;
}

export const isNativeFileRef = (body: unknown): body is NativeFileRef =>
  isObject(body) &&
  !(body instanceof Blob) &&
  "uri" in body &&
  isString(body.uri);

export type UploadBody =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | string
  | NativeFileRef;

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

/**
 * `TData` types the `data` each upload carries back from the gateway's
 * `onUploadComplete` — pass `InferUploadData<typeof router>` (from
 * `files-sdk/api`, a type-only import) to share it with the server.
 */
export interface FilesClient<TData = unknown> {
  upload: {
    (
      file: Blob | NativeFileRef,
      opts?: UploadCallOptions<TData>
    ): Promise<UploadOutcome<TData>>;
    (
      key: string,
      body: UploadBody,
      opts?: UploadCallOptions<TData>
    ): Promise<UploadOutcome<TData>>;
    (
      items: UploadManyClientItem[],
      opts?: UploadManyCallOptions<TData>
    ): Promise<UploadManyClientResult<TData>>;
  };

  download: {
    (key: string, opts?: DownloadCallOptions): Promise<StoredFile>;
    (
      keys: string[],
      opts?: BulkCallOptions & { as?: "blob" | "stream" }
    ): Promise<DownloadManyResult>;
  };

  head: {
    (key: string, opts?: CallOptions): Promise<FileInfo>;
    (keys: string[], opts?: BulkCallOptions): Promise<HeadManyResult>;
  };

  exists: {
    (key: string, opts?: CallOptions): Promise<boolean>;
    (keys: string[], opts?: BulkCallOptions): Promise<ExistsManyResult>;
  };

  delete: {
    (key: string, opts?: CallOptions): Promise<void>;
    (keys: string[], opts?: BulkCallOptions): Promise<DeleteManyResult>;
  };

  copy: (from: string, to: string, opts?: CallOptions) => Promise<void>;
  move: (from: string, to: string, opts?: CallOptions) => Promise<void>;
  url: (key: string, opts?: UrlCallOptions) => Promise<string>;
  signedUploadUrl: (
    key: string,
    opts: SignUploadCallOptions
  ) => Promise<SignedUpload>;
  list: (opts?: ListCallOptions) => Promise<ListResult>;
  listAll: (opts?: ListCallOptions) => AsyncGenerator<FileInfo, void>;
  search: (
    pattern: string | RegExp,
    opts?: SearchCallOptions
  ) => AsyncGenerator<FileInfo, void>;
  capabilities: (opts?: CallOptions) => Promise<AdapterCapabilities>;

  // Plugin verbs — resolve only when the server gateway exposes the matching
  // plugin (`versioning()` / `softDelete()`); otherwise they reject with a
  // gateway error. See the relevant plugin docs.
  versions: (key: string, opts?: CallOptions) => Promise<FileVersion[]>;
  restoreVersion: (
    key: string,
    versionId?: string,
    opts?: CallOptions
  ) => Promise<FileInfo>;
  trashed: (opts?: CallOptions) => Promise<TrashedFile[]>;
  restoreTrashed: (key: string, opts?: CallOptions) => Promise<FileInfo>;
  purge: (key?: string, opts?: CallOptions) => Promise<void>;
}
