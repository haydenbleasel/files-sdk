---
"files-sdk": minor
---

Add provider-native conditional create, replace, exact-read, delete, and copy operations to the existing plugin, hook, retry, prefix, read-only, and receipt pipeline. AWS S3 implements the initial atomic primitives; unsupported adapters, filesystem, custom S3 endpoints, R2, bulk, and multipart paths fail closed.

The S3 adapter exposes the primitives only for canonical AWS — no `endpoint` and no `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL` redirect — with a new `conditional` option to override that in either direction, and verifies per request that the installed `@aws-sdk/client-s3` serialized every predicate header (conditional copy needs 3.980.0+). The CLI gains `--if-match` / `--if-none-match` / `--dest-if-match` on `upload`, `download`, `delete`, and `copy`, and the MCP tools accept a matching `condition` input. `cache()` now invalidates after a failed write too; `softDelete()` forwards a conditional delete of an already-trashed key; `dedup()` rejects every conditional mode.
