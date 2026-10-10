---
"files-sdk": patch
---

`files-sdk/zip` `unzip()` now decodes entry names the way the archive declares them. Names were always read as UTF-8 with invalid bytes replaced, so archives from Windows Explorer and other tools that write code page 437 produced garbled keys, and two such entries could collapse into one name and fail as duplicates. Names flagged UTF-8, or carried in an Info-ZIP Unicode Path field, are now read as strict UTF-8 and fail closed on invalid bytes. Unflagged names are read as UTF-8 when they are valid UTF-8 and as code page 437 otherwise.
