#!/usr/bin/env bun
import { watch as fsWatch } from "node:fs";
// Build the package: JS via Bun's bundler, .d.ts via tsc, then mirror the docs.
// Replaces tsup. Bun bundles entries with shared chunks enabled so dynamic
// imports stay lazy; externals stay external. tsc (TypeScript 7's native Go
// compiler) emits per-file declarations into the same dist/ tree.
import { rm } from "node:fs/promises";
import path from "node:path";

import pkg from "../package.json" with { type: "json" };

const root = path.resolve(import.meta.dirname, "..");
const dist = path.resolve(root, "dist");
const srcDir = path.resolve(root, "src");

// Peer/optional/runtime deps are consumers' responsibility — never bundle them.
const external = [
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];

const entryFor = (importPath: string) =>
  path.resolve(
    root,
    importPath.replace(/^\.\/dist\//u, "src/").replace(/\.js$/u, ".ts")
  );

// Every published subpath in "exports", plus the CLI bin (which lives in "bin",
// not "exports"). `root: src` mirrors the source tree into dist/.
const allEntrypoints = [
  ...Object.values(pkg.exports as Record<string, { import: string }>).map(
    ({ import: imp }) => entryFor(imp)
  ),
  path.resolve(srcDir, "cli/index.ts"),
];

// The app-layer entries (`api`/`client`/`next`/`react`/`vue`) must run on the
// edge and in the browser, so they are built in their own pass(es). Bundled
// together with the node entries, Bun's shared `createRequire` shim chunk
// (`node:module`) leaks in as a stray side-effect import, failing outside Node.
const reactEntry = path.resolve(srcDir, "react/index.ts");
const vueEntry = path.resolve(srcDir, "vue/index.ts");
const svelteEntry = path.resolve(srcDir, "svelte/index.ts");
// Client framework bindings are each built standalone so the emitted module
// imports only its framework (`react`/`vue`/`svelte`) and inlines its deps — no
// shared `node:module` chunk, and (for React) the `"use client"` banner lands on
// the actual module the consumer imports.
const clientFrameworkEntries = new Set([reactEntry, vueEntry, svelteEntry]);
const edgeEntrypoints = [
  "api",
  "client",
  "hono",
  "next",
  "astro",
  "sveltekit",
  "tanstack-start",
].map((sub) => path.resolve(srcDir, `${sub}/index.ts`));
const isEdge = (entry: string) =>
  clientFrameworkEntries.has(entry) || edgeEntrypoints.includes(entry);
const nodeEntrypoints = allEntrypoints.filter((entry) => !isEdge(entry));

const buildJs = async ({
  entrypoints,
  banner,
  splitting = true,
}: {
  entrypoints: string[];
  banner?: string;
  splitting?: boolean;
}) => {
  const result = await Bun.build({
    banner,
    entrypoints,
    external,
    format: "esm",
    outdir: dist,
    root: srcDir,
    sourcemap: "linked",
    splitting,
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

// tsc (TypeScript 7 native compiler) emits one .d.ts (+ map) per source file.
const buildTypes = () =>
  run(["bun", "x", "tsc", "-p", "tsconfig.build.json"], "tsc");

// Reuse the existing docs-mirroring script so it stays the single source.
const copyDocs = () => run(["bun", "scripts/copy-docs.ts"], "copy-docs");

const build = async ({ docs = true } = {}) => {
  const start = performance.now();
  await rm(dist, { force: true, recursive: true });
  await buildJs({ entrypoints: nodeEntrypoints });
  await buildJs({ entrypoints: edgeEntrypoints });
  // The client framework bindings are each built standalone (no splitting) so the
  // emitted module imports only its framework and inlines its deps. React also
  // carries a `"use client"` banner on the actual module the consumer imports.
  await buildJs({ entrypoints: [vueEntry], splitting: false });
  await buildJs({ entrypoints: [svelteEntry], splitting: false });
  await buildJs({
    banner: '"use client";',
    entrypoints: [reactEntry],
    splitting: false,
  });
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
