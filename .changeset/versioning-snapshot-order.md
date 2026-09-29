---
"files-sdk": patch
---

`versioning()` (`files-sdk/versioning`) now orders versions by when each snapshot was taken, not by the snapshotted object's last-modified time. A native move (fs, memory, FTP, SFTP) carries the source's older time onto the destination, so `restoreVersion()` could undo the wrong change and `limit` could prune the snapshot it had just taken. New version ids are `<taken>-<modified>-<etag>`; ids written by earlier releases still parse and sort before newer ones, and `FileVersion.lastModified` still reports the object's own last-modified time.
