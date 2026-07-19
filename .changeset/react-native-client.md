---
"files-sdk": minor
---

React Native / Expo compatibility for `files-sdk/client` and the framework hooks. `download()` now falls back to buffering via `arrayBuffer()` on runtimes whose `fetch` never exposes `Response.body` (React Native), instead of returning an empty stream. Byte-body uploads fall back to sending raw bytes when the runtime's `Blob` cannot be constructed from `ArrayBuffer` parts, and the transports accept them directly. Adds a React Native docs page under UI → Client.
