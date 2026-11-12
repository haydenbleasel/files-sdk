---
"files-sdk": patch
---

Stop a native bulk delete in the adapter once the constructor `signal` or `timeout` cuts its slice off. Each slice's `deleteMany` call now gets that slice's abort signal (the new `AdapterDeleteManyOptions.signal`, which a `signal` in the caller's bulk options never overrides). FTP and SFTP (`files-sdk/ftp`, `files-sdk/sftp`) stop before their next key, Azure (`files-sdk/azure`) cancels its batch request in flight and sends no further batch, and S3 and the S3-compatible adapters on the `aws-sdk` client cancel their `DeleteObjects` request in flight, instead of deleting the rest of the slice after the call has reported those keys in `errors`. A request the provider already received may still be carried out.

A native bulk delete whose first slice is aborted or times out, including under a constructor `signal` that had already aborted, rejects again, as it did before 3.1.3 and as a first slice that fails outright does, instead of resolving with every key in `errors`.
