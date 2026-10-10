---
"files-sdk": patch
---

`files-sdk/fs` now rejects keys that end in `/`, or in a `.` or `..` segment, with `Invalid`. Path resolution used to drop the trailing part, so `upload("dir/")` wrote a file named `dir` and `delete("a.txt/")` deleted `a.txt`. A `delete("dir/")` that used to be a silent no-op now throws `Invalid` too.
