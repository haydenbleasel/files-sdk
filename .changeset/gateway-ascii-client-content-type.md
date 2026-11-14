---
"files-sdk": patch
---

The `files-sdk/api` gateway now refuses a client content type that isn't ASCII with `422` (`reason: "type"`) on `presign` and `signed-upload-url`. A type such as `image/png; name=日本` used to be stored, and every proxied download of that object then failed with a `500` because no response header can carry it.
