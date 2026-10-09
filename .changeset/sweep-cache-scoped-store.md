---
"files-sdk": major
---

`files-sdk/cache` no longer shares entries between instances. Store keys now include the instance `prefix`, and a custom `store` requires a `namespace` naming the bucket it caches (`cache({ store, namespace: "uploads-prod" })`); without one, `cache()` throws `Invalid`. Reusing one `cache()` on an instance with a different adapter or `prefix` also throws `Invalid`, so create one per instance. Before, two tenants sharing a store could read each other's cached bytes, URLs, and metadata.
