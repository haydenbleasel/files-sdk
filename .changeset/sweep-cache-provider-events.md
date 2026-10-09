---
"files-sdk": patch
---

`files-sdk/cache` now invalidates on provider storage events. When the instance has `files-sdk/events` wired to a feed, a `created` or `deleted` event for a key (an upload through a presigned URL, a write by another process) drops that key's cached `head()`, `url()`, and `download()` entries, so the next read re-fetches instead of serving stale data. The event is passed on unchanged. With an async store the drop settles just after the event is delivered, and a store failure there is ignored.
