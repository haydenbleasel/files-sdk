---
"files-sdk": minor
---

Add Cloudinary adapter (`files-sdk/cloudinary`). Defaults to `resource_type: "raw"` for arbitrary-bytes storage; switch to `image`/`video` for transforms. Reads `CLOUDINARY_URL` or individual `CLOUDINARY_*` env vars. Full Adapter surface including signed delivery URLs for `private`/`authenticated` types and form-POST signed upload URLs.
