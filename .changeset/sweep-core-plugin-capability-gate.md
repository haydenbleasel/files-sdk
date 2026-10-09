---
"files-sdk": patch
---

A plugin that only declares a `capabilities` hook, without a `wrap`, now has its narrowing enforced. Before, `Files` only checked the plugin-narrowed capabilities when some plugin wrapped operations, so a capabilities-only plugin that turned off `rangeRead`, `metadata`, `cacheControl`, `resumable`, `delimiter`, or `signedUrl` changed what `files.capabilities` advertised while `download({ range })`, `upload({ metadata })`, `list({ delimiter })`, or `url(key, { expiresIn })` still went through to the adapter. Those calls now throw `Unsupported` before any provider I/O, with an error naming the plugin, exactly as they already did when the plugin also wrapped.
