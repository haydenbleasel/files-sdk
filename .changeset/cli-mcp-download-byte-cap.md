---
"files-sdk": patch
---

The `files mcp` server's `download` tool now enforces `maxBytes` on the bytes it actually reads, streaming the body and cancelling the transfer as soon as it passes the cap. Previously the cap was checked against `head()` and then the whole body was buffered before a second check, so an object replaced between the two calls (or a backend that misreports its size) could pull an arbitrarily large body into memory. The tool's `size` field now reports the bytes returned.
