---
"files-sdk": patch
---

Stop the Appwrite adapter (`files-sdk/appwrite`) from following redirects on resumable-upload chunk requests. Those chunks are sent with `fetch` and carry the API key in a header, so a redirect from the configured `endpoint` re-sent the key to whatever host it named. A redirected chunk now fails with a `Provider` error, on every supported `node-appwrite` version, matching what the SDK itself does for its own calls from 31.1.
