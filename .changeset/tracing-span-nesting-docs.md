---
"files-sdk": patch
---

The `files-sdk/tracing` docs no longer claim that inner plugins' sub-operations become child spans. With `tracing()` first, each span covers the full caller-facing operation including time spent in inner plugins, but their own sub-operations call inward past it and are not traced separately; place `tracing()` last to get one span per provider call.
