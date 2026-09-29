# AGENTS.md

Guidance for coding agents working in this repository. Humans should read `.github/CONTRIBUTING.md` first; this file assumes you have, and records what an agent needs beyond it: the exact commands, the invariants that are easy to break, and the checklists for the tasks that recur here.

## What this repo is

`files-sdk` is a unified storage SDK for object/blob backends: one `Files` class, one `Adapter` interface, 48 adapters and 15 plugins, each published as its own subpath (`files-sdk/s3`, `files-sdk/validation`, …). It also ships a `files` CLI + MCP server, app-layer gateways for most web frameworks, and `useFiles` bindings for React/Vue/Svelte.

Bun + Turbo monorepo:

| Path | What | Published? |
| --- | --- | --- |
| `packages/files-sdk` | The SDK, CLI, gateways, plugins. `src/index.ts` (~3.8k lines) is the core. | Yes, npm `files-sdk` |
| `apps/web` | Docs + marketing site (Blume/Astro), deployed to Cloudflare Workers. Owns the docs source. | No |
| `packages/videos` | Remotion launch/release videos. | No |
| `skills/files-sdk` | The agent skill for SDK consumers. Must track user-facing changes. | Via the repo, not the npm tarball (`files` is `dist` + `docs`) |

Design intent that decides most API questions:

- **Common subset, not lowest common denominator.** Core exposes only what every adapter can do cleanly. Provider-specific features go behind `files.raw` (the native client). "Use `raw`" beats "add it to the core".
- **Fail loud, never degrade silently.** If an adapter can't honor an option (`range`, `delimiter`, `metadata`, `cacheControl`, `control`), the `Files` wrapper throws before any provider I/O, gated on the adapter's `supports*` flags. Plugins that can't enforce a guarantee fail closed.
- **Web-standard I/O.** Bodies are `Blob`/`File`/`ReadableStream`/bytes/`string`. No provider types leak into the public surface.
- **Errors are normalized** to `FilesError` with codes `NotFound | Unauthorized | Conflict | Provider` (plus the SDK-native `ReadOnly`), original error in `cause`.
- **Optional peers are never bundled and never statically imported** from a path that a consumer might take without installing them. See "Bundling".

## Commands

Install once at the root (`bun install`, Bun 1.4, hoisted linker). Then:

```sh
# Repo root (Turbo fans out to every workspace)
bun run build              # SDK: Bun bundler + tsgo .d.ts + docs copy; web: registry + blume build
bun test                   # all tests (fast, offline, mocked)
bun run types              # tsc --noEmit in every workspace (TypeScript 7 / tsgo)
bun run check              # ultracite (oxlint + oxfmt) — read only
bun run fix                # ultracite autofix; run it 2–3× until it reports clean (it is racy across threads)
bun changeset              # add a changeset (see "Changesets")

# packages/files-sdk
bun test <substring>       # path substrings, not globs: `bun test s3` also runs bun-s3, s3-fetch*, cli-conditional-s3… (not minio/r2); pass a path for one file
bun run test:coverage      # the 98% per-file gate. Only meaningful from THIS directory (root cwd = no gate)
bun run dev                # rebuild on change
bun run size               # per-subpath minified/gzipped sizes
LIVE_TESTS=1 bun test .live  # live suites against real providers (needs creds; skipped otherwise)

# apps/web
bun dev                    # docs site locally
```

Notes:

- `test`/`types` depend on `^build` in Turbo. From the package dir, `test/build-output.test.ts` runs the build itself (cold ~2 min in CI).
- Don't use `bun test --parallel` with `--coverage`; it breaks the threshold gate. Don't redirect a test run to a file (`> out.txt`); the two CLI `--stdout` tests hang on the redirected stream.
- `bun fix` rewrites files. Commit or stash before running it if you want a clean diff to review.

## Git hooks and CI

