---
"files-sdk": patch
---

Fixed `failover()` secondaries and the `tiering()` cold tier ignoring the instance's constructor-level `timeout`, `retries`, and `signal`. The internal `Files` each plugin builds around its extra adapter was created without those defaults, so after the primary timed out and the chain failed over, a hung secondary (or a hung cold backend) stalled the operation forever instead of timing out. Those internal instances now inherit the outer instance's defaults, and `Files` exposes them through a new read-only `defaults` getter for plugins that need to do the same.
