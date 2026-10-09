---
"files-sdk": patch
---

A `search` on the `files-sdk/api` gateway no longer walks the whole bucket when its pattern matches little or nothing. Each request now reads at most `maxSearchScan` keys (a new router option, default 10000), matching or not, and answers `truncated: true` when it stops early. `files-sdk/client` now surfaces that flag: the `search()` generator returns `{ truncated }` when it finishes (read it from the final `next()`; a `for await` loop drops it), so a caller can tell a complete answer from one the gateway cut short at `maxResults`, its `maxSearchResults` cap, or the scan budget. The `useFiles()` bindings in `files-sdk/react`, `files-sdk/vue`, and `files-sdk/svelte` pass it through, and the type is exported as `SearchSummary`.
