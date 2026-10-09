import type {
  AdapterCapabilities,
  DeleteManyResult,
  DownloadManyResult,
  ExistsManyResult,
  FileInfo,
  HeadManyResult,
  ListResult,
  StoredFile,
  UploadManyResult,
} from "files-sdk";
import type { NativeFileRef } from "files-sdk/client";
import type {
  FileVersion,
  ListCallOptions,
  TrashedFile,
  UploadBody,
  UploadManyClientItem,
  UploadOutcome,
  UseFilesResult,
} from "files-sdk/react";

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
  conditional: {
    copy: {
      atomicSourceDestination: false,
      destinationCreate: false,
      destinationReplace: false,
      sourceEtag: false,
    },
    create: false,
    delete: false,
    exactRead: false,
    multipart: { create: false, replace: false },
    replace: false,
  },
  delimiter: "any",
  events: false,
  metadata: true,
  publicUrl: false,
  rangeRead: true,
  resumable: true,
  serverSideCopy: true,
  signedUpload: { contentType: true, maxSize: true, supported: true },
  signedUrl: {
    disposition: true,
    expiry: "exact",
    maxExpiresIn: 3600,
    supported: true,
  },
  uploadProgress: true,
};

const DAY = 86_400_000;
// A fixed "now" (mid-2026) keeps demo timestamps stable and current-looking.
const NOW = 1_781_000_000_000;

interface SampleObject {
  key: string;
  size: number;
  type: string;
  /** Days before `NOW` the object was last modified. */
  age: number;
  /** Body served by download(), so text previews have something to show. */
  text?: string;
}

