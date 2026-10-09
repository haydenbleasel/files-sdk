import { defineComponents } from "blume";

import AdapterComparison from "./overrides/adapter-comparison.astro";
import AdapterList from "./overrides/adapter-list.astro";
import ComponentInstall from "./overrides/component-install.astro";
import Footer from "./overrides/footer.astro";

export default defineComponents({
  layout: {
    // Blume's footer plus setup-action tracking (install and code copies).
    Footer,
  },
  mdx: {
    // `<AdapterComparison />` → the capability table on /docs/adapters, from
    // lib/adapter-capabilities.json (snapshotted from the adapters).
    AdapterComparison,
    // `<AdapterList group="recommended" | "other" />` → the adapter directory
    // on /docs/adapters, split the same way as the homepage's adapter list.
    AdapterList,
    // `<ComponentInstall name="…" />` → the shadcn CLI command that installs
    // that registry component from this site's own `/r/<name>.json`.
    ComponentInstall,
  },
});
