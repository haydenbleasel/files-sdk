---
"files-sdk": patch
---

Fixed the CLI's `exists` command with multiple keys exiting with code 1 ("missing") when a hard error such as an authentication failure occurred alongside a missing key. The hard error's mapped exit code now wins.
