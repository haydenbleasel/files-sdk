---
"files-sdk": patch
---

`files-sdk/google-drive` now restores literal `\n` escapes in `GOOGLE_DRIVE_PRIVATE_KEY` to newlines, as `files-sdk/firebase-storage` already does, so a PEM key pasted into an env file or CI secret parses.
