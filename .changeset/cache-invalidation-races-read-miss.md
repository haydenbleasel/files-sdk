---
"files-sdk": patch
---

`files-sdk/cache` no longer lets a read that was already in flight re-populate an entry after `invalidateCache()` or a provider storage event dropped it. A slow `head()`, `url()`, or `download()` that fetched before the out-of-band change used to cache its stale answer once it returned, serving it for the full `ttl` despite the invalidation; it now returns what it fetched without caching it, as a read that overlaps a write through the instance already did.
