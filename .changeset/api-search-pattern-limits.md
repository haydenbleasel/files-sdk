---
"files-sdk": patch
---

`files-sdk/api` now refuses `search` patterns that could tie up the server. A glob such as `*a*a*a*a*a*a*a*a*a*a*b` or a flat regex chain such as `^(.*a){10}.*b$` could take seconds to test against a single key on the backtracking regex engine, and the old check only caught nested repetition. The gateway now answers `422` before matching any key when a pattern is longer than `maxSearchPatternLength` (default 256 characters) or has more than `maxSearchWildcards` unbounded wildcards or quantifiers (default 4; an unanchored regex counts one extra). Both limits are new `createFilesRouter` options.
