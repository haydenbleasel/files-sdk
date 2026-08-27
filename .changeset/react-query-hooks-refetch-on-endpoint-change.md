---
"files-sdk": patch
---

`useList`, `useFile`, and `useSearch` from `files-sdk/react` now refetch when `endpoint` changes. The hooks rebuilt their client on a new endpoint but only re-ran the query when the call options changed, so switching from `/api/files` to `/api/files?bucket=images` kept showing the previous endpoint's data until a manual `refetch()`. The client is now part of the query's dependencies and is rebound only by `endpoint`; `fetchImpl` is read live on each request like `headers`, so passing it inline does not refetch on every render.
