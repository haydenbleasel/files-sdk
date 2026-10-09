---
"files-sdk": patch
---

CLI, MCP, and AI tool fixes:

- Bad integer flags and local file problems exit `2` instead of the retryable `5`, and a missing provider SDK is `Unsupported` with the `npm install` command.
- `files events parse` uses the configured provider alongside `--format`, accepts `--header` (needed for Appwrite), and no longer waits on a terminal.
- The MCP and AI tools describe `expiresIn` and capabilities the v3 way, report `maxBytes` and bad base64 as `Invalid`, and the MCP `upload` infers the content type from the key.
