---
"files-sdk": patch
---

Downloads streamed through the `files-sdk/api` proxy now send `Cache-Control: private, no-store`, as redirects already did. Download URLs are tenant-relative (`?op=download&key=avatar.jpg` is the same URL for every user under their own `keyPrefix`), so a shared cache could otherwise serve one user's file to the next. Proxied content that a browser could run as a document (HTML, SVG, XML, and any other type that isn't a raster image, audio, video, or PDF) is now also served with `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`, so a stored `text/html` opened inline (when `authorize` returns `disposition: "inline"`, or with `forceDownloadDisposition: false`) can't run script as your app. Images, media, and PDF previews render as before.
