---
"files-sdk": patch
---

Proxied downloads from the `files-sdk/api` gateway now name the file in their default `Content-Disposition`, as `attachment; filename="report.pdf"` (with an RFC 6266 `filename*` for a non-ASCII name), taken from the key's last segment. Before, the bare `attachment` made a browser save a download opened directly from its URL as `files`. A disposition returned by `authorize` is still sent exactly as given.
