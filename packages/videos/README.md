# Files SDK videos

Remotion project holding every Files SDK launch and release video as a separate
composition. Run `npm run dev` and pick a composition from the Studio sidebar.

## Compositions

| ID               | Video        |
| ---------------- | ------------ |
| `FilesSdkLaunch` | Launch video |
| `FilesSdk13`     | 1.3 release  |
| `FilesSdk14`     | 1.4 release  |
| `FilesSdk15`     | 1.5 release  |
| `FilesSdk16`     | 1.6 release  |
| `FilesSdk17`     | 1.7 release  |
| `FilesSdk18`     | 1.8 release  |
| `FilesSdk19`     | 1.9 release  |
| `FilesSdk20`     | 2.0 launch   |

## Layout

- `src/shared/` — components shared across videos (`Background`, `IntroScene`,
  `Outro`, `CodeWindow`, the `code` data, `typewriter`). `IntroScene`, `Outro`,
  and `Background` are parameterized per video. `highlight` (a small TS/JSX
  tokenizer so code panes can be authored as plain strings) and `animation`
  (`fadeUp`/`fadeInOut`) back the newer `v2-0` tabbed editor.
- `src/launch/`, `src/v1-3/` … `src/v1-8/` — each video's bespoke scenes,
  panels, `composition.tsx`, and `timings.ts`. Launch keeps its own
  `code.ts`/`code-window.tsx` (they diverge from the release set).
- `src/root.tsx` — registers every composition.

## Commands

**Start Preview**

```console
npm run dev
```

**Render a video**

```console
npx remotion render FilesSdk18
```

**Upgrade Remotion**

```console
npx remotion upgrade
```

## Docs

Get started with Remotion by reading the [fundamentals page](https://www.remotion.dev/docs/the-fundamentals).

## License

Note that for some entities a company license is needed. [Read the terms here](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
