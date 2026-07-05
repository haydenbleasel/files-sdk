import type { AdapterCapabilities, StoredFile } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";

/**
 * A no-op, `console.log`-ing stand-in for a `useFiles()` instance, so the docs
 * component previews (`<Component>`) render without a live gateway. Reads return
 * empty/canned data; mutations just log. This is preview-only — the copyable
 * "Usage" snippet on each component page shows the real `useFiles({ endpoint })`
 * wiring a consumer would actually use.
 */

const log = (op: string, ...args: unknown[]): void => {
  console.log(`[files-sdk demo] ${op}`, ...args);
};

const CAPABILITIES: AdapterCapabilities = {
  cacheControl: true,
  delimiter: true,
  metadata: true,
  multipart: true,
  rangeRead: true,
  serverSideCopy: true,
  signedUrl: { maxExpiresIn: 3600, supported: true },
  uploadProgress: true,
};

const storedFile = (key: string): StoredFile =>
  ({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob([])),
    key,
    name: key.split("/").at(-1) ?? key,
    size: 0,
    stream: () => new ReadableStream(),
    text: () => Promise.resolve(""),
    type: "application/octet-stream",
  }) as unknown as StoredFile;

export const demoFiles = {
  abort: () => log("abort"),
  capabilities: () => Promise.resolve(CAPABILITIES),
  copy: (from: string, to: string) => {
    log("copy", from, to);
    return Promise.resolve();
  },
  delete: (key: unknown) => {
    log("delete", key);
    return Promise.resolve();
  },
  download: (key: string) => {
    log("download", key);
    return Promise.resolve(storedFile(key));
  },
  error: undefined,
  exists: () => Promise.resolve(false),
  head: (key: string) => {
    log("head", key);
    return Promise.resolve(storedFile(key));
  },
  isUploading: false,
  list: () => Promise.resolve({ items: [] }),
  async *listAll() {
    yield* [];
  },
  move: (from: string, to: string) => {
    log("move", from, to);
    return Promise.resolve();
  },
  progress: { fraction: 0, loaded: 0, total: 0 },
  purge: (key?: string) => {
    log("purge", key);
    return Promise.resolve();
  },
  reset: () => log("reset"),
  restoreTrashed: (key: string) => {
    log("restoreTrashed", key);
    return Promise.resolve(storedFile(key));
  },
  restoreVersion: (key: string) => {
    log("restoreVersion", key);
    return Promise.resolve(storedFile(key));
  },
  async *search() {
    yield* [];
  },
  signedUploadUrl: (key: string) => {
    log("signedUploadUrl", key);
    return Promise.resolve({ fields: {}, method: "PUT", url: "" });
  },
  trashed: () => Promise.resolve([]),
  upload: (...args: unknown[]) => {
    log("upload", ...args);
    return Promise.resolve(storedFile("demo/uploaded"));
  },
  uploads: [],
  url: (key: string) => {
    log("url", key);
    return Promise.resolve("");
  },
  versions: () => Promise.resolve([]),
} as unknown as UseFilesResult;
