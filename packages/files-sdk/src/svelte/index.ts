// `files-sdk/svelte` — the `useFiles` binding (full Files-API parity over one
// endpoint, returning Svelte stores) plus `useList`/`useFile`/`useSearch` query
// stores. Store-based (not runes), with no Svelte runtime import — Bun's bundler
// can't compile runes, and the store contract needs only a type-only `Readable`.
// Uses `export *` so the bundled entry's runtime exports stay bound.

// oxlint-disable-next-line sonarjs/no-wildcard-import -- intentional barrel re-export; `export *` keeps the bundled entry's runtime exports bound
export * from "./use-files.js";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- intentional barrel re-export; `export *` keeps the bundled entry's runtime exports bound
export * from "./use-files-query.js";
export type {
  InferUploadData,
  AggregateProgress,
  BulkCallOptions,
  CallOptions,
  DownloadCallOptions,
  FilesClient,
  FilesClientConfig,
  FileUploadState,
  FileUploadStatus,
  FileVersion,
  ListCallOptions,
  NativeFileRef,
  SearchCallOptions,
  SearchSummary,
  SignUploadCallOptions,
  TrashedFile,
  UploadBody,
  UploadCallOptions,
  UploadManyCallOptions,
  UploadManyClientItem,
  UploadManyClientResult,
  UploadOutcome,
  UploadProgressCallback,
  UrlCallOptions,
} from "../client/index.js";
