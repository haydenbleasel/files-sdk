# Contributing to Files SDK

Thanks for your interest in contributing! Files SDK is a unified storage SDK for object/blob backends. Bug reports, new adapters, plugins, docs improvements, and discussion are all welcome.

If you're an AI coding agent (or pointing one at this repo), also read [`AGENTS.md`](../AGENTS.md) at the root — it has the exact commands, invariants, and step-by-step checklists for the recurring tasks.

## Source Code

The repository is hosted on GitHub at [haydenbleasel/files-sdk](https://github.com/haydenbleasel/files-sdk).

## Project Scope

Files SDK aims for a small, honest API surface that works the same way across every backend. Before opening a PR, it helps to understand the design intent:

- **Common subset, not lowest common denominator.** The core `Files` API only exposes operations every adapter can implement cleanly: `upload`, `download`, `head`, `exists`, `delete`, `copy`, `move`, `list`/`listAll`, `search`, `url`, `signedUploadUrl`, the array (bulk) forms of `upload`/`download`/`head`/`exists`/`delete`, and `file(key)` handles. Provider-specific features (S3 versioning, R2 lifecycle, Vercel Blob folders, etc.) are reachable through `files.raw`, which returns the underlying native client.
- **Fail loud, never degrade silently.** When an adapter can't honor an option — a byte `range`, a folder `delimiter`, user `metadata`, `cacheControl`, a resumable `control` — the `Files` wrapper throws before any provider I/O, gated on the adapter's `supports*` capability flags. A missing capability is an error, not a quiet correctness bug.
- **Cross-cutting behavior is a plugin, not a core option.** Validation, encryption, compression, versioning, soft-delete, caching, tiering, failover, auditing, tracing, and so on ship as opt-in plugins (`files-sdk/<plugin>`) that compose as an ordered onion around the core. If a proposal would add a knob to every adapter, it probably belongs in a plugin instead.
- **Adapter injection, not functional.** The shape is `new Files({ adapter: s3({ ... }), plugins: [...] })`, similar to Vercel's Chat SDK rather than the AI SDK.
- **Web-standard I/O.** Bodies are `Blob`, `File`, `ReadableStream`, `Uint8Array`, `ArrayBuffer`, or `string`. No provider types leak into the public surface.

If you're proposing a feature that doesn't fit into the common subset, the answer is usually "use `raw`" or "write a plugin" rather than "add it to the core."

## Monorepo Structure

The repo is a Bun + Turbo monorepo:

- `packages/files-sdk` — the published `files-sdk` package. Every folder under `src/` that has an `index.ts` is its own subpath export (`files-sdk/s3`, `files-sdk/validation`, …), except `cli/`, which is the `files` bin, so consumers only bundle what they import.
  - `src/index.ts` — the `Files` class, the `Adapter` and `FilesPlugin` contracts, `handlers()`/`createFiles()`, and every shared option/result type (`Body`, `StoredFile`, `UploadResult`, etc.)
  - Adapters (48 at the time of writing; the live list is `src/providers/index.ts`):
    - Object stores with their own implementation: `src/s3/`, `src/gcs/`, `src/azure/`, `src/bun-s3/`
    - S3-compatible stores that reuse the S3 engine: `src/r2/`, `src/minio/`, `src/rustfs/`, `src/digitalocean-spaces/`, `src/wasabi/`, `src/backblaze-b2/`, `src/tigris/`, `src/storj/`, `src/hetzner/`, `src/akamai/`, `src/scaleway/`, `src/ovhcloud/`, `src/vultr/`, `src/exoscale/`, `src/ibm-cos/`, `src/oracle-cloud/`, `src/tencent/`, `src/alibaba/`, `src/yandex/`, `src/idrive-e2/`, `src/filebase/`, `src/archil/`, `src/neon/`, plus the generic `src/s3-fetch/`
    - Platform blob stores: `src/vercel-blob/`, `src/netlify-blobs/`, `src/supabase/`, `src/uploadthing/`, `src/firebase-storage/`, `src/appwrite/`, `src/pocketbase/`, `src/convex/`, `src/cloudinary/`, `src/bunny-storage/`
    - Drive APIs: `src/google-drive/`, `src/onedrive/`, `src/dropbox/`, `src/box/`, `src/sharepoint/`
    - Local and protocol: `src/fs/`, `src/memory/`, `src/ftp/`, `src/sftp/`, `src/webdav/`
  - Plugins, one folder each: `src/validation/`, `src/encryption/`, `src/compression/`, `src/content-type/`, `src/dedup/`, `src/versioning/`, `src/soft-delete/`, `src/cache/`, `src/tiering/`, `src/failover/`, `src/usage/`, `src/audit/`, `src/tracing/`, `src/signed-url-policy/`, `src/zip/`
  - App layer: `src/api/` (the gateway core), `src/client/`, `src/react/`, `src/vue/`, `src/svelte/` (`useFiles`), and one thin binding per framework (`next`, `hono`, `express`, `fastify`, `koa`, `nestjs`, `nitro`, `astro`, `sveltekit`, `tanstack-start`)
  - AI tools: `src/ai-sdk/`, `src/openai/`, `src/claude/`
  - `src/cli/` — the `files` CLI and MCP server; `registry.ts` lazy-loads one adapter per provider
  - `src/providers/` — the pure-data provider catalog (names, descriptions, env vars). It imports no SDKs and is the single source of truth for the provider list: a drift test checks the CLI registry and every adapter's `readEnv` calls against it, and the docs site derives its adapter count from it
  - `src/internal/` — shared helpers used by every adapter and plugin
    - `core.ts` — body normalization, URL helpers, default expiry, the public-vs-sign precedence rule, and the `makeErrorMapper` factory
    - `errors.ts` — `FilesError` and the `FilesErrorCode` union
    - `stored-file.ts` — the `createStoredFile` wrapper returned from `download()`
    - `env.ts` — environment-variable lookup (`readEnv`)
    - `s3-engine.ts` / `s3-fetch.ts` — the engine switch (with a lazily loaded `@aws-sdk/client-s3` adapter) and the aws4fetch engine behind the `client: "aws-sdk" | "fetch"` option on `r2`, `minio`, and `rustfs`, and behind `files-sdk/s3-fetch`
    - `retry.ts`, `is.ts`, `json.ts`, `node-stream.ts`, `router-core/`, `files-router/` — retries, type predicates, JSON types, stream helpers, and the shared gateway router
  - `test/` — Bun tests, including `fake-adapter.ts` and `fake-s3-server.ts` for exercising the `Files` class and the fetch engine without a real backend
  - `scripts/build.ts` — the build (Bun bundler for JS, TypeScript 7's native compiler for `.d.ts`, then a docs copy)
- `apps/web` — the Blume docs/marketing site at [files-sdk.dev](https://files-sdk.dev). **`apps/web/docs/` is the source of truth for all documentation**; `packages/files-sdk/docs/` is a gitignored copy made at build time so the published package ships version-matched docs.
- `packages/videos` — Remotion launch and release videos (not published).
- `skills/files-sdk` — the agent skill (`SKILL.md` + `references/`) that teaches AI coding tools how to use the SDK. Keep it in step with user-facing changes.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/files-sdk.git`
3. Install dependencies: `bun install` (Bun 1.4+; the root `bunfig.toml` uses the hoisted linker)
4. Create a branch: `git checkout -b your-branch-name`
5. Make your changes
6. Run tests and type checks (see below)
7. Add a changeset if your change affects the published package
8. Commit, push, and open a Pull Request

## Running Things Locally

From the repo root:

- `bun run build` — build all packages with Turbo
- `bun test` — run the full test suite
- `bun run types` — type-check every workspace (TypeScript 7)
- `bun run check` / `bun run fix` — lint and auto-fix with [Ultracite](https://www.ultracite.ai/) (oxlint + oxfmt). `fix` can need a second pass before it reports clean.

From `packages/files-sdk`:

- `bun run dev` — rebuild on change (Bun bundler + tsgo, watch mode)
- `bun test` — run only the SDK tests
- `bun test <substring>` — run a subset (Bun filters are path substrings, not globs: `bun test s3` also runs `bun-s3`, `s3-fetch*`, `cli-conditional-s3`, … but not `minio` or `r2`; pass a file path to run exactly one file)
- `bun run test:coverage` — tests with the per-file coverage gate (see [Tests](#tests)). Run it from this directory; from the root the threshold isn't applied.
- `bun run size` — minified/gzipped size of every subpath export

For the docs site:

```bash
cd apps/web
bun dev
```

A husky pre-commit hook runs `check`, `types`, `test:coverage`, and the SDK build, so expect a commit to take a few minutes. Please don't bypass it with `--no-verify`: it is the only place the coverage gate is enforced. CI builds the SDK and runs `bun test` (without the coverage threshold) in a Node 20/22/24 + Bun matrix — the tests themselves always execute under Bun, and the Node legs smoke-test the built package under that Node version — and runs `check` and `types` once.

## Code Style

Linting is [Ultracite](https://www.ultracite.ai/)'s oxlint ruleset plus its "anti-slop" preset. The SDK source (`packages/files-sdk/src`) is held to the full set; the presentational React trees and the test folder relax a few rules (see `oxlint.config.ts` for the reasoning). Things you'll run into:

- Branch on the predicates in `src/internal/is.ts` (`isString`, `isObject`, …) rather than raw `typeof` checks.
- Every type assertion in `src/` needs a `// SAFETY: …` comment saying why it holds.
- `catch (error)` is the required binding name. If it shadows an outer `error`, rename the outer one.
- If a rule genuinely doesn't fit, suppress it inline and say why: `// oxlint-disable-next-line <rule> -- <reason>`. Keep suppressions visible at the call site rather than widening the config.
- `oxfmt` formats Markdown/MDX too. It's patched (`patches/`) so `:::` callout fences stay on their own lines; if you bump oxfmt, re-port the patch or the next `bun run fix` will flatten every docs callout.

## Adapters

Each adapter lives in its own folder under `packages/files-sdk/src/<provider>/` and is published as a subpath export. Adapters share the `Adapter` interface defined in `src/index.ts`; whatever can't be expressed by that interface should be reachable via `raw`.

A few conventions worth keeping:

- **Build on `internal/core.ts`, don't reinvent it.** Body normalization (`normalizeBody`), public URL joining (`joinPublicUrl`), the default expiry (`DEFAULT_URL_EXPIRES_IN`), the public-vs-sign precedence rule (`resolveUrlStrategy`), and the error mapper factory (`makeErrorMapper`) are shared. These exist partly to cut boilerplate but mainly to codify security-relevant invariants (notably "asking for `responseContentDisposition` forces signing") in one place. New adapters should use them; existing adapters that don't yet are good cleanup targets.
- **S3-compatible providers wrap `s3()`, they don't fork it.** DigitalOcean Spaces, Wasabi, Backblaze B2, Tigris, Storj, Hetzner, Akamai, and most of the S3-compatible list import `../s3/index.js` and add provider-specific defaults (`forcePathStyle`, region, endpoint derivation, error relabeling, `url()` behavior); they always use the AWS SDK. R2, MinIO, and RustFS go through `internal/s3-engine.ts` instead and offer `client: "aws-sdk" | "fetch"` — the aws4fetch engine needs no `@aws-sdk/*` install and is selected automatically on Cloudflare Workers. Copy the `minio/` shape if a new provider should offer both engines, or a plain wrapper like `wasabi/` otherwise. The bundle savings of a hand-rolled implementation aren't worth the maintenance cost.
- **Declare capabilities honestly.** Set `supportsRange`, `supportsDelimiter`, `supportsMetadata`, `supportsCacheControl`, `supportsServerSideCopy`, `signedUrl`, and `conditional` only for what the provider actually does natively. The wrapper uses these to fail loudly instead of silently degrading, and `files.capabilities` surfaces them to callers.
- **Read credentials via `readEnv`** and declare every env var the adapter reads in the `src/providers/index.ts` catalog entry — a test checks the two stay in sync.
- **Never statically import an optional peer from a path consumers might take without it.** `files-sdk/s3` imports `@aws-sdk/client-s3` by design; everything that needs to stay SDK-free on edge runtimes goes through the lazy engine in `internal/s3-engine.ts`. `test/build-output.test.ts` walks the built bundles' static import graph and fails if an optional peer leaks in.
- **Errors are normalized.** Adapters map provider errors into `FilesError` (`NotFound` / `Unauthorized` / `Conflict` / `Provider`) via `makeErrorMapper`. Callers should never need provider-specific error handling. The original error is preserved as `cause`.
- **Tests live alongside.** Each adapter has a matching `test/<provider>.test.ts`. New adapters should ship with tests at parity with the existing ones (CRUD + URLs + error mapping + env fallback + capability gates). Drive-API adapters with an OAuth surface (`dropbox`, `onedrive`) also ship dedicated auth-flow suites (`test/<provider>-auth.test.ts`) — follow that precedent if your adapter has a non-trivial auth surface.

Adding an adapter also means registering it: a `package.json` export, a `src/providers/index.ts` catalog entry, a `src/cli/registry.ts` entry (plus a case in `test/cli-registry.test.ts`), a docs page under `apps/web/docs/adapters/`, and a mention in `skills/files-sdk`. The most recent "Add a … adapter" commit in `git log` is the best template for the full footprint.

If you're proposing a brand-new adapter, please open a discussion first — adding one is a long-term maintenance commitment, and we want to make sure it fits the unified surface before the code lands.

## Plugins

Plugins are opt-in extensions passed as `new Files({ plugins: [...] })`. They compose as an ordered onion (`plugins[0]` is outermost) and have two independent capabilities: `wrap` intercepts every operation (transform, veto, observe), and `extend` contributes namespaced methods like `files.versions()`. See `FilesPlugin` in `src/index.ts` and the [plugin docs](https://files-sdk.dev/docs/plugins/api).

Conventions:

- One folder, one subpath (`files-sdk/<plugin>`), kebab-case (`content-type`, `soft-delete`). Add the subpath to `NON_PROVIDER_EXPORTS` in `test/providers.test.ts` so the catalog drift test knows it isn't a storage provider.
- Author `wrap` with `handlers()` — list only the verbs you care about and the rest pass through. Use `extend` only when you're adding surface, and type it via `createFiles`.
- **Fail closed.** If a plugin can't enforce its guarantee for an operation (for example `signedUploadUrl` on a body-transforming plugin, or `url()` for encrypted objects), throw a `FilesError` rather than returning something the caller will misread as covered.
- Prefix any object metadata the plugin writes (`fsenc_`, `fscmp_`, `fsdedup_`, …) so plugins never collide.
- Test against the memory adapter (`files-sdk/memory`), and cover composition with neighbours when order matters (`versioning` outermost with `ignore: [".trash"]` when paired with `softDelete`, for example).
- Ship a docs page under `apps/web/docs/plugins/` and a `minor` changeset.

## Tests

- We use `bun test`. Test files live in `packages/files-sdk/test/`.
- **Coverage is gated per file at 98% lines and 98% functions** (`packages/files-sdk/bunfig.toml`). New code needs tests that meet it; the pre-commit hook enforces it (CI runs plain `bun test` without the threshold, so don't skip the hook).
- The S3 tests and the aws-sdk path of every S3-compatible wrapper use [`aws-sdk-client-mock`](https://github.com/m-radzikowski/aws-sdk-client-mock). The fetch engine is tested against `test/fake-s3-server.ts`. Other adapters mock at the `fetch` or SDK-client boundary as appropriate.
- Don't use `mock.module` — it leaks across test files and can't be reverted. Inject the dependency instead.
- For tests that exercise the `Files` class itself (not a specific provider), use `fake-adapter.ts` or the `memory` adapter rather than mocking a real provider.
- Shared helpers in `src/internal/` are tested directly — see `errors.test.ts` and `stored-file.test.ts`. Behavior added to `internal/core.ts` should ship with coverage there too.
- New behavior in the core API needs coverage in `files.test.ts` / `core.test.ts` and in every adapter test that's affected.
- Live tests (`*.live.test.ts`) hit a real backend. They're skipped unless `LIVE_TESTS=1` is set and the suite's credentials are present, so the default run stays fast, offline, and credential-free. In CI a maintainer triggers them manually; they never run on fork PRs. See the [README](../packages/files-sdk/README.md#live-tests) for the invocation.

## Docs

- Edit `apps/web/docs/` (MDX, one `meta.ts` per folder, `(group)` folders for sidebar sections). Never edit `packages/files-sdk/docs/`; it's regenerated on every build.
- Callouts are `:::` fences.
- If your change is user-facing, also update `skills/files-sdk/SKILL.md` (and the relevant `references/*.md`) so agents get the same information.

## Changesets

We use [Changesets](https://github.com/changesets/changesets) to manage versions and the changelog.

1. Run `bun changeset` from the repo root
2. Pick `files-sdk` and the appropriate bump:
   - `patch` — bug fixes, internal improvements visible to users
   - `minor` — new adapters, new plugins, new methods, additive options
   - `major` — anything that changes existing call signatures or behavior
3. Write a clear, user-facing description in full sentences (this becomes the changelog entry). Name the subpath and the behavior; recent `.changeset/*.md` files in history are good templates.
4. Commit the generated `.changeset/*.md` file alongside your changes

**Add a changeset for:** bug fixes, new features, new adapters, new plugins, behavior changes, performance improvements that users will notice.

**Skip the changeset for:** internal refactors, test-only changes, docs site changes (`apps/web` is in the changeset ignore list), videos, CI/build tweaks, README or contributing-guide updates.

Releases are automated: a push to `main` opens or updates a "Version Packages" PR, and merging it publishes to npm and redeploys the docs site. Don't edit `CHANGELOG.md` or bump the version by hand.

## Pull Request Guidelines

- Keep PRs focused. One feature or fix per PR.
- Include a clear description of what changes and why. Linking to a discussion or issue is helpful.
- Update tests and docs alongside the code change.
- Run `bun run fix` before committing so formatting matches.
- Make sure `bun test`, `bun run types`, `bun run check`, and `bun run build` all pass.
- If your PR touches the public API, update the docs in `apps/web` and the skill in `skills/files-sdk` too.
- Write commit subjects as imperative sentences (`Add a RustFS adapter (files-sdk/rustfs)`); no conventional-commit prefixes are needed.

## Reporting Issues

### Bugs

Use the [issue tracker](https://github.com/haydenbleasel/files-sdk/issues). A good bug report includes:

- The adapter you're using
- A minimal reproduction (the smallest `new Files({ adapter: ... })` snippet that triggers it)
- What you expected vs. what happened
- SDK version and runtime (Node, Bun, Cloudflare Workers, etc.), including the runtime version — some upload issues have turned out to be runtime bugs rather than SDK bugs

### Feature Requests and Discussions

Open an [issue](https://github.com/haydenbleasel/files-sdk/issues) for proposals — especially anything that touches the public API or proposes a new adapter or plugin. It's much faster to align on shape before code is written.

## Code of Conduct

Please be respectful in issues, discussions, and PR review. By participating you agree to keep this a welcoming project.

Thanks for contributing!
