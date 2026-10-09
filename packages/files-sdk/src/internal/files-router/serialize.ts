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

export const bulkErrorToWire = (
  error: FilesError,
  key: string,
  unscope: (key: string) => string
): WireBulkError => ({
  error: serializeFilesError(error),
  key: unscope(key),
});
