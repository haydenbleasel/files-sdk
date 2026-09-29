---
"files-sdk": patch
---

`files-sdk/ftp` now maps connect and login failures like every other error, so a rejected login (530) is `Unauthorized` instead of a retryable `Provider` error that the client kept retrying. A failed connect or login also closes its control socket, which used to leak once per attempt.
