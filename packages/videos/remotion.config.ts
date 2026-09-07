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

// Walk the webpack rule types Remotion hands to the override callback, so the
// narrowing below is stated against webpack's own contract.
type WebpackConfig = Parameters<
  Parameters<typeof Config.overrideWebpackConfig>[0]
>[0];
type Rule = NonNullable<NonNullable<WebpackConfig["module"]>["rules"]>[number];
type RuleObject = Extract<Rule, { use?: unknown }>;
type UseEntry = Extract<NonNullable<RuleObject["use"]>, unknown[]>[number];
type LoaderEntry = Extract<UseEntry, { loader?: string }>;
type LoaderOptions = Exclude<LoaderEntry["options"], string | undefined>;
interface EsbuildLoaderEntry extends LoaderEntry {
  loader: string;
  options: LoaderOptions;
}

const isRuleObject = (rule: Rule): rule is RuleObject =>
  typeof rule === "object" && rule !== null;

const isLoaderEntry = (use: UseEntry): use is LoaderEntry =>
  typeof use === "object" && use !== null;

// An esbuild-loader entry that already carries an options object to patch.
const isEsbuildLoader = (use: LoaderEntry): use is EsbuildLoaderEntry =>
  typeof use.loader === "string" &&
  use.loader.includes("esbuild-loader") &&
  typeof use.options === "object" &&
  use.options !== null;

const injectTsconfigRaw = (config: WebpackConfig) => {
  for (const rule of config.module?.rules ?? []) {
    if (!isRuleObject(rule) || !("use" in rule)) {
      continue;
    }
    const uses = Array.isArray(rule.use) ? rule.use : [rule.use];
    for (const use of uses) {
      if (isLoaderEntry(use) && isEsbuildLoader(use)) {
        use.options.tsconfigRaw = TSCONFIG_RAW;
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
