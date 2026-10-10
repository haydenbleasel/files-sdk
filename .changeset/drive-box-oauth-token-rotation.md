---
"files-sdk": patch
---

`files-sdk/box` OAuth auth now survives Box's single-use refresh tokens. Before, the rotated refresh token lived only in the instance's memory, so after a restart or in a second instance the configured token was already spent and every call failed with `Unauthorized`. A new `oauth.tokenStorage` option persists the rotated tokens (the configured `refreshToken` becomes the first-run seed), and concurrent refreshes now share one exchange instead of spending the same token several times.
