# CLI & MCP server

`files-sdk` ships a `files` binary at full parity with the SDK, plus a built-in MCP server. Same adapters, same `FilesError` codes, same `StoredFile` shape — JSON-by-default output and stdin/stdout streaming.

## Install & select a provider

The bin comes with the package; install globally for a `files` on `PATH`, or one-shot via `npx`/`bunx`. Adapter SDKs are optional peer deps loaded lazily on first use — install the one(s) for the provider you'll use alongside `files-sdk`.

```sh
npm install -g files-sdk @aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner
files --provider s3 --bucket uploads list

# No install:
npx -p files-sdk files --provider fs --root ./uploads list
```

Pick the provider with `--provider <name>` on every call (or set `FILES_SDK_PROVIDER` once). Credentials come from the adapter's standard env vars (`AWS_ACCESS_KEY_ID`, `BLOB_READ_WRITE_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, …) — the same environment that works with the SDK. Common fields have short flags (`--bucket`, `--region`, `--endpoint`, `--root`, `--container`, `--token`); for the long tail, `--config-json '{...}'` passes the raw adapter-options blob through.

## Commands

Each maps to a `Files` method:

| Command       | Method            | Notes                                                            |
| ------------- | ----------------- | ---------------------------------------------------------------- |
| `upload`      | `upload`          | `--file ./x` or `--stdin`; `--content-type` (else inferred)      |
| `download`    | `download`        | `--out ./x` to disk, `--stdout` to pipe; `--range start-end`     |
| `head`        | `head`            | metadata as JSON; takes multiple keys                            |
| `exists`      | `exists`          | no output — exit 0 = exists, 1 = missing; takes multiple keys    |
| `list`        | `list`            | `--prefix`, `--limit`, `--all` (follow cursor to the end)        |
| `copy`        | `copy`            |                                                                  |
| `move`        | `move`            |                                                                  |
| `delete`      | `delete`          | takes multiple keys                                              |
| `url`         | `url`             | `--expires-in <sec>`                                             |
| `sign-upload` | `signedUploadUrl` | `--expires-in`, `--max-size`, `--content-type`                   |
| `transfer`    | `transfer`        | `--to '<json>'` destination config; `--prefix`, `--no-overwrite` |

```sh
files --provider s3 --bucket uploads upload reports/q1.pdf --file ./q1.pdf --content-type application/pdf
cat q1.pdf | files --provider s3 --bucket uploads upload reports/q1.pdf --stdin
files --provider s3 --bucket uploads download reports/q1.pdf --stdout > q1.pdf
files --provider s3 --bucket uploads list --prefix logs/ --all | jq '.items[].key'
files --provider s3 --bucket uploads url reports/q1.pdf --expires-in 600
files --provider s3 --bucket uploads sign-upload uploads/avatar.png --expires-in 600 --max-size 5242880 --content-type image/png
```

## Global flags

Mirror the constructor + `OperationOptions`, applied to every command:

- **`--key-prefix <p>`** — the _instance_ prefix; scopes every operation under a base path and returns keys relative to it. **Distinct from `list --prefix`**, which is a one-off filter for that one call. They compose (`--dir`/`--out-dir` and bulk commands all honor `--key-prefix`).
- **`--timeout <ms>`** — per-attempt timeout. **`--retries <n>`** — retry count for provider failures.

```sh
files --provider s3 --bucket uploads --key-prefix tenants/acme list   # lists under tenants/acme/
files --provider s3 --bucket uploads --timeout 10000 --retries 3 head reports/q1.pdf
```

## Bulk, ranges, multipart, directories

```sh
# Many keys at once → structured result, no throw on partial failure
files --provider s3 --bucket uploads head a.txt b.txt c.txt
files --provider s3 --bucket uploads delete a.txt b.txt --concurrency 16
files --provider s3 --bucket uploads exists a.txt b.txt --stop-on-error

# Byte range (0-based, inclusive); throws on adapters with no range primitive
files --provider s3 --bucket uploads download big.mp4 --out head.mp4 --range 0-1048575

# Multipart (--part-size / --multipart-concurrency imply --multipart)
files --provider s3 --bucket uploads upload big.iso --file ./big.iso --multipart --part-size 16777216

# Whole local tree up (keyed by relative path, content type inferred per file)
files --provider s3 --bucket site --key-prefix assets upload --dir ./build
# Many keys down into a directory, recreating their key paths underneath
files --provider s3 --bucket uploads download docs/a.pdf docs/b.pdf --out-dir ./pulled

# Cross-provider migration
files --provider s3 --bucket old --verbose transfer \
  --to '{"provider":"r2","bucket":"new","accountId":"...","accessKeyId":"...","secretAccessKey":"..."}' \
  --prefix uploads/ --no-overwrite --concurrency 16
```

## MCP server

`files … mcp` boots an MCP server on stdio. **Read-only by default** — exposes `download`, `head`, `exists`, `list`, `url`. Pass **`--allow-writes`** to also expose `upload`, `delete`, `copy`, `move`, `sign-upload`, `transfer`. Provider + credentials are bound at startup (and the global `--key-prefix`/`--timeout`/`--retries` bind to the server's `Files` instance), so the agent only passes operation arguments, never secrets. Tools mirror the CLI surface: `download` takes a byte `range`, `head`/`exists` take arrays + `concurrency`/`stopOnError`, `list` takes `all`; with writes, `upload` takes `multipart`, `delete` takes arrays, `transfer` takes a `to` config. Binary payloads roundtrip as base64 (download bytes, and `upload` with a `base64` body).

```sh
files --provider s3 --bucket uploads mcp                 # read-only
files --provider s3 --bucket uploads mcp --allow-writes  # opt into mutations
```

```jsonc
// ~/.claude.json or .claude/mcp.json
{
  "mcpServers": {
    "files-sdk": {
      "command": "files",
      "args": ["--provider", "s3", "--bucket", "uploads", "mcp"],
      "env": { "AWS_ACCESS_KEY_ID": "...", "AWS_SECRET_ACCESS_KEY": "..." },
    },
  },
}
```

> This process-external MCP server is distinct from the **in-process AI-tool bindings** (`files-sdk/ai-sdk` / `openai` / `claude`) in [ai-tools.md](ai-tools.md), which embed tools directly in your own agent code.
