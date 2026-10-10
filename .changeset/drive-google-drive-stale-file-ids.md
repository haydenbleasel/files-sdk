---
"files-sdk": patch
---

`files-sdk/google-drive` no longer trusts a cached file id after another process or the Drive UI deleted, trashed, or replaced the file. Before, `head` reported `NotFound`, `exists` returned `false`, and `delete` resolved while the live file stayed. Now, when Drive answers that a cached id is gone, the adapter drops it and looks the key up again once. A trashed file reads as missing, and `delete`, `copy`, and `url` check that a cached id isn't trashed before acting on it.
