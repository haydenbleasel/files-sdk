---
"files-sdk": major
---

`files-sdk/cache` no longer serves one instance's cached entries to another. Entries were keyed by the caller-facing key alone, so two `Files` instances sharing one `store` (for example two tenants with different `prefix`es over the same bucket) read each other's cached `download()` bytes, `url()` links, and `head()` metadata. Store keys now carry the instance `prefix`, and a custom `store` requires a new `namespace` option that names the bucket it caches (`cache({ store, namespace: "uploads-prod" })`); `cache()` throws `Invalid` without one, because the plugin can't tell which bucket an adapter points at. Instances share entries only when they share the store, the namespace, and the `prefix`. Passing the same `cache()` to a second instance with a different adapter or `prefix` now throws `Invalid` at construction instead of silently sharing its entries; create one `cache()` per instance (read-only views from `files.readonly()` keep sharing theirs).
