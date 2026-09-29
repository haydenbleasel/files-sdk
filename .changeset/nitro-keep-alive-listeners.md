---
"files-sdk": patch
---

`files-sdk/nitro` no longer adds a socket `close` listener per request that is never removed. On a keep-alive connection they piled up until Node printed `MaxListenersExceededWarning`. The listener is now removed once the response finishes.
