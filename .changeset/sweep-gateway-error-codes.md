---
"files-sdk": patch
---

The `files-sdk/api` gateway now reports three failures under the right code. An upload that `complete` finds larger than `maxUploadSize` is a `Validation` error with reason `size`, not `Provider` (bulk error entries on the wire now carry an optional `reason`). A plugin verb (`versions`, `trashed`, …) on a gateway whose `Files` lacks the plugin is `Unsupported` with reason `capability`, not `Validation`. A proxied download with an unsatisfiable `Range` still answers 416, but now with an error body (`Validation`, reason `range`), and `files-sdk/client` reports any 416, from the gateway or from storage, as `Invalid` instead of `Provider` "gateway responded 416".
