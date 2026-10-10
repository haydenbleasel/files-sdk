---
"files-sdk": patch
---

The `files-sdk/api` gateway no longer lets a comma-separated content type such as `image/png, text/html` skip the download sandbox. A browser renders such a value as its last entry, so a proxied download opened inline could run stored HTML as your app; the sandbox now applies to any stored type that isn't exactly one well-formed media type. The gateway also refuses such a content type from a client with a `422` (`reason: "type"`) on the keyed upload `PUT`, `presign`, and `signed-upload-url`, while an absent content type is still accepted.
