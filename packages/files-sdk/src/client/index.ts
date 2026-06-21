// `files-sdk/client` — the framework-agnostic browser/Node client. All the verb
// logic lives here so it is tested once and reused by `files-sdk/react` (and,
// later, vue/svelte). Importable server-side too (it only references
// `fetch`/`XMLHttpRequest`/`FormData`/`Blob` as globals).

export { createFilesClient } from "./files-client.js";
export type {
  AggregateProgress,
  FileUploadState,
  FileUploadStatus,
} from "./progress.js";
export { aggregate } from "./progress.js";
export type { SendRequest, SendResult, Transport } from "./transport.js";
export type {
  BulkCallOptions,
  CallOptions,
  DownloadCallOptions,
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
} from "./types.js";
