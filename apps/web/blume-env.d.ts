// Let tsc resolve `.astro` component imports (e.g. from components.ts) — Astro
// files aren't type-checked here, they just need a module shim. A compiled
// `.astro` module's default export is Astro's server component factory.
declare module "*.astro" {
  import type { AstroComponentFactory } from "astro/runtime/server/index.js";

  const component: AstroComponentFactory;
  export default component;
}
