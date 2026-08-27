---
"files-sdk": patch
---

The browser client's XHR transport now rejects immediately when handed an already-aborted `signal`. It previously called `xhr.abort()` before `send()`, which per the XMLHttpRequest spec fires no `abort` event, so the upload promise never settled in real browsers and callers awaiting an upload with a pre-aborted signal hung forever. The rejection is the same abort error an in-flight abort produces, and no request is opened.
