---
"files-sdk": patch
---

Bound native bulk deletes by the constructor `signal` and `timeout` slice by slice. With either set, `delete([...])` on an adapter with a native bulk primitive (S3 and the S3-compatible adapters on the `aws-sdk` client, Azure, Supabase, UploadThing, FTP, SFTP, the R2 Workers binding) now goes out in slices of up to 1000 keys, one at a time, each under its own timeout, instead of running the whole batch under one timeout.

A slice the signal or timeout cuts off ends the delete: its keys and those of the slices not yet sent are reported in `errors` instead of rejecting the whole call, and the keys earlier slices deleted stay in `results`. No further slice reaches the adapter, so a cut-off slice that is still running never overlaps the next. A slice that fails outright after the first reports only its own keys, and the next slice still goes out. A first slice that fails outright still rejects the call, as before.
