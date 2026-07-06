# Files SDK — website & docs

The marketing site and documentation for [Files SDK](https://github.com/haydenbleasel/files-sdk), built with [Blume](https://useblume.dev) (a markdown-first docs framework on Astro). Output is a fully static site.

## Development

```bash
bun install        # from the repo root
bun run dev        # from apps/web — builds the shadcn registry, then runs `blume dev`
```

Open [http://localhost:4321](http://localhost:4321).

- **Docs** live in `docs/` as Markdown/MDX. Navigation is derived from the file tree; `meta.ts` files order each group, and parenthesized `(group)/` folders add sidebar sections without a URL segment. Docs serve under `/docs/*`; the marketing homepage owns `/`.
- **Landing page** is `pages/index.astro` (+ `components/home/*.astro`), with React islands only for the animated capability panels (`components/capabilities/*`).
- **Config** is `blume.config.ts`; theme overrides are in `theme.css`.
- **Component registry** — the shadcn UI components live in `registry/files-sdk/`; `scripts/build-registry.ts` emits `public/r/*.json` (a prebuild step) so `npx shadcn add <site>/r/<name>.json` works. Component previews render against a `lib/demo-files.ts` mock (no live gateway).
- **Changelog** at `/changelog` is generated from the repo's GitHub releases (see `content.sources` in `blume.config.ts`).

## Build

```bash
bun run build      # bun scripts/build-registry.ts && blume build → dist/
bun run preview    # serve the built dist/
```

## Deploy (Vercel)

Static output goes to `dist/`. Redirects and `/r/*` CORS headers live in `vercel.json`. Two settings must be configured in the Vercel project dashboard (they can't be committed):

- **Root Directory** = `apps/web`
- **Node version** = 22+
