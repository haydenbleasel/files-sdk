---
"files-sdk": patch
---

Fix `files mcp` failing to start from the published package. The bundled MCP server read its version from a fixed `../../package.json` that only resolved from source, so in an installed package it failed at startup with a misleading "the `mcp` subcommand requires `@modelcontextprotocol/sdk` and `zod`" error even when both were installed. The CLI now finds its own `package.json` from wherever the build places each module.
