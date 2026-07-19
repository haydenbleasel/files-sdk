---
"files-sdk": minor
---

React Native / Expo support for `files-sdk/client` and the framework hooks. `upload()` now accepts a `NativeFileRef` (`{ uri, name, type, size }` — the shape Expo pickers return): presigned-POST targets stream the descriptor through React Native's `FormData`, and every other path resolves the `uri` to a Blob automatically. `download()` falls back to buffering via `arrayBuffer()` on runtimes whose `fetch` never exposes `Response.body` (React Native), instead of returning an empty stream. Byte-body uploads fall back to sending raw bytes when the runtime's `Blob` cannot be constructed from `ArrayBuffer` parts. Adds a React Native docs page under UI → Client.
