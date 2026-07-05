// Let tsgo resolve `.astro` component imports (e.g. from components.ts) — Astro
// files aren't type-checked here, they just need a module shim.
declare module "*.astro" {
  const component: (props: Record<string, unknown>) => unknown;
  export default component;
}
