---
"files-sdk": patch
---

The FTP adapter now restores the working directory even when creating a nested directory fails partway through. basic-ftp's `ensureDir` changes into the tree one segment at a time, and the adapter only restored the original directory after a successful walk, so a refused `mkdir` left a reused connection parked inside the tree and later relative paths resolved against the wrong directory.
