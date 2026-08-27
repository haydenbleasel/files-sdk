---
"files-sdk": minor
---

Add provider-native conditional create, replace, exact-read, delete, and copy operations to the existing plugin, hook, retry, prefix, read-only, and receipt pipeline. AWS S3 implements the initial atomic primitives; unsupported adapters, filesystem, custom S3 endpoints, R2, bulk, and multipart paths fail closed.

The S3 adapter exposes the primitives only for canonical AWS — no `endpoint` and no `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL` redirect — with a new `conditional` option to override that in either direction, and verifies per request that the installed `@aws-sdk/client-s3` serialized every predicate header (conditional copy needs 3.919.0+; the `@aws-sdk/client-s3` peer range moves from `^3.700.0` to `^3.1079.0`). The CLI gains `--if-match` / `--if-none-match` / `--dest-if-match` on `upload`, `download`, `delete`, and `copy`, and the MCP tools accept a matching `condition` input. `cache()` now invalidates after a failed write too; `softDelete()` forwards a conditional delete of an already-trashed key; `dedup()` rejects every conditional mode.

A conditional mutation that commits before an awaited plugin rejects the call now surfaces as `FilesError.applied === true` (with `appliedEtag` for uploads) — on the rejected error, in `onError` / `onAction`, and in the `audit()` record — so callers can reconcile instead of retrying a predicate that can only conflict. A plugin that re-invokes `next()` after the native call failed gets that first failure as `cause`. `rejectConditional(op, plugin, reason)` is exported as the one veto shape for plugins with out-of-band side effects. Ordinary operations type `mode` as `undefined` (there never was an `"overwrite"` value to branch on).