- **Pre-commit** (husky) runs `check`, `types`, `test:coverage`, and `build --filter files-sdk`. Budget a few minutes per commit. Don't bypass it with `--no-verify`; fix what it reports.
- Commits are signed via the maintainer's 1Password SSH agent. If the hook pipeline goes green and the commit then fails with `failed to write commit object`, the vault is locked. Ask the user to unlock it and re-run. Never disable signing.
- **CI** (`.github/workflows/validate.yml`) builds the SDK and runs plain `bun test` in a Node 20/22/24 + Bun matrix (the tests always execute under Bun; the Node legs only smoke-test the built package under that Node), then lints and typechecks once. CI applies no coverage threshold; the pre-commit hook is the only gate. Linux tsgo catches type errors that a macOS run with stale `node_modules` can miss; when a green local run fails in CI, read the job logs (`gh api .../jobs/<id>/logs`) rather than guessing.
- **Required checks.** The "Protect main" ruleset requires every Validate job (`build (…)`, `test (…)` for each runtime, `check`, `types`, `build-web`) to pass before a PR merges, and blocks force-pushes, deletion, and merge commits (linear history). Repo admins bypass it, which is how the maintainer pushes straight to `main`. The Version Packages PR gets its checks from Validate's `push: changeset-release/main` trigger (PRs opened with `GITHUB_TOKEN` don't fire `pull_request`); keep that trigger. Renaming a Validate job or matrix leg renames its check, so update the ruleset in the same change or PRs will wait on a check that never reports.
- **Actions policy.** Only GitHub-owned, verified-creator, `oven-sh/*`, and `changesets/*` actions may run, and every `uses:` must be pinned to a full commit SHA with the version in a trailing comment (`@<sha> # v7.0.1`). The default `GITHUB_TOKEN` is read-only, so each workflow declares its own `permissions`. Dependabot bumps the pinned actions monthly; npm dependencies get security updates only (version bumps are manual).
- **Release** runs on every push to `main`: changesets opens/updates a "Version Packages" PR; merging it publishes to npm and only then deploys the docs site. Don't edit `CHANGELOG.md` or bump versions by hand. Release tags (`files-sdk@*`, `v*`) are protected against update and deletion.
- **Live tests** run only via `workflow_dispatch`, never on fork PRs.

## Source layout (`packages/files-sdk/src`)

- `index.ts` — `Files`, `Adapter`, `FilesPlugin`, `handlers()`, `createFiles()`, every public option/result type. Big on purpose; read the relevant region, not the whole file.
- `<provider>/index.ts` — one folder per adapter, published as `files-sdk/<provider>`. S3-compatible providers **wrap `s3()`**; they do not reimplement S3. Most (spaces, wasabi, b2, tigris, hetzner, …) import `../s3/index.js` directly and always use the AWS SDK. r2, minio, and rustfs go through `internal/s3-engine.ts` instead and offer `client: "aws-sdk" | "fetch"`, with the aws4fetch engine (`internal/s3-fetch.ts`, public as `files-sdk/s3-fetch`) auto-selected on Cloudflare Workers.
- `<plugin>/index.ts` — plugins (`validation`, `encryption`, `versioning`, …), same one-folder-one-subpath rule, kebab-case subpath (`content-type`, `soft-delete`).
- `internal/` — shared helpers. Use them instead of reinventing: `core.ts` (body normalization, URL joining, `resolveUrlStrategy`, `makeErrorMapper`), `errors.ts`, `stored-file.ts`, `env.ts` (`readEnv`), `retry.ts`, `is.ts` (type predicates), `json.ts` (`JsonValue`), `node-stream.ts`, `s3-engine.ts`, `router-core/` + `files-router/` (gateway core shared by every framework binding).
- `api/`, `client/`, `react/`, `vue/`, `svelte/`, `next/`, `hono/`, `express/`, `fastify/`, `koa/`, `nestjs/`, `nitro/`, `astro/`, `sveltekit/`, `tanstack-start/` — the gateway + `useFiles` app layer. Deny-by-default `authorize`, feature-detected plugin verbs.
- `cli/` — `commander` program, MCP server, and `registry.ts` (lazy `import()` per provider). `providers/index.ts` is the **pure-data provider catalog**: no SDK imports, drives the docs catalog and CLI list, and a drift test keeps it in sync with `package.json` exports and each adapter's `readEnv` calls.
- `ai-sdk/`, `openai/`, `claude/` — tool definitions for agent frameworks.
- `memory/` — full in-memory `Adapter`. Prefer it (or `test/fake-adapter.ts`) when testing `Files` itself.

