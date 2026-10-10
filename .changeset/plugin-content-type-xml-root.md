---
"files-sdk": patch
---

`files-sdk/content-type` now classifies a document behind an `<?xml` prolog by its root element, so an XHTML or SVG document can no longer pass as an arbitrary `+xml` type. Previously any declared `+xml` type agreed with an XML sniff, so an XHTML page uploaded as `image/x+xml` passed `onMismatch: "reject"` (and an `image/*` allowlist after it) and ran its scripts when served. An `html` or `svg` root (or one in the XHTML or SVG namespace) now needs exactly `application/xhtml+xml` or `image/svg+xml`, an XML document never agrees with an `image/`, `audio/`, `video/`, or `font/` type other than `image/svg+xml`, and `detectContentType()` reports `application/xhtml+xml` for an XHTML root.
