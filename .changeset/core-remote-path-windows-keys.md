---
"files-sdk": patch
---

The `files-sdk/ftp`, `files-sdk/sftp`, and `files-sdk/webdav` adapters now reject keys that contain a backslash or start with a Windows drive letter (`C:`) with an `Invalid` error. Before, a key like `..\..\secret` passed the `..` traversal guard as a single segment, and `C:/Windows/win.ini` resolved to an absolute path, so on servers running on Windows hosts either could reach files outside the configured root.
