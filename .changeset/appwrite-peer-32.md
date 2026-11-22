---
"files-sdk": patch
---

Accept `node-appwrite` 30, 31, and 32 as peers of the Appwrite adapter (`files-sdk/appwrite`). The Storage API the adapter calls is unchanged across all three majors. One behaviour to know about comes from the SDK itself: from `node-appwrite` 31.1 every call refuses to follow an HTTP redirect, so an `endpoint` that redirects (an `http://` URL that upgrades to `https://`, say) now fails with a `Provider` error naming the redirect instead of being followed. Point `endpoint` at the final URL.
