// The per-hook upload ledger behind `useFiles().uploads` in the React, Vue and
// Svelte bindings. The client reports each file as one `FileUploadState` it
// mutates in place (one object per file for the life of the upload); the
// ledger keys entries by that object's identity, so a file keeps its slot
// across every progress report — from any number of concurrent or sequential
// `upload()` calls, single or bulk — and each report stores a fresh snapshot
// copy, so the frameworks see a new object (React re-renders, Vue/Svelte
// notify) rather than a silently mutated one. Internal: not re-exported from
// `files-sdk/client`.

import type { FileUploadState } from "./progress.js";

/** `true` once an upload reached a terminal status. */
export const isFinishedUpload = (state: FileUploadState): boolean =>
  state.status === "success" ||
  state.status === "error" ||
  state.status === "aborted";

export interface UploadLedger {
  /** Fold a progress report's per-file states in; returns the new entry list. */
  report: (perFile: readonly FileUploadState[]) => FileUploadState[];
  /** Drop finished entries (in-flight ones stay); returns the new entry list. */
  clearFinished: () => FileUploadState[];
}

export const createUploadLedger = (): UploadLedger => {
  // Map insertion order is the display order; `set` on an existing key keeps
  // the entry's position.
  const entries = new Map<FileUploadState, FileUploadState>();
  const list = (): FileUploadState[] => [...entries.values()];
  return {
    clearFinished() {
      for (const [live, snapshot] of entries) {
        if (isFinishedUpload(snapshot)) {
          entries.delete(live);
        }
      }
      return list();
    },
    report(perFile) {
      for (const state of perFile) {
        entries.set(state, { ...state });
      }
      return list();
    },
  };
};
