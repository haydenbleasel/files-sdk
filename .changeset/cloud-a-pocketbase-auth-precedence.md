---
"files-sdk": patch
---

`files-sdk/pocketbase` now prefers `adminEmail` / `adminPassword` passed as options over a `POCKETBASE_AUTH_TOKEN` environment variable. The env token was checked first, so a stale token left in the environment overrode valid credentials passed in code. The order is now the `authToken` option, admin credentials from options, `POCKETBASE_AUTH_TOKEN`, then `POCKETBASE_ADMIN_EMAIL` / `POCKETBASE_ADMIN_PASSWORD`.
