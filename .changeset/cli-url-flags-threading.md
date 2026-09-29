---
"files-sdk": patch
---

The `files` CLI now passes `--public-base-url` to the `box`, `dropbox`, and `bunny-storage` providers, and `--default-url-expires-in` to `box`, `dropbox`, `uploadthing`, and `vercel-blob`. Previously these providers silently ignored the flags, so `url()` kept the adapter's default expiry and Bunny Storage's `url()` failed for want of an origin even when `--public-base-url` was given. The `--region`, `--endpoint`, and `--public-base-url` help text now names the providers that actually read each flag.
