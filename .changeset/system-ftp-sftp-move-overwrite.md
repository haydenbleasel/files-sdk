---
"files-sdk": patch
---

`files-sdk/ftp` and `files-sdk/sftp` `move()` now overwrite an existing destination like every other adapter. A plain rename failed whenever the destination existed: OpenSSH and most SFTP servers answered with a generic failure that was retried and then thrown as `Provider`, and FTP servers that refuse to rename over a file, such as IIS, reported a misleading `NotFound`. When the server refuses, the destination is now deleted and the rename retried (so the key is briefly absent), except for a case-only rename, which could otherwise delete the source on a case-insensitive server.
