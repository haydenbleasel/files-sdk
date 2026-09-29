---
"files-sdk": patch
---

`files-sdk/api` docs fixes. `defaultExpiresIn` is documented as what it is: the expiry used when the client doesn't ask for one. It was described as a ceiling, but a client can request a longer `expiresIn`, so cap that with `authorize`'s `maxExpiresIn`, which is now documented to cover upload URLs too. A stale module comment that said only the Next.js binding existed now lists every framework binding.
