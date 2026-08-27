---
"files-sdk": patch
---

Fixed the CLI's `--application-key-id` and `--application-key` flags being ignored for `--provider backblaze-b2`, which made the documented invocation fail with "missing credentials". The B2 provider now also lists `--region` as required (the adapter has no environment fallback for it), and the provider catalog's `backblaze-b2` entry lists `region` in its required config.
