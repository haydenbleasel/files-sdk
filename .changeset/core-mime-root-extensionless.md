---
"files-sdk": patch
---

Content types the SDK infers from a key's extension (S3-family `list()` items, FTP, SFTP, WebDAV, Dropbox, Box, `files-sdk/content-type`, `files-sdk/validation`, `files-sdk/zip`'s `unzip()`, and the CLI) now fall back to `application/octet-stream` for a root-level key with no extension or a root dotfile. Previously a bare key named after an extension, such as `json` or `html`, or a dotfile such as `.html`, was typed as `application/json` or `text/html`, while the same name inside a folder was not.
