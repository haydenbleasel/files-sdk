---
"files-sdk": patch
---

The CLI's `search --match <mode>` flag now validates its value against `glob`, `regex`, `substring`, and `exact`, so a typo is reported as an invalid choice instead of falling through to a confusing regex error.
