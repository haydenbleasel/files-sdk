---
"files-sdk": patch
---

`files.search()` now finds keys when the glob contains a backslash escape such as `a\*b/x`. The literal prefix pushed down to the provider's list call used to keep the escape verbatim (`a\*b/x`), so nothing was listed even though the matcher correctly accepted the key `a*b/x`. Escapes are now unwrapped to the literal characters they stand for before the prefix is applied.
