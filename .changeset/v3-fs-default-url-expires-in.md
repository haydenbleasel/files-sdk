---
"files-sdk": major
---

Remove the `defaultUrlExpiresIn` option from the filesystem adapter (`files-sdk/fs`). It was accepted for backward compatibility and ignored, because `url()` returns a permanent `file://` or `urlBaseUrl` link that can't expire. Delete it from your `fs({ … })` options. The CLI's global `--default-url-expires-in` flag no longer reaches the fs adapter, which never used it.
