---
"files-sdk": patch
---

`files-sdk/ftp` and `files-sdk/sftp` streaming downloads (`as: "stream"`) now remove their abort listener once the stream ends, errors, or closes. Previously the listener stayed on the signal, so a long-lived signal such as the `Files` constructor's `signal` kept every streamed download's connection and stream in memory for as long as the signal lived.
