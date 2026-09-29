---
"files-sdk": patch
---

The `files-sdk/encryption` JSDoc now says to place `failover()` and `tiering()` after `encryption()`, and that only the body is encrypted. It previously said to put encryption last in the plugin array, which, combined with either of those plugins, stores whatever they route to a secondary or cold backend unencrypted; and its threat model didn't mention that the key, `contentType`, and user `metadata` are stored as-is.
