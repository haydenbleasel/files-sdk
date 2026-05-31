---
"files-sdk": minor
---

Add a `contentType()` plugin at `files-sdk/content-type` that decides an upload's `Content-Type` from its bytes instead of the client's claim. It magic-byte-sniffs the body on `upload` and either corrects the stored type to match (the default) or rejects a mismatch, so a `.png` whose bytes are really HTML/SVG can't be stored under an image type and served inline. Recognizes the common images, PDF, and — via a leading text scan — HTML, SVG, and XML. It writes no metadata and only reads the first 512 bytes, so known-length bodies are peeked with no copy and streams stay streaming; `signedUploadUrl()` fails closed (a direct client upload bypasses the sniff). Also exports `detectContentType()`. No native dependencies; works on any adapter.
