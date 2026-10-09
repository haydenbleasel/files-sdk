// The normalized storage-event shape shared by the core (`FilesPlugin.event`,
// `Files[FOLD_PROVIDER_EVENT]`), the gateway (`onUploadComplete` completions),
// and `files-sdk/events`. Types, one registry symbol, and the gateway's
// feature-detect, so importing it costs a bundle next to nothing — the gateway
// reaches `files-sdk/events` through the instance, never by import.

import type { Files } from "../index.js";
import { isFunction, isObject } from "./is.js";

/** What happened to a key. Providers rarely tell an overwrite from a create, so these two are the honest common subset; a copy or move arrives as `created` (and `deleted`). */
export type FileEventType = "created" | "deleted";

/**
 * Where an event came from: the provider's own notification (`parse()`,
 * `webhook()`, `dispatch()`, the memory adapter), a gateway upload completion,
 * or a write made through this `Files` instance (`events({ sdk: true })`).
 */
export type FileEventSource = "provider" | "gateway" | "sdk";

export interface FileEvent {
  type: FileEventType;
  /** Caller-facing: URL-decoded, the instance `prefix` stripped. */
  key: string;
  size?: number;
  etag?: string;
  versionId?: string;
  /** Only when the delivery carries it (GCS, Azure, the gateway, the SDK). */
  contentType?: string;
  /** When it happened, ms since the epoch (like `lastModified`). */
  time: number;
  source: FileEventSource;
  /** The adapter's `name` (`"s3"`, `"r2-binding"`, `"memory"`, …). */
  provider: string;
  /**
   * The idempotency key. Delivery is at-least-once on every provider, so a
   * handler sees the same event again on a redelivery; this id stays the same.
   * The provider's event id where it has one, else derived from the key and the
   * provider's per-write sequencer, version, or ETag.
   */
  id: string;
  /** The provider's original record, untouched. */
  raw: unknown;
}

/**
 * The `Files` method `files-sdk/events` calls to map a provider event onto an
 * instance: drop it when it falls outside the instance `prefix`, strip the
 * prefix, then fold it through each plugin's `event` hook. A registry symbol so
 * it survives a consumer loading the core and the plugin from different
 * bundles, and stays off the instance's public surface.
 */
export const FOLD_PROVIDER_EVENT: unique symbol = Symbol.for(
  "files-sdk.foldProviderEvent"
);

/** The part of `files.events` the gateway feeds upload completions into. */
export interface EventSink {
  emit: (events: FileEvent | readonly FileEvent[]) => Promise<void>;
}

/** `files.events` when the `files-sdk/events` plugin is installed on `files`. */
export const eventSinkOf = (files: Files): EventSink | undefined => {
  if (!("events" in files)) {
    return undefined;
  }
  const sink = files.events;
  return isObject(sink) && "emit" in sink && isFunction(sink.emit)
    ? {
        // SAFETY: `files.events` is the namespace `files-sdk/events` grafts on;
        // its `emit` has exactly the `EventSink["emit"]` signature.
        emit: sink.emit as EventSink["emit"],
      }
    : undefined;
};

/**
 * A gateway upload completion as a `FileEvent` (`source: "gateway"`). `key` is
 * the key in the `Files` instance (authorize's `keyPrefix` applied), the same
 * namespace provider events land in; `id` derives from the gateway's
 * `uploadId`, so a replayed `complete` carries the same one.
 */
export const gatewayUploadEvent = (
  provider: string,
  upload: {
    key: string;
    size: number;
    contentType: string;
    etag?: string;
    lastModified?: number;
    uploadId: string;
  }
): FileEvent => ({
  contentType: upload.contentType,
  id: `gateway:${upload.uploadId}`,
  key: upload.key,
  provider,
  raw: upload,
  size: upload.size,
  source: "gateway",
  time: upload.lastModified ?? Date.now(),
  type: "created",
  ...(upload.etag !== undefined && { etag: upload.etag }),
});