// Sample objects — non-image types so the previews render clean file-type
// icons rather than broken thumbnails (image thumbnails need the gateway).
const SAMPLE: SampleObject[] = [
  {
    age: 6,
    key: "documents/meeting-notes.txt",
    size: 4210,
    text: [
      "Weekly sync — storage migration",
      "",
      "- Move uploads from S3 to R2: swap the adapter, keep the Files calls.",
      "- Thumbnails: signed URLs first, gateway proxy as the fallback.",
      "- Turn on versioning() before the bulk re-encode.",
      "",
      "Next: dry-run the transfer() on staging and compare receipts.",
    ].join("\n"),
    type: "text/plain",
  },
  {
    age: 1,
    key: "documents/reports/q4-report.pdf",
    size: 2_411_000,
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

// What head()/list()/search() return: metadata only, no body accessors.
const sampleToInfo = (s: SampleObject): FileInfo => ({
  contentType: s.type,
  key: s.key,
  lastModified: NOW - s.age * DAY,
  size: s.size,
});

// Guess a plausible sample for an arbitrary key (head/download of anything).
const inferSample = (key: string): SampleObject =>
  SAMPLE.find((s) => s.key === key) ?? {
    age: 0,
    key,
    size: 128_000,
    type: "application/octet-stream",
  };

const inferInfo = (key: string): FileInfo => sampleToInfo(inferSample(key));

// What download() returns: the metadata plus `File`-like body accessors.
const inferStored = (key: string): StoredFile => {
  const sample = inferSample(key);
  const text = sample.text ?? "";
  return {
    ...sampleToInfo(sample),
    arrayBuffer: () => new Blob([text]).arrayBuffer(),
    blob: () => Promise.resolve(new Blob([text], { type: sample.type })),
    name: key,
    stream: () => new Blob([text]).stream(),
    text: () => Promise.resolve(text),
    type: sample.type,
  };
};

const list = (opts?: ListCallOptions): Promise<ListResult> => {
  const prefix = opts?.prefix ?? "";
  const delimiter = opts?.delimiter;
  let under = SAMPLE.filter((s) => s.key.startsWith(prefix));
  // Keep demos populated even when an example points at a prefix we don't seed.
  if (under.length === 0) {
    under = SAMPLE;
  }
  if (!delimiter) {
    return Promise.resolve({ items: under.map(sampleToInfo) });
  }
  const items: FileInfo[] = [];
  const prefixes = new Set<string>();
  for (const s of under) {
    const rest = s.key.slice(prefix.length);
    const cut = rest.indexOf(delimiter);
    if (cut === -1) {
      items.push(sampleToInfo(s));
    } else {
      prefixes.add(prefix + rest.slice(0, cut + 1));
    }
  }
  return Promise.resolve({ items, prefixes: [...prefixes] });
};

// `versions()` returns only snapshots of earlier contents — the current file
// is never one of them — so the newest entry is just the previous version.
const VERSIONS: FileVersion[] = [
  { lastModified: NOW - DAY, size: 4210, versionId: "v3" },
  { lastModified: NOW - 4 * DAY, size: 3980, versionId: "v2" },
  { lastModified: NOW - 11 * DAY, size: 2110, versionId: "v1-initial" },
];

const TRASHED: TrashedFile[] = [
  { key: "old/draft-v1.pdf", lastModified: NOW - 2 * DAY, size: 512_000 },
  { key: "tmp/scratch.txt", lastModified: NOW - 5 * DAY, size: 1230 },
  {
    key: "exports/stale-report.csv",
    lastModified: NOW - 8 * DAY,
    size: 88_400,
  },
];

// The single-key and bulk forms of each verb share one property on
// `UseFilesResult`, so the demo implements both as function overloads — the
// bulk form answers with the matching `*ManyResult` shape.

function upload(file: Blob | NativeFileRef): Promise<UploadOutcome>;
function upload(key: string, body: UploadBody): Promise<UploadOutcome>;
function upload(items: UploadManyClientItem[]): Promise<UploadManyResult>;
function upload(
  target: Blob | NativeFileRef | string | UploadManyClientItem[],
  ...args: unknown[]
): Promise<UploadOutcome | UploadManyResult> {
  log("upload", target, ...args);
  if (Array.isArray(target)) {
    return Promise.resolve({
      results: target.map(({ contentType, key }) => ({
        contentType: contentType ?? "application/octet-stream",
        key,
        size: 0,
      })),
    });
  }
  return Promise.resolve({
    contentType: "text/plain",
    key: "demo/uploaded.txt",
    lastModified: NOW,
    size: 2048,
  });
}

function download(key: string): Promise<StoredFile>;
function download(keys: string[]): Promise<DownloadManyResult>;
function download(
  target: string | string[]
): Promise<StoredFile | DownloadManyResult> {
  log("download", target);
  return Promise.resolve(
    Array.isArray(target)
      ? { results: target.map(inferStored) }
      : inferStored(target)
  );
}

function head(key: string): Promise<FileInfo>;
function head(keys: string[]): Promise<HeadManyResult>;
function head(target: string | string[]): Promise<FileInfo | HeadManyResult> {
  log("head", target);
  return Promise.resolve(
    Array.isArray(target)
      ? { results: target.map(inferInfo) }
      : inferInfo(target)
  );
}

function exists(key: string): Promise<boolean>;
function exists(keys: string[]): Promise<ExistsManyResult>;
function exists(
  target: string | string[]
): Promise<boolean | ExistsManyResult> {
  return Promise.resolve(
    Array.isArray(target) ? { existing: target, missing: [] } : true
  );
}

function remove(key: string): Promise<void>;
function remove(keys: string[]): Promise<DeleteManyResult>;
function remove(target: string | string[]): Promise<void | DeleteManyResult> {
  log("delete", target);
  return Promise.resolve(
    Array.isArray(target) ? { results: target } : undefined
  );
}

export const demoFiles: UseFilesResult = {
  abort: () => log("abort"),
  capabilities: () => Promise.resolve(CAPABILITIES),
  copy: (from: string, to: string) => {
    log("copy", from, to);
    return Promise.resolve();
  },
  delete: remove,
  download,
  error: undefined,
  exists,
  head,
  isUploading: false,
  list,
  async *listAll() {
    for (const s of SAMPLE) {
      yield sampleToInfo(s);
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
    return Promise.resolve(inferInfo(key));
  },
  restoreVersion: (key: string) => {
    log("restoreVersion", key);
    return Promise.resolve(inferInfo(key));
  },
  async *search() {
    for (const s of SAMPLE.slice(0, 5)) {
      yield sampleToInfo(s);
    }
  },
  signedUploadUrl: (key: string) => {
    log("signedUploadUrl", key);
    return Promise.resolve({ fields: {}, method: "PUT", url: "" });
  },
  trashed: () => Promise.resolve(TRASHED),
  upload,
  uploads: [],
  url: (key: string) => {
    log("url", key);
    return Promise.resolve(
      `https://demo.files-sdk.dev/${key}?token=demo-signed-url`
    );
  },
  versions: () => Promise.resolve(VERSIONS),
};
