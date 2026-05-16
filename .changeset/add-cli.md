---
"files-sdk": minor
---

Add `files` CLI for agents and scripts. One binary covers every adapter via `--provider <name>` with lazy imports — cold-start cost matches whichever single provider you select. Each `Adapter` method maps to a subcommand (`upload`, `download`, `head`, `exists`, `delete`, `copy`, `list`, `url`, `sign-upload`), with JSON-by-default output, `stdin`/`stdout` streaming for binary bodies, `--dry-run` and `--verbose` modes, and a stable exit-code mapping (`NotFound` → 1, `Provider` → 2, `Unauthorized` → 3, `Conflict` → 4). Provider credentials come from each adapter's existing env-var conventions, and `--config-json` is an escape hatch for the long tail of adapter options. `files ... mcp` boots a stdio MCP server exposing every command as a tool — provider and credentials bind at startup, so the agent only passes operation arguments.
