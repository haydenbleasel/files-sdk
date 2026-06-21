// Shape `StoredFile`s and bulk errors for the wire. A local 7-field mapper (not
// the CLI's `storedFileToJson`) keeps `cli/io.ts`'s `node:fs`/`node:stream`
// imports out of the edge-safe gateway bundle. Keys are unscoped (the authorize
// prefix stripped) so the client sees user-relative keys.

import type { StoredFile } from "../../index.js";
import type { FilesError } from "../errors.js";
import { serializeFilesError } from "../router-core/envelope.js";
import type { WireBulkError, WireStoredFile } from "./protocol.js";

export const storedFileToWire = (
  file: StoredFile,
  unscope: (key: string) => string
): WireStoredFile => {
  const key = unscope(file.key);
  const wire: WireStoredFile = {
    key,
    name: key,
    size: file.size,
    type: file.type,
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
