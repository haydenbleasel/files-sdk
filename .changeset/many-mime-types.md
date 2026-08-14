---
"files-sdk": patch
---

Content-type inference from file names (Dropbox, FTP, SFTP, WebDAV, Box, unzip, CLI directory uploads) now uses the `mime` package's full table instead of a hand-rolled 19-extension map. Extensions like `.docx`, `.avif`, `.woff2`, and `.md` resolve to their real types instead of `application/octet-stream`. Conventions are unchanged: text types carry `; charset=utf-8`, and unknown or extension-less names still fall back to octet-stream. The Box adapter's duplicate copy of the old map now shares the same helper.
