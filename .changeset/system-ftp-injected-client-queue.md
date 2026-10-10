---
"files-sdk": patch
---

`files-sdk/ftp` now runs calls on an injected `client` one at a time. An FTP connection can only run one command at a time, and `basic-ftp` closes the whole connection when a second command starts, so concurrent calls on a shared client (`Promise.all`, or the bulk forms of `upload`, `download`, and `head`) used to fail and leave the client closed for good. Calls now queue on the client, a failed call no longer blocks the ones behind it, and a streamed download holds the client until the stream is read to the end or cancelled.
