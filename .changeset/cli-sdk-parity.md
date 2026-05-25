---
"files-sdk": minor
---

Bring the CLI (and MCP server) to full parity with the SDK surface.

Every `Files` capability is now reachable from the `files` binary:

- **Global `--key-prefix`** scopes every operation under a base path (the instance prefix from `new Files({ prefix })`, distinct from the one-off `list --prefix` filter). **Global `--timeout` / `--retries`** set the per-attempt timeout and retry count for all commands.
- **`download --range start-end`** downloads a byte range (0-based, inclusive), e.g. `0-1023` or `1024-`.
- **`upload --multipart`** (with `--part-size` / `--multipart-concurrency`) uploads large objects in parallel parts.
- **`head` / `exists` / `delete`** accept `--concurrency` and `--stop-on-error` to tune the bulk fan-out for many keys.
- **`list --all`** walks every page (following the cursor) and returns all items in one result.
- **`upload --dir <localDir>`** uploads a whole local tree (keyed by relative path, content type inferred per file), and **`download <keys...> --out-dir <dir>`** downloads many keys into a directory — both built on the SDK's bulk array forms.
- **`transfer`** copies every object from the configured (source) provider to another provider given as a JSON config (`--to`), streaming each body across backends. `--prefix` filters the walk and `--no-overwrite` skips keys already present at the destination.

The MCP server mirrors all of the above: the `upload` tool takes `multipart`, `download` takes a byte `range`, the `head` / `exists` / `delete` tools take `concurrency` / `stopOnError`, `list` takes `all`, and a new `transfer` tool copies objects across providers. The global `--key-prefix` / `--timeout` / `--retries` bind to the server's `Files` instance at startup.
