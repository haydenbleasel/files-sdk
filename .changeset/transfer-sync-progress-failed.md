---
"files-sdk": patch
---

Report failed keys through `onProgress` in `transfer()` and `sync()`, so `done` reaches `total`. Only successful and skipped keys fired a progress event, so a run with any failures never reached the documented denominator and a progress bar stalled short of 100%. A key that fails now fires an event with `status: "failed"` (its error is still in the result's `errors`), and `sync()` does the same for a failed prune. `TransferProgress["status"]` gains `"failed"` alongside `"transferred"` and `"skipped"`, and `SyncProgress["status"]` alongside `"uploaded"`, `"skipped"`, and `"deleted"`; an exhaustive `switch` over the status needs the new case. Under `stopOnError` the run still stops at the first failure, so the keys after it never settle.
