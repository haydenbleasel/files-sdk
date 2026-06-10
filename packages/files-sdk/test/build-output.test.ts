import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import pkg from "../package.json" with { type: "json" };

// Regression guard for #67: the published CLI bundle must never statically
// import an optional peer dependency. The registry lazy-loads providers via
// `await import(...)`, but a bundler config change (e.g. `splitting: false`)
// can inline those modules and hoist their external imports to the top level,
// making `files --help` crash unless every optional peer is installed. This
// walks the transitive *static* import graph of dist/cli/index.js — dynamic
// imports are exactly the lazy boundary, so they're not followed.

const distDir = resolve(import.meta.dirname, "../dist");

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

test("CLI bundle never statically imports an optional peer dependency (#67)", () => {
  // Sanity: an empty list would make the assertion below pass vacuously.
  expect(optionalPeers.length).toBeGreaterThan(0);

  const externals = staticExternals(resolve(distDir, "cli/index.js"));
  const offenders = optionalPeers.filter((peer) =>
    [...externals].some(
      (specifier) => specifier === peer || specifier.startsWith(`${peer}/`)
    )
  );
  expect(offenders).toEqual([]);
});
