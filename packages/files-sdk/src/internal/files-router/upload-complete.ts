// The gateway's upload lifecycle hook. `onUploadComplete` runs once per
// verified upload — in `complete` for the keyless presign/proxy flow, and after
// the keyed `PUT ?op=upload` stores the body — so the app can record the upload
// (and hand the client back data) without a second endpoint the client has to
// be trusted to call. A throw rejects the upload: the object is deleted (unless
// `onRejected: "keep"`) and the client gets the error.

import type { Files } from "../../index.js";
import { FilesError } from "../errors.js";
import type { JsonValue } from "../json.js";
import { RouterError, serializeFilesError } from "../router-core/envelope.js";
import type { WireFilesError, WireUploadedFile } from "./protocol.js";

/** How the bytes reached storage: direct to a presigned target, through the gateway's proxy PUT, or a keyed `upload(key, body)`. */
export type UploadVia = "presign" | "proxy" | "keyed";

/** What the hook sees of the landed object — metadata only, the key caller-facing (authorize's `keyPrefix` stripped). */
export interface UploadedFileInfo {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
  lastModified?: number;
  metadata?: Record<string, string>;
}

export interface UploadCompleteContext<TContext = unknown> {
  /** The landed object, as `head()` reports it (keyed uploads: as `upload()` returned it). */
  file: UploadedFileInfo;
  /** The full key in `files` — `file.key` with authorize's `keyPrefix` applied. Use it to read the landed bytes. */
  storageKey: string;
  /** The `Files` instance this request resolved to (the per-request factory's result, if one is configured). */
  files: Files;
  /** The completing request — cookies, headers and session live here. */
  req: Request;
  /** The `context` the `authorize` hook returned for this request, if any. */
  context: TContext | undefined;
  /**
   * Stable per upload: a hash of the upload token for keyless uploads, so a
   * replayed `complete` carries the same id (dedupe on it); a fresh id per
   * keyed request.
   */
  uploadId: string;
  via: UploadVia;
}

/**
 * Runs once per verified upload. The resolved value is JSON-serialized and
 * handed back to the client as the upload result's `data`; throw to reject
 * the upload.
 */
export type OnUploadComplete<TData = unknown, TContext = unknown> = (
  ctx: UploadCompleteContext<TContext>
) => TData | Promise<TData>;

/** What a {@link CompletionStore} remembers for a completed upload — replayed verbatim to a repeated `complete`. */
export interface CompletionRecord {
  file: WireUploadedFile;
}

/**
 * Makes keyless completions single-use. Before `onUploadComplete` runs, the
 * gateway looks the upload's id up; a hit is answered with the recorded result
 * and the hook does not fire again. After the hook resolves, the result is
 * written with a TTL (ms) that lasts until the upload token expires — after
 * that the token itself is refused. A `Map`-backed store works for a single
 * process; back it with Redis/KV/a table across instances.
 *
 * A get-then-set store narrows the replay window to two `complete`s racing
 * each other; make the hook idempotent on `uploadId` (a unique column) where
 * that matters.
 */
export interface CompletionStore {
  get: (
    uploadId: string
  ) => CompletionRecord | undefined | Promise<CompletionRecord | undefined>;
  set: (
    uploadId: string,
    record: CompletionRecord,
    ttl: number
  ) => void | Promise<void>;
}

/**
 * Throw from `onUploadComplete` to refuse an upload with a client-facing
 * reason: the client gets a 422 (`Validation`, reason `rejected`) carrying
 * `message`. Any other throw is reported like an `authorize` failure.
 */
export class UploadRejectedError extends RouterError {
  constructor(message: string) {
    super("Validation", message, "rejected");
    this.name = "UploadRejectedError";
  }
}

/**
 * What the hook returns, as the gateway handles it: a value bound for
 * `JSON.stringify` on the wire.
 */
export type UploadData = JsonValue | undefined;

export interface UploadLifecycle {
  onUploadComplete?: OnUploadComplete<UploadData>;
  /** What to do with the object when the hook (or the complete-time `maxSize` check) rejects it. */
  onRejected: "delete" | "keep";
  completions?: CompletionStore;
  req: Request;
  /** The `context` authorize returned for this request. */
  context: unknown;
}

const encoder = new TextEncoder();

/** A stable, opaque id for an upload token: base64url(SHA-256(token)), 128 bits. */
export const uploadIdFor = async (token: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(token))
  );
  let binary = "";
  for (const byte of digest.subarray(0, 16)) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

/**
 * Delete a rejected object (unless configured to keep it). The rejection is
 * what the client needs to hear, so a removal that fails doesn't replace it;
 * it's reported alongside, as the message suffix this returns ("" when the
 * object is gone or kept).
 */
export const discardRejected = async (
  files: Files,
  lifecycle: UploadLifecycle | undefined,
  storageKey: string,
  signal: AbortSignal
): Promise<string> => {
  if (lifecycle?.onRejected === "keep") {
    return "";
  }
  try {
    await files.delete(storageKey, { signal });
    return "";
  } catch (error) {
    const wrapped = FilesError.wrap(error);
    return wrapped.code === "NotFound"
      ? ""
      : ` (removing it failed: ${wrapped.message})`;
  }
};

/** A hook failure as a per-completion bulk error on the keyless `complete` response. */
export const rejectionToWire = (cause: unknown): WireFilesError => {
  if (cause instanceof RouterError) {
    return {
      aborted: false,
      code: cause.code,
      message: cause.message,
      timedOut: false,
    };
  }
  return serializeFilesError(FilesError.wrap(cause));
};
