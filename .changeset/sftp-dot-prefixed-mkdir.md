---
"files-sdk": patch
---

The SFTP adapter now uploads into dot-prefixed directories such as `.well-known/acme-challenge/token` correctly. ssh2-sftp-client treats any relative path starting with `.` as if it began with `./` and strips two characters, so with the default root the adapter created `ell-known/acme-challenge` and the following write failed with a bogus `NotFound`. Relative parent directories are now passed with an explicit `./` anchor; absolute and already-anchored paths are unchanged.
