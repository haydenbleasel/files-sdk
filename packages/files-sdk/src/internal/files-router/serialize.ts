// Shape `FileInfo`s and bulk errors for the wire. A local mapper (not the
// CLI's `fileInfoToJson`) keeps `cli/io.ts`'s `node:fs`/`node:stream` imports
// out of the edge-safe gateway bundle. Keys are unscoped (the authorize prefix
// stripped) so the client sees user-relative keys.

import type { FileInfo } from "../../index.js";
import type { FilesError } from "../errors.js";
import { serializeFilesError } from "../router-core/envelope.js";
import type { WireBulkError, WireFileInfo } from "./protocol.js";

export const fileInfoToWire = (
  file: FileInfo,
  unscope: (key: string) => string
): WireFileInfo => {
  const wire: WireFileInfo = {
    contentType: file.contentType,
    key: unscope(file.key),
    size: file.size,
  };
  if (file.lastModified !== undefined) {
    wire.lastModified = file.lastModified;
  }
  if (file.etag !== undefined) {
    wire.etag = file.etag;
  }
  if (file.metadata !== undefined) {
    wire.metadata = file.metadata;
  }
  return wire;
};

/**
 * A per-key bulk failure for the wire: the key unscoped, and the storage key a
 * provider's message names rewritten to it, so the authorize prefix never
 * reaches the client.
 */
export const bulkErrorToWire = (
  error: FilesError,
  key: string,
  unscope: (key: string) => string
): WireBulkError => {
  const clientKey = unscope(key);
  return {
    error: serializeFilesError(error, new Map([[key, clientKey]])),
    key: clientKey,
  };
};
