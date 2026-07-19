// Per-file + aggregate upload progress, the contract the React hook's ambient
// `uploads`/`progress` exposes. `progress` is 0–1 per file; the aggregate is a
// straight byte-sum reduce so a multi-file upload reports one bar.

import type { FilesError } from "../internal/errors.js";
import type { NativeFileRef } from "./types.js";
import { isNativeFileRef } from "./types.js";

export type FileUploadStatus =
  | "pending"
  | "uploading"
  | "success"
  | "error"
  | "aborted";

/**
 * The body a `FileUploadState` tracks. `Uint8Array` and `NativeFileRef`
 * appear only in React Native — the former on runtimes whose `Blob` cannot
 * wrap raw bytes, the latter for picker-asset uploads.
 */
export type UploadStateBody = Blob | Uint8Array | NativeFileRef;

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

const refName = (ref: NativeFileRef): string => {
  if (ref.name) {
    return ref.name;
  }
  const base = ref.uri.split("?")[0]?.split("/").pop();
  return base || "blob";
};

export const fileName = (file: UploadStateBody): string => {
  if (file instanceof File) {
    return file.name;
  }
  return isNativeFileRef(file) ? refName(file) : "blob";
};

const sizeAndType = (file: UploadStateBody): { size: number; type: string } => {
  if (file instanceof Blob) {
    return { size: file.size, type: file.type };
  }
  if (isNativeFileRef(file)) {
    return { size: file.size ?? 0, type: file.type ?? "" };
  }
  return { size: file.byteLength, type: "" };
};

export const initialState = (file: UploadStateBody): FileUploadState => {
  const { size, type } = sizeAndType(file);
  return {
    file,
    loaded: 0,
    name: fileName(file),
    progress: 0,
    size,
    status: "pending",
    total: size,
    type: type || "application/octet-stream",
  };
};
