// Per-file + aggregate upload progress, the contract the React hook's ambient
// `uploads`/`progress` exposes. `progress` is 0–1 per file; the aggregate is a
// straight byte-sum reduce so a multi-file upload reports one bar.

import type { FilesError } from "../internal/errors.js";

export type FileUploadStatus =
  | "pending"
  | "uploading"
  | "success"
  | "error"
  | "aborted";

/**
 * The body a `FileUploadState` tracks. `Uint8Array` appears only on runtimes
 * whose `Blob` cannot wrap raw bytes (React Native).
 */
export type UploadStateBody = Blob | Uint8Array;

export interface FileUploadState {
  file: UploadStateBody;
  name: string;
  size: number;
  type: string;
  key?: string;
  status: FileUploadStatus;
  loaded: number;
  total: number;
  /** 0–1. */
  progress: number;
  error?: FilesError;
}

export interface AggregateProgress {
  loaded: number;
  total: number;
  /** 0–1 across all files. */
  fraction: number;
}

export const aggregate = (
  states: readonly FileUploadState[]
): AggregateProgress => {
  let loaded = 0;
  let total = 0;
  for (const state of states) {
    loaded += state.loaded;
    total += state.total;
  }
  return { fraction: total === 0 ? 0 : loaded / total, loaded, total };
};

export const fileName = (file: UploadStateBody): string =>
  file instanceof File ? file.name : "blob";

export const initialState = (file: UploadStateBody): FileUploadState => {
  const size = file instanceof Blob ? file.size : file.byteLength;
  return {
    file,
    loaded: 0,
    name: fileName(file),
    progress: 0,
    size,
    status: "pending",
    total: size,
    type: (file instanceof Blob && file.type) || "application/octet-stream",
  };
};
