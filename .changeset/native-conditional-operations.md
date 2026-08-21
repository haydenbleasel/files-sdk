---
"files-sdk": minor
---

Add provider-native conditional create, replace, exact-read, delete, and copy operations to the existing plugin, hook, retry, prefix, read-only, and receipt pipeline. AWS S3 implements the initial atomic primitives; unsupported adapters, filesystem, custom S3 endpoints, R2, bulk, and multipart paths fail closed.
