---
"files-sdk": patch
---

`files-sdk/api` proxied downloads now honour `If-Range`. A resumed download whose validator (entity tag or date) no longer matches the object gets the whole new object with a `200`. Before, it got a `206` slice of the changed object that the client spliced onto the old bytes. Weak entity tags never satisfy `If-Range`.
