import { defineComponents } from "blume";

import ComponentInstall from "./overrides/component-install.astro";

export default defineComponents({
  mdx: {
    // `<ComponentInstall name="…" />` → the shadcn CLI command that installs
    // that registry component from this site's own `/r/<name>.json`.
    ComponentInstall,
  },
});
