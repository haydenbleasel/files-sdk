import type { AdapterCapabilities, StoredFile } from "files-sdk";
import type { FileVersion, TrashedFile, UseFilesResult } from "files-sdk/react";

/**
 * A no-op, `console.log`-ing stand-in for a `useFiles()` instance, so the docs
 * component previews (`<Component>`) render with realistic data and no live
 * gateway. Reads return a canned sample file tree; mutations just log. This is
 * preview-only — the copyable "Usage" snippet on each component page shows the
 * real `useFiles({ endpoint })` wiring a consumer would actually use.
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

const DAY = 86_400_000;
// A fixed "now" (mid-2026) keeps demo timestamps stable and current-looking.
const NOW = 1_781_000_000_000;

// Sample objects — non-image types so the previews render clean file-type
// icons rather than broken thumbnails (image thumbnails need the gateway).
const SAMPLE: { key: string; size: number; type: string; age: number }[] = [
  {
    age: 6,
    key: "documents/meeting-notes.txt",
    size: 4210,
    type: "text/plain",
  },
  {
    age: 1,
    key: "documents/reports/q4-report.pdf",
    size: 2_411_000,
    type: "application/pdf",
  },
  {
    age: 8,
    key: "documents/reports/annual-2026.pdf",
    size: 3_120_000,
    type: "application/pdf",
  },
  {
    age: 3,
    key: "documents/contracts/invoice-2026-06.pdf",
    size: 184_320,
    type: "application/pdf",
  },
  {
    age: 2,
    key: "videos/product-demo.mp4",
    size: 48_300_000,
    type: "video/mp4",
  },
  { age: 9, key: "videos/onboarding.mp4", size: 31_800_000, type: "video/mp4" },
  { age: 0, key: "README.md", size: 1820, type: "text/markdown" },
  { age: 7, key: "changelog.txt", size: 3140, type: "text/plain" },
];

const storedFile = (
  key: string,
  size = 0,
  type = "application/octet-stream",
  lastModified = NOW
): StoredFile =>
  ({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob([])),
    key,
    lastModified,
    name: key.split("/").at(-1) ?? key,
    size,
    stream: () => new ReadableStream(),
    text: () => Promise.resolve(""),
    type,
  }) as unknown as StoredFile;

const sampleToStored = (s: (typeof SAMPLE)[number]): StoredFile =>
  storedFile(s.key, s.size, s.type, NOW - s.age * DAY);

// Guess a plausible StoredFile for an arbitrary key (head/download of anything).
const inferStored = (key: string): StoredFile => {
  const match = SAMPLE.find((s) => s.key === key);
  return match
    ? sampleToStored(match)
    : storedFile(key, 128_000, "application/octet-stream");
};

interface ListResult {
  items: StoredFile[];
  prefixes?: string[];
}

const list = (opts?: {
  prefix?: string;
  delimiter?: string;
}): Promise<ListResult> => {
  const prefix = opts?.prefix ?? "";
  const delimiter = opts?.delimiter;
  let under = SAMPLE.filter((s) => s.key.startsWith(prefix));
  // Keep demos populated even when an example points at a prefix we don't seed.
  if (under.length === 0) {
    under = SAMPLE;
  }
  if (!delimiter) {
    return Promise.resolve({ items: under.map(sampleToStored) });
  }
  const items: StoredFile[] = [];
  const prefixes = new Set<string>();
  for (const s of under) {
    const rest = s.key.slice(prefix.length);
    const cut = rest.indexOf(delimiter);
    if (cut === -1) {
      items.push(sampleToStored(s));
    } else {
      prefixes.add(prefix + rest.slice(0, cut + 1));
    }
  }
  return Promise.resolve({ items, prefixes: [...prefixes] });
};

const VERSIONS: FileVersion[] = [
  { lastModified: NOW - DAY, size: 4210, versionId: "v3-current" },
  { lastModified: NOW - 4 * DAY, size: 3980, versionId: "v2" },
  { lastModified: NOW - 11 * DAY, size: 2110, versionId: "v1-initial" },
];

const TRASHED = [
  { key: "old/draft-v1.pdf", lastModified: NOW - 2 * DAY, size: 512_000 },
  { key: "tmp/scratch.txt", lastModified: NOW - 5 * DAY, size: 1230 },
  {
    key: "exports/stale-report.csv",
    lastModified: NOW - 8 * DAY,
    size: 88_400,
  },
] as unknown as TrashedFile[];

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
    return Promise.resolve(inferStored(key));
  },
  error: undefined,
  exists: () => Promise.resolve(true),
  head: (key: string) => {
    log("head", key);
    return Promise.resolve(inferStored(key));
  },
  isUploading: false,
  list,
  async *listAll() {
    for (const s of SAMPLE) {
      yield sampleToStored(s);
    }
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
    return Promise.resolve(inferStored(key));
  },
  restoreVersion: (key: string) => {
    log("restoreVersion", key);
    return Promise.resolve(inferStored(key));
  },
  async *search() {
    for (const s of SAMPLE.slice(0, 5)) {
      yield sampleToStored(s);
    }
  },
  signedUploadUrl: (key: string) => {
    log("signedUploadUrl", key);
    return Promise.resolve({ fields: {}, method: "PUT", url: "" });
  },
  trashed: () => Promise.resolve(TRASHED),
  upload: (...args: unknown[]) => {
    log("upload", ...args);
    return Promise.resolve(storedFile("demo/uploaded.txt", 2048, "text/plain"));
  },
  uploads: [],
  url: (key: string) => {
    log("url", key);
    return Promise.resolve(
      `https://demo.files-sdk.dev/${key}?token=demo-signed-url`
    );
  },
  versions: () => Promise.resolve(VERSIONS),
} as unknown as UseFilesResult;
