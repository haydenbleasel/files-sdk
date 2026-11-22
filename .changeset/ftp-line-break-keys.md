---
"files-sdk": patch
---

Reject keys containing a line break in the FTP adapter (`files-sdk/ftp`) with an `Invalid` error before any command is sent. FTP commands are single lines, so a CR or LF in a path can't be sent, and `basic-ftp` handled that badly: before 6.2.3 a ranged `download()` of such a key threw an uncaught exception from inside a socket handler, and newer versions reject with a retryable `Provider` error that still closes an injected client's connection. Every supported `basic-ftp` version now fails the same deterministic way.
