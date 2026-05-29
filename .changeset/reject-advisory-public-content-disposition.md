---
"files-sdk": patch
---

Reject `responseContentDisposition` for fs, FTP, and SFTP public URLs because those static URLs cannot bind the override into a signature.
