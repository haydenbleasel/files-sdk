// A tiny external store for the hook's ambient upload state (in-flight count,
// per-file states, last error). `useSyncExternalStore` subscribes to it —
// tear-free and SSR-safe. State is replaced (never mutated) so snapshots stay
// referentially stable between changes.

import type { FileUploadState } from "../client/index.js";
import type { FilesError } from "../internal/errors.js";

export interface FilesStoreState {
  uploads: FileUploadState[];
  inFlight: number;
  error?: FilesError;
}

export const INITIAL_STATE: FilesStoreState = { inFlight: 0, uploads: [] };

export interface FilesStore {
  getState(): FilesStoreState;
  subscribe(listener: () => void): () => void;
  patch(next: Partial<FilesStoreState>): void;
  setUploads(uploads: FileUploadState[]): void;
  reset(): void;
}

export const createStore = (): FilesStore => {
  let state: FilesStoreState = INITIAL_STATE;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    getState: () => state,
    patch(next) {
      state = { ...state, ...next };
      emit();
    },
    reset() {
      state = INITIAL_STATE;
      emit();
    },
    setUploads(uploads) {
      state = { ...state, uploads };
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
