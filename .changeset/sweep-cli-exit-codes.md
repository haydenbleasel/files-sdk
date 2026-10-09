---
"files-sdk": patch
---

The `files` CLI no longer reports command mistakes with the retryable `Provider` exit code (`5`). A malformed integer flag (`--limit abc`, `--part-size 5MB`) is now a usage error that exits `2` and prints the command's help. A local file problem (a missing `--file` or `--dir`, an `--out` into a directory that doesn't exist, a missing `events parse` file) is reported as `Invalid` and exits `2`. A provider whose SDK isn't installed is reported as `Unsupported` (exit `2`) with the `npm install` command for its peer dependencies. A failed write to stdout no longer claims to be a `Provider` error. When `files mcp` can't load, the message now names both `@modelcontextprotocol/sdk` and `zod`, since a strict installer can leave out the optional `zod` peer.
