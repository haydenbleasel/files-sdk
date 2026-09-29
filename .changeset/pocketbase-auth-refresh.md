---
"files-sdk": patch
---

`files-sdk/pocketbase` now logs in again once the superuser token from `adminEmail`/`adminPassword` expires. The first login's promise was kept forever, so after expiry every call ran unauthenticated.
