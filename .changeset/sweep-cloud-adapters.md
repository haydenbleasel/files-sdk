---
"files-sdk": patch
---

Cloud adapter fixes:

- Supabase: user metadata now round-trips exactly on every read (keys were camelCased or dropped, so `encryption()` returned ciphertext), there are no resumable uploads with a pre-built `client`, and `abortUpload()` checks the cancel status.
- Cloudinary: signed URLs, private reads, and resumable uploads need an API key and secret, and are `Unsupported` without them instead of failing on every call.
- GCS, Firebase Storage, and UploadThing reject an expiry over 7 days with `Invalid`.
- UploadThing, Vercel Blob, and Cloudinary map direct-read HTTP statuses to the standard codes.
- Netlify Blobs config errors and PocketBase records without a file are `Invalid`, and a Bunny Storage delete with a read-only key is `Unauthorized`.
- Appwrite offers resumable uploads only with an API key.
