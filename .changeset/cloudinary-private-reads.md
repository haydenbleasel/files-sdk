---
"files-sdk": patch
---

`files-sdk/cloudinary` now reads `private` and `authenticated` assets through a signed `private_download_url`. `download()` and the lazy bodies from `head()` and `list()` used to fetch the unsigned delivery URL, which Cloudinary answers with 401 for those types, so every read failed and was retried as a `Provider` error. An asset with no stored format now fails once with a non-retryable error, matching `url()`.
