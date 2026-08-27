---
"files-sdk": patch
---

The gateway's `search` op now matches against the caller-facing key when `authorize` returns a `keyPrefix` scope, the same way `list` already returns unscoped keys. Previously the pattern was tested against the full storage key with the scope prefix still attached, so a client scoped to `users/1/` searching `*.png`, `a.png` with `match: "exact"`, or `^a` as a regex got no matches for `users/1/a.png`. The handler also validates `match` against `glob`, `regex`, `substring`, and `exact` and answers a 422 for anything else instead of silently treating the value as a regex.
