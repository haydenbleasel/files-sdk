---
"files-sdk": patch
---

`files-sdk/soft-delete` no longer hard-deletes a live file through a trash key that resolves out of the trash. A `delete(".trash/../notes.txt")`, which a filesystem resolves to `notes.txt`, used to be treated as a delete inside the trash and destroyed the live file; it's now trashed like any live key. `purge()` and `restoreTrashed()` refuse a key that resolves out of the trash, such as `../notes.txt`, with an `Invalid` error.
