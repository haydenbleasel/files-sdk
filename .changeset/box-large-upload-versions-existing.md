---
"files-sdk": patch
---

Re-uploading a key larger than 50 MB to Box now creates a new version of the existing file instead of failing with `Conflict` (`item_name_in_use`). The Box SDK's `uploadBigFile` helper always opens a new-file upload session, so the adapter now opens an existing-file session for the resolved file ID and drives the same part-upload and commit loop itself.
