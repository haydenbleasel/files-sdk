---
"files-sdk": patch
---

`files-sdk/ftp` `delete()` and `delete([...])` no longer report success when the server refuses the delete. They passed basic-ftp's ignore-errors flag, which swallows every FTP error reply, so "550 Permission denied", "450 file busy" and "530 not logged in" all looked like a successful delete. Only a file that is really gone is now a no-op: after a 550 the adapter checks the parent listing, and a file that is still there throws `Unauthorized`; other error replies throw as usual.
