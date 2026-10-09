// `files-sdk/react` — the `useFiles` hook (full Files-API parity over one
// endpoint) plus optional reactive read hooks. Emitted with a `"use client"`
// banner by the build so Next.js RSC treats it as a client module. Hooks only —
// the heavy lifting lives in the framework-agnostic `files-sdk/client`.

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
