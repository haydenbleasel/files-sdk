---
"files-sdk": patch
---

The filesystem and in-memory adapters (`files-sdk/fs`, `files-sdk/memory`) now honor an upload's `signal` and `timeout`. An aborted or timed-out upload rejected, but the adapter kept reading a stream body to its end and then stored the object anyway; the body is now cancelled and nothing is written.
