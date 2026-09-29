---
"files-sdk": patch
---

`files-sdk/api` `purge` with no key (empty the trash) no longer deletes trash entries that an `authorize` `filterKeys` hides when there is no `keyPrefix`. It used to call the plugin's bare `purge()`, emptying the whole trash. Now it purges only the entries the caller can see, as it already did under a `keyPrefix`.
