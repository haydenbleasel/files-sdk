---
"files-sdk": patch
---

`copy()` and `move()` on the OneDrive adapter (`files-sdk/onedrive`) and the SharePoint adapter (`files-sdk/sharepoint`) now overwrite an existing destination file, as they do on S3 and the other adapters. The Graph copy is now sent with `@microsoft.graph.conflictBehavior=replace`. OneDrive personal ignores that parameter, so when Graph still reports a name clash, the adapter deletes the destination file (to the recycle bin) and copies again. A folder at the destination, or the source item itself under a different casing, fails with `Conflict`. When the async copy monitor reports a failure, the error is now classified by its Graph error code (`nameAlreadyExists` maps to `Conflict`, `accessDenied` to `Unauthorized`, …) instead of always being a retryable `Provider` error. A copy that is still running when `copyTimeoutMs` runs out now throws a permanent `Provider` error, so `retries` no longer starts a second Graph copy while the first one may still finish.