## Conventions the linter enforces (ultracite anti-slop preset on oxlint)

`src/` is held to the full ruleset. Concretely:

- Branch on `is.ts` predicates (`isString`, `isObject`, …), not raw `typeof`.
- Every type assertion in `src/` needs a `// SAFETY: …` comment explaining why it holds. Widen-then-assert and chained assertions are errors.
- `catch (error)` is the required name; if it shadows an outer `error`, rename the outer one.
- Suppress a rule only inline, with a reason: `// oxlint-disable-next-line <rule> -- <why>`. `biome-ignore` comments do nothing here.
- `test/**` relaxes the type-evidence rules (mocks are casts by nature) but keeps the behavioural ones.
- `oxfmt` is patched (`patches/oxfmt@*.patch`) to keep MDX `:::` callout fences on their own lines. Bumping oxfmt silently drops the patch and the next `bun fix` flattens every docs callout. Re-port the patch with any bump.

## Testing

- `bun:test`. One `test/<name>.test.ts` per adapter, plugin, gateway.
- **Per-file coverage threshold: 98% lines and 98% functions** (`bunfig.toml`; keys must be plural). New code ships with tests that meet it; an uncovered branch fails the pre-commit hook.
- Mock at the boundary: `aws-sdk-client-mock` for the S3 family, `test/fake-s3-server.ts` for the fetch engine, `fetch` or the SDK client for the rest. Never `mock.module`: it leaks across test files and can't be reverted. Inject dependencies instead.
- Core behaviour goes in `core.test.ts`/`files.test.ts` against `fake-adapter.ts`; helpers in `internal/` get direct tests.
- Live suites are `*.live.test.ts`, gated by `test/live-helper.ts` (`LIVE_TESTS=1` plus the adapter's env vars). Keep them out of the default run.
- Framework bindings are tested at runtime: React and Svelte mount real components under happy-dom (Svelte via a Bun loader plugin compiling the `.svelte` fixtures in `test/fixtures/`); the Vue test covers the composable.

## Bundling and dependencies

- Runtime `dependencies` are deliberately few (aws4fetch, commander, fflate, mime, p-map, picomatch, safe-regex2). Adding one needs a reason; most providers are optional `peerDependencies`. Widen peer ranges, don't narrow.
- `scripts/build.ts` builds Node entries, edge entries (`api`, `client`, `hono`, `next`, `astro`, `sveltekit`, `tanstack-start`) and each client framework binding as **separate passes** so no `node:module` shim chunk leaks into edge/browser bundles. Keep Node-only imports out of those entries.
- A dynamic `import()` is a lazy boundary for the Node CLI but **not** for a consumer's bundler. Code that must stay SDK-free on Workers (r2/minio/rustfs fetch path) uses the `S3Sdk`-parameterized engine + `lazyS3Adapter` pattern in `internal/s3-engine.ts`. `test/build-output.test.ts` walks the static import graph (with and without following dynamic imports) and fails on any optional peer reached statically.
- Keep `@cloudflare/workers-types` out of `tsconfig` `types`: it declares a global `Buffer: any` that shadows Node's.

## Docs

- **Source of truth is `apps/web/docs/`** (MDX + `meta.ts` per folder, `(group)` folders for sidebar sections). `packages/files-sdk/docs/` is a gitignored copy made at build time. Never edit the copy.
- Callouts are `:::` fences. Inline SVG `<title>` becomes the page title in Blume; avoid it.
- User-facing changes also update `skills/files-sdk/SKILL.md` (and the matching `references/*.md`) and `.github/CONTRIBUTING.md` where the adapter/plugin lists live.
- `apps/web/lib/adapters.tsx` re-exports `files-sdk/providers` and only feeds the homepage adapter count; there is no separate list to maintain. Adapter docs are the hand-written MDX pages (`/docs/adapters` redirects to the S3 page), so a new adapter still needs its page (checklist step 7).

## Changesets

- Any change to the published package (bug fix, feature, adapter, plugin, behaviour change) needs a `.changeset/*.md`. `patch` for fixes, `minor` for new adapters/methods/options, `major` for signature or behaviour breaks.
- Skip it for `apps/web` (in the changeset `ignore` list), videos, CI, tests, refactors, and this file.
- Write the entry as user-facing prose, in full sentences, naming the subpath and the behaviour. `.changeset/rustfs-adapter.md` in history is a good template.

## Commits and PRs

- Imperative, sentence-case subject, no conventional-commit prefix: `Add a RustFS adapter (files-sdk/rustfs)`, `Fix tiering cross-tier transfers…`. Reference issues in the body (`Resolves #123`).
- **No AI attribution**: no `Co-Authored-By` trailers and no "Generated with …" lines in commits or PR bodies.
- Before planning non-trivial work, read `git log` for the last few days. Closely related work often just landed and should be extended, not duplicated.
- Fix + changeset + tests + docs in one commit where practical.

## Checklists

### New adapter (`files-sdk/<slug>`)

Model it on the most recent one (`git show --stat` the "Add a … adapter" commit; `2b8c962` for RustFS). Touch, in order:

1. `src/<slug>/index.ts`. S3-compatible: wrap the engine like `minio/`. Otherwise implement `Adapter`, using `makeErrorMapper`, `readEnv`, `normalizeBody`, `resolveUrlStrategy`, and set the `supports*` / `signedUrl` capability flags honestly.
2. `package.json` `exports["./<slug>"]` (+ optional peer if it needs an SDK).
3. `src/providers/index.ts` catalog entry with every env var the adapter reads (the drift test checks both directions).
4. `src/cli/registry.ts` entry + a case in `test/cli-registry.test.ts`.
5. `test/<slug>.test.ts` at parity with siblings: CRUD, URLs, error mapping, env fallback, capability gates. 98% coverage.
6. `test/build-output.test.ts` if the adapter has an optional peer.
7. Docs: `apps/web/docs/adapters/(vendor-adapters)/<slug>.mdx` (or `(system-adapters)`), the provider span in `docs/cli/index.mdx`, and any "N providers" counts in `docs/index.mdx` / `faq.mdx`.
8. `skills/files-sdk/SKILL.md` + `references/adapter-setup.md`, `.github/CONTRIBUTING.md` lists.
9. `minor` changeset.

### New plugin (`files-sdk/<slug>`)

1. `src/<slug>/index.ts` exporting a factory (`slug()`) returning `FilesPlugin`. Use `handlers()` for per-verb `wrap`; use `extend` only when adding namespaced methods (`files.versions()`), typed via `createFiles`. Plugin metadata keys get a prefix (`fsenc_`, `fscmp_`, `fsdedup_`). Fail closed on anything you can't enforce (e.g. `signedUploadUrl` for a body-transforming plugin).
2. `package.json` export; add the subpath to `NON_PROVIDER_EXPORTS` in `test/providers.test.ts`.
3. `test/<slug>.test.ts` against the memory adapter, including composition with neighbours where order matters (versioning outermost, `ignore` prefixes, etc.).
4. `apps/web/docs/plugins/<slug>.mdx` + `skills/files-sdk` references.
5. `minor` changeset.

### Fixing a reported issue

1. Reproduce with a test first (Bun version matters: check `bun --version`; some reports are Bun runtime bugs, not SDK bugs).
2. Fix, keep the test, add a `patch` changeset mentioning the issue.
3. Update docs/skill if the behaviour was documented.

## Known gotchas

- Root `bunfig.toml` forces the hoisted linker. After changing it or seeing odd resolution errors, `bun install` again.
- Bun ≤1.3 misreads `req.body` from async generators in gateways; upgrade Bun before chasing "flaky upload" reports.
- TanStack Start / nitro dev returns 404 for `<img>` requests to gateway download routes (`Sec-Fetch-Dest`); the components use signed URLs first for that reason.
- `files-sdk/s3` statically imports `@aws-sdk/client-s3` by design. Workers users should use `s3Fetch()` or an S3-compatible adapter's `client: "fetch"`, not a new option on `s3()`.
- Running several shell commands in one batch: a non-zero exit (grep with no match, a failing test) cancels the siblings. Append `; true` to probes.
