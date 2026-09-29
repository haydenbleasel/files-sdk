---
"files-sdk": patch
---

`files-sdk/api` now refuses a `search` whose string pattern uses `match: "regex"` with `422` when the pattern doesn't compile (`invalid search regex`) or could backtrack catastrophically (`search pattern is too complex`), the same as the `isRegex` form. Previously it failed later, inside the matcher, as a `500` `Provider` error.
