---
"files-sdk": patch
---

`files-sdk/r2`: errors from the Workers binding are now classified from the R2 code at the end of the error message (`"get: The requested range is not satisfiable (10039)"`), which is where workerd reports it, not only from a `code` property. A `range` past the end of an object is a permanent `Provider` error that `retries` no longer reissues, and a precondition, access, or missing-bucket failure maps to `Conflict`, `Unauthorized`, or `NotFound` instead of a retried `Provider` error.
