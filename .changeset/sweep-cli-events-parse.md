---
"files-sdk": patch
---

`files events parse` now uses the configured provider even when `--format` is given, so the parsed events name the real provider and parsers that read adapter config (Box's `rootFolderId`, Cloudinary's `resourceType`) see it; `--format` only overrides the format, and with no provider configured it still parses against an in-memory stand-in. A new repeatable `--header "name: value"` flag passes delivery headers, which makes `--format appwrite` usable (Appwrite sends the event type in `X-Appwrite-Webhook-Events`). With no file and a terminal on stdin, the command now fails with `Invalid` instead of waiting silently for input.
