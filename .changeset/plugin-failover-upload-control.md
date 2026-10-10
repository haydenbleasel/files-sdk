---
"files-sdk": patch
---

`files-sdk/failover` no longer fails over an upload that carries a resumable `control`. An `UploadControl` drives exactly one upload, so replaying it on a secondary after the primary failed threw `This UploadControl has already driven an upload` and hid the primary's real error. Such uploads now go to the primary only, like stream uploads, and surface its error.
