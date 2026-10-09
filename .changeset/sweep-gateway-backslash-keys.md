---
"files-sdk": patch
---

The `files-sdk/api` gateway now treats a backslash as a path separator when it checks client keys for `.` and `..` segments, and refuses a key that starts with one. Before, `..\u2\secret.txt` under a `users/u1/` scope passed the check, and the `fs` adapter on Windows resolved it into another tenant's directory.
