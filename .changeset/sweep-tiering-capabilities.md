---
"files-sdk": patch
---

`files-sdk/tiering` now advertises only what both tiers can do. `files.capabilities` reported the hot adapter's flags alone, so `list({ delimiter })` threw `Unsupported` from the cold tier while `capabilities.delimiter` said `"any"`, and `range`, `metadata`, or `cacheControl` worked on hot-routed keys but threw on cold-routed ones. The capabilities are now the hot adapter's intersected with the cold one's (booleans must hold on both, the weaker `delimiter` and signed-URL expiry, the tighter `maxExpiresIn`), and the core refuses those options up front for every key, naming the plugin. `serverSideCopy` now reads `false`, since a cross-tier copy streams through the process.
