---
"files-sdk": patch
---

`files download --out-dir` now accepts a filesystem root (`/`, `C:\`) as the directory. The check that keeps a key from being written outside `--out-dir` compared against the root with a second separator appended, so every key was refused with `refusing to write key outside --out-dir`.
