import { defineComponents } from "blume";

import AdapterList from "./overrides/adapter-list.astro";
import ComponentInstall from "./overrides/component-install.astro";

export default defineComponents({
  mdx: {
    // `<AdapterList group="recommended" | "other" />` → the adapter directory
    // on /docs/adapters, split the same way as the homepage's adapter list.
    AdapterList,
    // `<ComponentInstall name="…" />` → the shadcn CLI command that installs
    // that registry component from this site's own `/r/<name>.json`.
    ComponentInstall,
  },
});
