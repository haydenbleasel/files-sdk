---
"files-sdk": patch
---

The `files` CLI now reports a malformed `--config-json` in the format the output flags ask for: plain text (`error (Provider): …`) under `--no-json`, with a stack trace under `--verbose`. Previously that error was raised before the output flags were read, so it always printed the JSON envelope.
