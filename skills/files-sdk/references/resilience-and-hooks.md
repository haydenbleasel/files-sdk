# Resilience, scoping & observability

Constructor and per-call knobs that aren't about a single object's bytes: retries, timeouts, cancellation, prefix scoping, read-only views, and hooks. The three `OperationOptions` (`signal`, `timeout`, `retries`) are accepted both on `new Files(...)` (as instance defaults) and per call (where a per-call value wins).

## Retries

`retries` retries transient failures automatically — a number (shorthand for `{ max }`) or `{ max, backoff }`.

```ts
const files = new Files({
  adapter: s3({ bucket: "uploads" }),
  retries: { max: 3, backoff: ({ attempt }) => attempt * 500 },
});

await files.upload("avatars/abc.png", file, { retries: 0 }); // opt one call out
```

- **Only `Provider` failures** retry — network blips, throttling, 5xx. `NotFound`/`Unauthorized`/`Conflict` are deterministic and returned immediately. Aborts and timeouts are never retried. **`ReadableStream` uploads are never retried** (a consumed stream can't be replayed) — buffered bodies retry normally.
- **Default backoff** is exponential — `100 * 2 ** (attempt - 1)` ms (100, 200, 400, …), capped at 30s, no jitter. `attempt` is `1` for the first retry. A caller-supplied `backoff` is used verbatim — no cap — so add your own ceiling/jitter.
- **Bulk forms don't retry** — they surface per-key failures in `errors[]` so you re-drive only what failed.

## Timeouts

`timeout` caps how long a single **attempt** may run (ms). On fire, the call aborts and rejects with a `Provider` `FilesError` (`aborted: true`). **Not retried** — it ends the call. No default; `0`/negative disables.

```ts
const files = new Files({
  adapter: s3({ bucket: "uploads" }),
  timeout: 10_000,
});
await files.head("avatars/abc.png", { timeout: 2_000 }); // tighter for one read
await files.download("big.zip", { timeout: 0 }); // disabled for a large object
```

Because it's **per attempt** and timeouts aren't retryable, a call that retries up to `n` times on _other_ (provider) errors can run as long as `timeout × n` plus backoff. Bound the whole call with a `signal` you abort yourself. When an adapter applies its own download timeout (Vercel Blob, UploadThing), the signals merge — yours can tighten the deadline, never loosen it.

## Cancellation (`signal`)

Pass a `signal` to bind a call to an `AbortController`. On abort, the in-flight call rejects **immediately** with `FilesError { aborted: true }` (still `code: "Provider"`) — for _every_ adapter, whether or not the provider SDK supports cancellation.

```ts
const controller = new AbortController();
const upload = files.upload("avatars/abc.png", file, {
  signal: controller.signal,
});
controller.abort(); // rejects immediately

// Detecting it:
import { FilesError } from "files-sdk";
try {
  await files.download("big.zip", { signal: controller.signal });
} catch (err) {
  if (err instanceof FilesError && err.aborted) return; // expected
  throw err;
}
```

A constructor `signal` applies to every single-key op (handy for tearing down all in-flight work when a request/job ends); a constructor + per-call signal compose (either aborts). **Failing fast at the `Files` layer is guaranteed; cancelling the underlying provider request is not** — adapters whose SDK exposes cancellation forward the signal (S3 family, Vercel Blob, UploadThing reads), others reject at the `Files` layer while the provider request may run to completion in the background. Bulk forms take no per-call `signal`. Distinguish on the `aborted` flag, not the `code`.

## Prefix scoping

`new Files({ prefix })` resolves every key relative to it — prepended in, stripped from results out — so app code works in its own namespace.

```ts
const users = new Files({
  adapter: s3({ bucket: "uploads" }),
  prefix: "users",
});
await users.upload("123/avatar.png", file); // writes users/123/avatar.png
const stored = await users.head("123/avatar.png");
stored.key; // "123/avatar.png" — prefix stripped
const { items } = await users.list(); // scoped to users/, keys relative
```

Leading/trailing slashes are normalized (`"/users/"`, `"users/"`, `"users"` all equivalent); a leading slash on a key is ignored, so prefix+key always join with exactly one separator. `list` matches on a path boundary — `prefix: "users"` lists `users/` but never the sibling `users-archive/`; the per-call `list({ prefix })` filter and cursor pagination compose with it. The prefix never leaks: results (`key`/`name`) come back relative, hook payloads report the keys you passed, and the bulk forms strip it identically.

## Read-only views

Lock a client to reads — at construction or derived from an existing one:

```ts
const ro = new Files({ adapter: s3({ bucket: "uploads" }), readonly: true });

const base = new Files({
  adapter: s3({ bucket: "uploads" }),
  prefix: "users",
  timeout: 10_000,
});
const view = base.readonly(); // reuses adapter/prefix/timeout/retries/hooks — no second client
```

Still allowed: `download`, `head`, `exists`, `list`, `listAll`, `url`, `file(key)` (for reads). **Blocked** with `FilesError { code: "ReadOnly" }`: `upload`, `delete`, `copy`, `move`, `signedUploadUrl`, and the `file(key)` write helpers (`upload`/`delete`/`copyTo`/`copyFrom`/`moveTo`/`moveFrom`/`signedUploadUrl`). It does **not** lock down `files.raw` — code writing through the escape hatch bypasses the guard by design. (Distinct from the AI-tools `readOnly` option, which _removes_ the write tools from an agent's toolset.)

## Hooks

`new Files({ hooks })` registers fire-and-forget observability callbacks. Each mirrors the lightweight `onProgress` style — caller-facing payloads, no internal adapter detail — and a throwing hook can never fail the operation it observes.

```ts
const files = new Files({
  adapter: s3({ bucket: "uploads" }),
  hooks: {
    onAction({ type, status, key, keys, from, to, durationMs }) {
      metrics.timing(`files.${type}.duration`, durationMs, { status });
    },
    onError({ type, key, error }) {
      logger.error("files failed", type, key, error.code);
    },
    onRetry({ type, attempt, maxRetries, delayMs, error }) {
      logger.warn(
        `retry ${attempt}/${maxRetries} in ${delayMs}ms`,
        type,
        error.code
      );
    },
  },
});
```

- **`onAction`** — fires once when a public call settles, success _or_ error (`status` says which), with wall-clock `durationMs`. Single-key calls set `key`; `copy`/`move` set `from`/`to`; the array form sets `keys` and fires **one** event for the whole batch (per-item failures live in `result.errors`, not in `onError`). On success, `result` is the resolved value (`UploadResult`/`StoredFile`/`ListResult`/…). One `onAction` covers latency/throughput across the whole surface — no per-call wrapping.
- **`onError`** — fires when a public call _rejects_, just before the matching `onAction({ status: "error" })`. Partial failures in a bulk `errors[]` are not rejections and don't fire it.
- **`onRetry`** — fires for each scheduled retry of a single-key call (`attempt`, `maxRetries`, `delayMs`, `error`). Not on the first attempt, for non-retryable errors, for stream uploads, or for bulk calls.

Keys in every payload are the ones the caller passed — the `prefix` is never leaked.
