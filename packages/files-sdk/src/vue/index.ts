// `files-sdk/vue` — the `useFiles` composable (full Files-API parity over one
// endpoint, returning refs) plus reactive `useList`/`useFile`/`useSearch`. A thin
// reactive wrapper over the framework-agnostic `files-sdk/client`. Uses
// `export *` so the bundled entry's runtime exports stay bound (a pure named
// re-export entry is stripped to a stub by Bun).

// oxlint-disable-next-line sonarjs/no-wildcard-import -- intentional barrel re-export; `export *` keeps the bundled entry's runtime exports bound
export * from "./use-files.js";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- intentional barrel re-export; `export *` keeps the bundled entry's runtime exports bound
export * from "./use-files-query.js";
export type {
  AggregateProgress,
  BulkCallOptions,
  CallOptions,
  DownloadCallOptions,
  FileUploadState,
  FileUploadStatus,
  FilesClient,
  FilesClientConfig,
  ListCallOptions,
  SearchCallOptions,
  SignUploadCallOptions,
  UploadBody,
  UploadCallOptions,
  UploadManyClientItem,
  UploadOutcome,
  UrlCallOptions,
} from "../client/index.js";
