# Contributing to Files SDK

Thanks for your interest in contributing! Files SDK is a unified storage SDK for object/blob backends (AWS S3, Cloudflare R2, Vercel Blob, MinIO, DigitalOcean Spaces, Storj, Hetzner, Akamai, GCS, Azure, Supabase, UploadThing). Bug reports, new adapters, docs improvements, and discussion are all welcome.

## Source Code

The repository is hosted on GitHub at [haydenbleasel/files-sdk](https://github.com/haydenbleasel/files-sdk).

## Project Scope

Files SDK aims for a small, honest API surface that works the same way across every backend. Before opening a PR, it helps to understand the design intent:

- **v1 scope is intentionally narrow.** The core covers CRUD + URLs only: `upload`, `download`, `delete`, `list`, `head`, `copy`, `url`, `signedUrl`, `signedUploadUrl`. Image transforms, middleware, validators, and a React layer are explicitly out of scope for v1.
- **Common subset, not lowest common denominator.** The unified API should only expose operations every adapter can implement cleanly. Provider-specific features (S3 versioning, R2 lifecycle, Vercel Blob folders, etc.) are reachable through `files.raw`, which returns the underlying native client.
- **Adapter injection, not functional.** The shape is `new Files({ adapter: s3({ ... }) })`, similar to Vercel's Chat SDK rather than the AI SDK.

If you're proposing a feature that doesn't fit into the common subset, the answer is usually "use `raw`" rather than "add it to the core."

## Monorepo Structure

The repo is a Bun + Turbo monorepo:

- `packages/files-sdk` — the SDK itself
  - `src/index.ts` — the `Files` class and shared types
  - `src/s3/`, `src/r2/`, `src/vercel-blob/`, `src/minio/`, `src/digitalocean-spaces/`, `src/storj/`, `src/hetzner/`, `src/akamai/`, `src/gcs/`, `src/azure/`, `src/supabase/`, `src/uploadthing/`, `src/fs/` — adapter implementations, each exposed as its own subpath export (`files-sdk/s3`, etc.)
  - `src/internal/` — shared helpers (errors, stored-file wrapper, env)
  - `test/` — Bun tests, including a `fake-adapter.ts` for exercising the `Files` class without a real backend
- `apps/web` — the Next.js docs/marketing site at [files-sdk.dev](https://files-sdk.dev)

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/files-sdk.git`
3. Install dependencies: `bun install`
4. Create a branch: `git checkout -b your-branch-name`
5. Make your changes
6. Run tests and type checks (see below)
7. Add a changeset if your change affects the published package
8. Commit, push, and open a Pull Request

## Running Things Locally

From the repo root:

- `bun run build` — build all packages with Turbo
- `bun test` — run the full test suite
- `bun run types` — type-check with tsgo
- `bun check` / `bun fix` — lint and auto-fix with [Ultracite](https://www.ultracite.ai/) (oxlint + oxfmt)

From `packages/files-sdk`:

- `bun run dev` — tsup watch mode
- `bun test` — run only the SDK tests
- `bun test:coverage` — tests with coverage

For the docs site:

```bash
cd apps/web
bun dev
```

## Adapters

Each adapter lives in its own folder under `packages/files-sdk/src/<provider>/` and is published as a subpath export. Adapters share an interface defined in `src/index.ts`; whatever can't be expressed by that interface should be reachable via `raw`.

A few conventions worth keeping:

- **MinIO is a thin S3 wrapper.** It reuses the `s3()` adapter with MinIO-friendly defaults (`forcePathStyle: true`, error relabeling, `url()` throws because MinIO buckets are private by default). New S3-compatible providers should follow the same pattern rather than forking the S3 implementation.
- **Errors are normalized.** Adapters should map provider errors into the shared error types in `src/internal/errors.ts` so callers don't need provider-specific error handling.
- **Tests live alongside.** Each adapter has a matching `test/<provider>.test.ts`. New adapters should ship with tests at parity with the existing ones (CRUD + URLs + error mapping).

If you're proposing a brand-new adapter, please open a discussion first — adding one is a long-term maintenance commitment, and we want to make sure it fits the v1 surface before the code lands.

## Tests

- We use `bun test`. Test files live in `packages/files-sdk/test/`.
- The S3 tests use [`aws-sdk-client-mock`](https://github.com/m-radzikowski/aws-sdk-client-mock).
- For tests that exercise the `Files` class itself (not a specific provider), use `fake-adapter.ts` rather than mocking a real provider.
- New behavior in the core API needs coverage in `files.test.ts` and in every adapter test that's affected.

## Changesets

We use [Changesets](https://github.com/changesets/changesets) to manage versions and the changelog.

1. Run `bun changeset` from the repo root
2. Pick `files-sdk` and the appropriate bump:
   - `patch` — bug fixes, internal improvements visible to users
   - `minor` — new adapters, new methods, additive options
   - `major` — anything that changes existing call signatures or behavior
3. Write a clear, user-facing description (this becomes the changelog entry)
4. Commit the generated `.changeset/*.md` file alongside your changes

**Add a changeset for:** bug fixes, new features, new adapters, behavior changes, performance improvements that users will notice.

**Skip the changeset for:** internal refactors, test-only changes, docs site changes, CI/build tweaks, README or contributing-guide updates.

## Pull Request Guidelines

- Keep PRs focused. One feature or fix per PR.
- Include a clear description of what changes and why. Linking to a discussion or issue is helpful.
- Update tests and docs alongside the code change.
- Run `bun fix` before committing so formatting matches.
- Make sure `bun test`, `bun run types`, and `bun run build` all pass.
- If your PR touches the public API, update the docs in `apps/web` too.

## Reporting Issues

### Bugs

Use the [issue tracker](https://github.com/haydenbleasel/files-sdk/issues). A good bug report includes:

- The adapter you're using (S3, R2, Vercel Blob, MinIO, DigitalOcean Spaces, Storj, Hetzner, Akamai, GCS, Azure, Supabase, UploadThing, fs)
- A minimal reproduction (the smallest `new Files({ adapter: ... })` snippet that triggers it)
- What you expected vs. what happened
- SDK version and runtime (Node, Bun, Cloudflare Workers, etc.)

### Feature Requests and Discussions

Open a [discussion](https://github.com/haydenbleasel/files-sdk/discussions) for proposals — especially anything that touches the public API or proposes a new adapter. It's much faster to align on shape before code is written.

## Code of Conduct

Please be respectful in issues, discussions, and PR review. By participating you agree to keep this a welcoming project.

Thanks for contributing!
