---
"files-sdk": patch
---

`files-sdk/content-type` now classifies an XML document that has no `<?xml` prolog by its root element when the declared type is XML-based. An XHTML- or SVG-namespaced root (`<x:html xmlns:x="http://www.w3.org/1999/xhtml">`, or an `<svg>` behind a `<!DOCTYPE>`) uploaded as `application/xml` used to count as unidentified bytes and keep that type, so it slipped past `onMismatch: "reject"` and a `validation()` allowlist; it is now relabeled (or rejected) as `application/xhtml+xml` / `image/svg+xml`, the same as one behind a prolog.
