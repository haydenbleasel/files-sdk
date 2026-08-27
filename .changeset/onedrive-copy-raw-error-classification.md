---
"files-sdk": patch
---

Fix `onedrive()` and `sharepoint()` `copy()` surfacing every failure as a generic `Provider` error (`copy returned 404 without monitor URL`). The Graph client returns raw responses without checking their status, so the adapter now classifies non-2xx copy responses itself: a 404 becomes `NotFound`, 409/412 become `Conflict`, and 401/403 become `Unauthorized`, with the Graph error message preserved, so retry and failover treat them correctly.
