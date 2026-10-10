---
"files-sdk": patch
---

`files-sdk/firebase-storage` now prefers a passed `app`'s own `storageBucket` over `FIREBASE_STORAGE_BUCKET`. Previously the env var won, so in a process serving several Firebase projects, an adapter built from one project's app used the env var's bucket with that app's credentials. The order is now `bucket`, then the app's `storageBucket`, then `FIREBASE_STORAGE_BUCKET`.
