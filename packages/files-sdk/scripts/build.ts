#!/usr/bin/env bun
import { watch as fsWatch } from "node:fs";
// Build the package: JS via Bun's bundler, .d.ts via tsgo, then mirror the docs.
// Replaces tsup. Bun bundles each entry (no shared chunks, externals stay
// external); tsgo emits per-file declarations into the same dist/ tree.
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import pkg from "../package.json" with { type: "json" };

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const srcDir = resolve(root, "src");

// Peer/optional/runtime deps are consumers' responsibility — never bundle them.
const external = [
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];

// Every published subpath in "exports", plus the CLI bin (which lives in "bin",
// not "exports"). `root: src` mirrors the source tree into dist/.
const entrypoints = [
  ...Object.values(pkg.exports as Record<string, { import: string }>).map(
    ({ import: imp }) =>
      resolve(
        root,
        imp.replace(/^\.\/dist\//u, "src/").replace(/\.js$/u, ".ts")
      )
  ),
  resolve(srcDir, "cli/index.ts"),
];

const buildJs = async () => {
  const result = await Bun.build({
    entrypoints,
    external,
    format: "esm",
    outdir: dist,
    root: srcDir,
    sourcemap: "linked",
    splitting: false,
    target: "node",
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log.message);
    }
    throw new Error("JS bundle failed");
  }
};

const run = async (cmd: string[], label: string) => {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    stderr: "inherit",
    stdout: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${label} failed (exit ${code})`);
  }
};

// tsgo (TypeScript native preview) emits one .d.ts (+ map) per source file.
const buildTypes = () =>
  run(["bun", "x", "tsgo", "-p", "tsconfig.build.json"], "tsgo");

// Reuse the existing docs-mirroring script so it stays the single source.
const copyDocs = () => run(["bun", "scripts/copy-docs.ts"], "copy-docs");

const build = async ({ docs = true } = {}) => {
  const start = performance.now();
  await rm(dist, { force: true, recursive: true });
  await buildJs();
  await buildTypes();
  if (docs) {
    await copyDocs();
  }
  console.log(
    `build: dist/ ready in ${(performance.now() - start).toFixed(0)}ms`
  );
};

await build();

if (process.argv.includes("--watch")) {
  console.log("build: watching src/ for changes…");
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Skip the docs copy on rebuilds — SDK source changes don't touch the docs.
  const rebuild = async () => {
    try {
      await build({ docs: false });
    } catch (error) {
      console.error(error);
    }
  };
  fsWatch(srcDir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, 150);
  });
}
