import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

export default defineConfig({
  extends: [core, react, next],
  ignorePatterns: [
    "apps/web/components/ui",
    "apps/web/lib/utils.ts",
    "apps/web/hooks/use-mobile.ts",
  ],
});
