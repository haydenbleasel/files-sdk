---
"files-sdk": patch
---

Document and test `upload()` and `download()` in Convex mutations for the Convex adapter (`files-sdk/convex`). Convex 1.48 added `ctx.storage.store()` and `ctx.storage.get()` to mutations, and the adapter feature-detects them, so both verbs already work there on 1.48 and later (the bytes count toward the mutation's transaction limits). The `Unsupported` error thrown where they are missing (queries, and mutations on older Convex) now says so instead of claiming they need an action. No peer range change.
