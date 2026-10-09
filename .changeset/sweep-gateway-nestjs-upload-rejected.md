---
"files-sdk": patch
---

An `UploadRejectedError` thrown from `onUploadComplete` under `files-sdk/nestjs` now reaches the client as the documented 422 (`Validation`, reason `rejected`) instead of a 500. The NestJS module builds its router in a separate bundle from `files-sdk/api`, so the error class it checked against was a different copy from the one the app imported; the gateway's router errors now recognize each other across bundle copies, the way `FilesError` already did.
