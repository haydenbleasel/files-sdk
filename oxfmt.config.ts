import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    "apps/web/components/ui",
    "apps/web/lib/utils.ts",
    "apps/web/hooks/use-mobile.ts",
  ],
});
