---
"files-sdk": patch
---

Fix `tiering()`'s merged `list()` emitting a both-tier key twice across pages. The "hot wins" dedup was per page while the two tiers paginate independently, so a key present in both tiers (exactly the stale-shadow state `fallback` mode anticipates after a crash mid-eviction) appeared twice — with potentially different sizes/etags — once each tier's stream reached it, breaking `listAll`/`sync`/`search` consumers. Merged listing is now globally key-ordered: each page emits entries only up to the lowest page boundary among tiers that still have more, holding the rest back via a `skip` marker in the composite cursor, which makes cross-page duplicates (of keys and of delimiter prefixes) impossible. An undecodable composite cursor now throws instead of silently restarting the listing from the top. Composite cursors changed shape — don't carry a list cursor across versions.
