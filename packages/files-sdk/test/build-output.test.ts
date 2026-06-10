import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import pkg from "../package.json" with { type: "json" };

// Regression guard for #67: the published CLI bundle must never statically
// import an optional peer dependency. The registry lazy-loads providers via
// `await import(...)`, but a bundler config change (e.g. `splitting: false`)
// can inline those modules and hoist their external imports to the top level,
// making `files --help` crash unless every optional peer is installed. This
// walks the transitive *static* import graph of dist/cli/index.js — dynamic
// imports are exactly the lazy boundary, so they're not followed.

// The cold-start build (tsgo included) can take a while on CI runners.
const COLD_BUILD_TIMEOUT_MS = 120_000;

const pkgRoot = resolve(import.meta.dirname, "..");
const distDir = resolve(pkgRoot, "dist");
const cliBundle = resolve(distDir, "cli/index.js");

const optionalPeers = Object.entries(pkg.peerDependenciesMeta ?? {})
  .filter(([, meta]) => (meta as { optional?: boolean }).optional)
  .map(([name]) => name);

/** Collect every external specifier reachable from `entry` via static imports. */
const staticExternals = (entry: string): Set<string> => {
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const visited = new Set<string>();
  const externals = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file)) {
      continue;
    }
    visited.add(file);
    // The CLI entry starts with a shebang, which the transpiler rejects.
    const source = readFileSync(file, "utf-8").replace(/^#![^\n]*\n/u, "");
    for (const imp of transpiler.scanImports(source)) {
      if (imp.kind !== "import-statement") {
        continue;
      }
      if (imp.path.startsWith(".")) {
        queue.push(resolve(dirname(file), imp.path));
      } else {
        externals.add(imp.path);
      }
    }
  }
  return externals;
};

test(
  "CLI bundle never statically imports an optional peer dependency (#67)",
  () => {
    // CI's test job runs `bun test` on a fresh checkout without building, so
    // produce dist/ with the real build script when the bundle is absent —
    // the guard must scan output of the actual build config, not a replica.
    if (!existsSync(cliBundle)) {
      const proc = Bun.spawnSync(["bun", "scripts/build.ts"], {
        cwd: pkgRoot,
        stderr: "pipe",
        stdout: "pipe",
      });
      if (!proc.success) {
        throw new Error(`build failed:\n${proc.stderr.toString()}`);
      }
    }

    // Sanity: an empty list would make the assertion below pass vacuously.
    expect(optionalPeers.length).toBeGreaterThan(0);

    const externals = staticExternals(cliBundle);
    const offenders = optionalPeers.filter((peer) =>
      [...externals].some(
        (specifier) => specifier === peer || specifier.startsWith(`${peer}/`)
      )
    );
    expect(offenders).toEqual([]);
  },
  COLD_BUILD_TIMEOUT_MS
);
