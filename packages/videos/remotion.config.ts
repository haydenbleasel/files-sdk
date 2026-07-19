/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

// The repo root hoists TypeScript 7 (tsgo), which has no JS API — Remotion's
// esbuild-loader crashes reading tsconfig.json through it. Supplying
// `tsconfigRaw` up front makes the loader skip `require("typescript")`.
const TSCONFIG_RAW = { compilerOptions: { jsx: "react-jsx" } };

const injectTsconfigRaw = (config: ReturnType<typeof enableTailwind>) => {
  for (const rule of config.module?.rules ?? []) {
    if (!rule || typeof rule !== "object" || !("use" in rule)) {
      continue;
    }
    const uses = Array.isArray(rule.use) ? rule.use : [rule.use];
    for (const use of uses) {
      if (
        use &&
        typeof use === "object" &&
        typeof use.loader === "string" &&
        use.loader.includes("esbuild-loader") &&
        use.options &&
        typeof use.options === "object"
      ) {
        (use.options as Record<string, unknown>).tsconfigRaw = TSCONFIG_RAW;
      }
    }
  }
  return config;
};

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.overrideWebpackConfig((config) =>
  injectTsconfigRaw(enableTailwind(config))
);
