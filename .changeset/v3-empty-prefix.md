---
"files-sdk": minor
---

An empty `prefix` (`""`) or an all-slash one (`"/"`) passed to `new Files({ prefix })` now means no prefix, the same as leaving the option out, instead of throwing "prefix must be a non-empty string". This keeps `prefix: process.env.FILES_PREFIX ?? ""` working when the variable is unset.
