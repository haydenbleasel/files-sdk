---
"files-sdk": patch
---

`files-sdk/tiering`'s `tier(key, target)` now throws `Invalid` when `target` is anything other than `"hot"` or `"cold"`. An untyped value (say `"warm"`, from a request body) was treated as the cold tier, so calling it on an object already in the cold tier copied the object onto itself and then deleted it.
