import { defineMeta } from "blume";

// Each `(section)` folder is a sidebar section and a section of the /guides
// hub (pages/guides/index.astro), in this order.
export default defineMeta({
  pages: [
    "uploads",
    "downloads",
    "ai",
    "providers",
    "architecture",
    "troubleshooting",
  ],
  title: "Guides",
});
