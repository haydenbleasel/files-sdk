// The wire contract for the `files-sdk/api` gateway — the single source of
// truth shared (type-only) by the server handler (`internal/files-router/*`,
// `api/`) and the browser client (`client/`). It mirrors the `Files` verb set
// over one HTTP endpoint: JSON verbs round-trip a `{ op, ... }` body; the two
// byte paths (`download`, `upload`/`proxy`) use HTTP-native forms so `<img src>`
// and streaming work. Nothing here imports a runtime value from the SDK, so the
// browser bundle stays free of provider code.

import type {
  AdapterCapabilities,
  SearchMatch,
  SignedUpload,
} from "../../index.js";

/**
 * The coarse, authorize-facing verbs. A bulk wire op (`head-many`) authorizes
 * under its single verb (`head`); the byte paths (`download`, `upload`) keep
 * their own verb so an app can allow reads but deny writes in one predicate.
 */
export type FilesOperation =
  | "head"
  | "exists"
  | "list"
  | "search"
  | "url"
  | "capabilities"
  | "download"
  | "upload"
  | "delete"
  | "copy"
  | "move"
  | "signedUploadUrl"
  // Plugin verbs — only answer when the matching plugin wraps the `Files`
  // instance (`versioning()` / `softDelete()`); deny-by-default like the rest.
  | "versions"
  | "restoreVersion"
  | "trashed"
  | "restoreTrashed"
  | "purge";

/** Every JSON op the gateway dispatches on (POST `{ op, ... }`). */
export type WireOp =
  | "head"
  | "head-many"
  | "exists"
  | "exists-many"
  | "delete"
  | "delete-many"
  | "copy"
  | "move"
  | "url"
  | "list"
  | "search"
  | "capabilities"
  | "signed-upload-url"
  | "presign"
  | "complete"
  | "versions"
  | "restore-version"
  | "trashed"
  | "restore-trashed"
  | "purge";

/** Serialized `StoredFile` metadata — body is never inlined. Matches `storedFileToJson`. */
export interface WireStoredFile {
  key: string;
  name: string;
  size: number;
  type: string;
  lastModified?: number;
  etag?: string;
  metadata?: Record<string, string>;
}

/** A serialized `FilesError` — what `filesErrorReplacer` emits (no `cause`). */
export interface WireFilesError {
  code: string;
  message: string;
  aborted: boolean;
  timedOut: boolean;
}

/** One per-key failure from a bulk op, mirroring `BulkError`. */
export interface WireBulkError {
  key: string;
  error: WireFilesError;
}

// --- JSON requests (POST application/json), discriminated by `op` ---

export type JsonRequest =
  | { op: "head"; key: string }
  | {
      op: "head-many";
      keys: string[];
      concurrency?: number;
      stopOnError?: boolean;
    }
  | { op: "exists"; key: string }
  | {
      op: "exists-many";
      keys: string[];
      concurrency?: number;
      stopOnError?: boolean;
    }
  | { op: "delete"; key: string }
  | {
      op: "delete-many";
      keys: string[];
      concurrency?: number;
      stopOnError?: boolean;
    }
  | { op: "copy"; from: string; to: string }
  | { op: "move"; from: string; to: string }
  | {
      op: "url";
      key: string;
      expiresIn?: number;
      responseContentDisposition?: string;
    }
  | {
      op: "list";
      prefix?: string;
      cursor?: string;
      limit?: number;
      delimiter?: string;
    }
  | {
      op: "search";
      pattern: string;
      isRegex?: boolean;
      flags?: string;
      match?: SearchMatch;
      prefix?: string;
      limit?: number;
      maxResults?: number;
      caseInsensitive?: boolean;
    }
  | { op: "capabilities" }
  | {
      op: "signed-upload-url";
      key: string;
      expiresIn: number;
      contentType?: string;
      maxSize?: number;
      minSize?: number;
    }
  | { op: "presign"; files: ClientFileInfo[]; expiresIn?: number }
  | { op: "complete"; completions: { id: string; key: string }[] }
  | { op: "versions"; key: string }
  | { op: "restore-version"; key: string; versionId?: string }
  | { op: "trashed" }
  | { op: "restore-trashed"; key: string }
  | { op: "purge"; key?: string };

/** Client-reported file info for keyless presign — used for keygen/validation only. */
export interface ClientFileInfo {
  name: string;
  size: number;
  type: string;
}

/** The presign target the client drives — a real `SignedUpload`, or a proxy PUT back at us. */
export type UploadTarget = SignedUpload;

export interface PresignedUpload {
  /** HMAC token binding `{ key, constraints, exp }` — the client echoes it back on `complete`. */
  id: string;
  key: string;
  target: UploadTarget;
}

// --- JSON responses ---

export interface HeadResponse {
  file: WireStoredFile;
}
export interface HeadManyResponse {
  files: WireStoredFile[];
  errors?: WireBulkError[];
}
export interface ExistsResponse {
  exists: boolean;
}
export interface ExistsManyResponse {
  existing: string[];
  missing: string[];
  errors?: WireBulkError[];
}
export interface OkResponse {
  ok: true;
}
export interface DeleteManyResponse {
  deleted: string[];
  errors?: WireBulkError[];
}
export interface UrlResponse {
  url: string;
}
export interface ListResponse {
  items: WireStoredFile[];
  prefixes?: string[];
  cursor?: string;
}
export interface SearchResponse {
  matches: WireStoredFile[];
  truncated: boolean;
}
export interface CapabilitiesResponse {
  capabilities: AdapterCapabilities;
}
export interface SignedUploadUrlResponse {
  signed: SignedUpload;
}
export interface PresignResponse {
  uploads: PresignedUpload[];
}
export interface CompleteResponse {
  files: WireStoredFile[];
  errors?: WireBulkError[];
}

/**
 * A saved version on the wire (from `versioning()`). The internal version
 * storage key is intentionally omitted — the client addresses a version by
 * `versionId` against the original key, never by its `.versions/` path.
 */
export interface WireFileVersion {
  versionId: string;
  size: number;
  lastModified: number;
  etag?: string;
}

/**
 * A trashed object on the wire (from `softDelete()`). Carries the original
 * (unscoped) `key`; the internal `.trash/` storage key is omitted.
 */
export interface WireTrashedFile {
  key: string;
  size: number;
  lastModified?: number;
  etag?: string;
}

export interface VersionsResponse {
  versions: WireFileVersion[];
}
export interface TrashedResponse {
  trashed: WireTrashedFile[];
}

// --- Error envelope (every action, on failure) ---

export type WireErrorCode =
  | "Unauthorized"
  | "Forbidden"
  | "NotFound"
  | "Conflict"
  | "ReadOnly"
  | "Validation"
  | "Provider";

export type WireErrorReason =
  | "type"
  | "size"
  | "key"
  | "count"
  | "origin"
  | "forbidden"
  | "capability"
  | "range";

export interface WireError {
  error: {
    code: WireErrorCode;
    reason?: WireErrorReason;
    message: string;
  };
}

/** The query-string actions for the two byte paths. */
export const DOWNLOAD_ACTION = "download";
export const UPLOAD_ACTION = "upload";
export const PROXY_ACTION = "proxy";

/** Default endpoint the client and demos assume. */
export const DEFAULT_ENDPOINT = "/api/files";
