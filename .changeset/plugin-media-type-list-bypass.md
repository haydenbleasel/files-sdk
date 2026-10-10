---
"files-sdk": patch
---

`files-sdk/validation` and `files-sdk/content-type` no longer accept a declared content type that is really a list, such as `image/png;a=b, text/html`. Both plugins used to check only the text before the first `;` and then store the caller's value verbatim, which a browser renders as its last entry (`text/html`), so a PNG/HTML polyglot could pass `allowedTypes: ["image/*"]` or `contentType({ onMismatch: "reject" })`. A declared type that isn't exactly one well-formed media type is now refused with an `Invalid` error (by `validation()` whenever `allowedTypes` is set, and by `contentType()` in every mode), and the type either plugin forwards is stored with its type and subtype normalized.
