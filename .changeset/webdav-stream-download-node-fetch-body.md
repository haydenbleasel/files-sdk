---
"files-sdk": patch
---

Fix `webdav()` streaming downloads failing with `stream.getReader is not a function` under Node. The `webdav` package routes requests through node-fetch there, whose Response body is a Node `Readable` rather than a web stream; the adapter now normalizes it to a web `ReadableStream` so `download(key, { as: "stream" })` works in Node as well as Bun and the browser.
