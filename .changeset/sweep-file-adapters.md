---
"files-sdk": patch
---

File and drive adapter fixes:

- `fs`: `publicUrl` is declared only with `urlBaseUrl`, so the gateway no longer redirects to `file://` paths. Directories are no longer objects: `head`, `exists`, `download`, `copy`, and `move` report `NotFound`, `delete` is a no-op, and writing over one is a `Conflict`.
- WebDAV, Dropbox, OneDrive, and SharePoint no longer delete or copy whole folders: a folder key is a no-op for `delete` and `NotFound` as a copy source. Dropbox and OneDrive refuse empty, `/`, and trailing-slash keys.
- Dropbox, Box, OneDrive, and SharePoint `copy` and `move` now overwrite an existing file, like the other adapters. OneDrive copy failures are classified by Graph error code, and a copy timeout is no longer retried.
- Box recovers when a key is deleted and re-created elsewhere.
- Out-of-order resumable calls on Dropbox and OneDrive are `Invalid`.
- `memory` refuses `url({ expiresIn })` when called directly.
