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

export interface FileUploadState {
  file: Blob;
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

export const fileName = (file: Blob): string =>
  file instanceof File ? file.name : "blob";

export const initialState = (file: Blob): FileUploadState => ({
  file,
  loaded: 0,
  name: fileName(file),
  progress: 0,
  size: file.size,
  status: "pending",
  total: file.size,
  type: file.type || "application/octet-stream",
});
