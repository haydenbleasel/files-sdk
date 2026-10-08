# Files SDK — website & docs

The marketing site and documentation for [Files SDK](https://github.com/haydenbleasel/files-sdk), built with [Blume](https://useblume.dev) (a markdown-first docs framework on Astro). Output is a fully static site.

## Development

```bash
bun install        # from the repo root
bun run dev        # from apps/web — builds the shadcn registry, then runs `blume dev`
```

Open [http://localhost:4321](http://localhost:4321).

- **Docs** live in `docs/` as Markdown/MDX. Navigation is derived from the file tree; `meta.ts` files order each group, and parenthesized `(group)/` folders add sidebar sections without a URL segment. Docs serve under `/docs/*`; the marketing homepage owns `/`.
- **Landing page** is `pages/index.astro` (+ `components/home/*.astro`), static Astro with no islands. Code samples go through `components/home/code-block.astro` (the small tokenizer in `lib/code.ts`), not Shiki, so they carry the brand's highlighted lines.
- **Brand** is ink on paper with one highlighter lime, and the dog-ear (a folded page corner) as the only graphic device: the logo, the primary button, and every card. `theme.css` defines the colors, the `dog-ear` utility, and each landing page's corner color (highlighter for home/SDK, coral for plugins, sky for UI, lilac for CLI/MCP, sun for AI). Fonts are Funnel Display, Funnel Sans and Geist Mono (`theme.fonts` in `blume.config.ts`). The logo is the dog-ear with a gap between the fold and the page (all ink on light, lime fold on dark), locked up with the "Files SDK" wordmark centered on it: `public/logo-{light,dark}.svg`, wordmark outlined to paths. `public/icon{,-dark}.svg` is the mark alone (favicon and social cards).
- **Config** is `blume.config.ts`; theme overrides are in `theme.css`.
- **Component registry** — the shadcn UI components live in `registry/files-sdk/`; `scripts/build-registry.ts` emits `public/r/*.json` (a prebuild step) so `npx shadcn add <site>/r/<name>.json` works. Component previews render against a `lib/demo-files.ts` mock (no live gateway).
- **Changelog** at `/changelog` is generated from the repo's GitHub releases (see `content.sources` in `blume.config.ts`).

## Build

```bash
bun run build      # bun scripts/build-registry.ts && blume build → dist/
bun run preview    # serve the built dist/
```

## Deploy (Cloudflare Workers)

Static output goes to `dist/` and is served as Workers static assets per `wrangler.jsonc`. Redirects live in `public/_redirects` and the `/r/*` CORS headers in `public/_headers`; Blume copies both into `dist/` untouched.

```bash
bun run build      # dist/
bun run deploy     # wrangler deploy (needs CLOUDFLARE_API_TOKEN or `wrangler login`)
```

Deploys run from GitHub Actions (`.github/workflows/deploy.yml`) after each npm release (called from `release.yml`, so the changelog picks up the new GitHub release) or manually via `workflow_dispatch`; plain pushes to `main` don't deploy. The workflow needs two repository secrets, `CLOUDFLARE_API_TOKEN` (Workers Scripts, Workers Routes, DNS and SSL edit) and `CLOUDFLARE_ACCOUNT_ID`. The changelog fetch uses the workflow's own `GITHUB_TOKEN`. Web Analytics is Cloudflare's automatic zone-level injection, so nothing is configured in the build.
