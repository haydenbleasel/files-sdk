---
"files-sdk": patch
---

`contentType()` (`files-sdk/content-type`) no longer rejects or relabels legitimate files it used to misread. A real `favicon.ico` is accepted in `onMismatch: "reject"` mode (its registered `image/vnd.microsoft.icon` type now agrees with the sniffed `image/x-icon`); RSS, Atom, KML, GPX, XHTML and other `*+xml` files behind an `<?xml` prolog keep their declared type instead of being rejected or flattened to `application/xml`; and a leading `<!-- … -->` comment is skipped, so an SVG or XML file that opens with one is no longer labelled `text/html`. `detectContentType()` likewise reports what follows leading comments (for example `image/svg+xml`) rather than always `text/html`.
