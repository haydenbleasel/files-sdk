import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import pkg from "../package.json" with { type: "json" };

// Regression guard for #67: the published CLI bundle must never statically
// import an optional peer dependency. The registry lazy-loads providers via
// `await import(...)`, but a bundler config change (e.g. `splitting: false`)
// can inline those modules and hoist their external imports to the top level,
// making `files --help` crash unless every optional peer is installed. This
// walks the transitive *static* import graph of dist/cli/index.js — dynamic
// imports are exactly the lazy boundary, so they're not followed.

// The cold-start build (tsc included) can take a while on CI runners.
const COLD_BUILD_TIMEOUT_MS = 120_000;

const pkgRoot = path.resolve(import.meta.dirname, "..");
const distDir = path.resolve(pkgRoot, "dist");
const cliBundle = path.resolve(distDir, "cli/index.js");
const loaderBundle = path.resolve(distDir, "loader/index.js");

const optionalPeers = Object.entries(pkg.peerDependenciesMeta ?? {})
  .filter(([, meta]) => (meta as { optional?: boolean }).optional)
  .map(([name]) => name);

/**
 * Collect every external specifier that appears in a *static* import
 * reachable from `entry`. By default the walk stops at dynamic imports —
 * they are the lazy boundary for the Node CLI. `followDynamic` also walks
 * through relative dynamic imports (still only recording static externals):
 * that is the consumer-bundler view, where dynamically-reached chunks are
 * resolved at build time too (#105).
 */
const staticExternals = (
  entry: string,
  { followDynamic = false } = {}
): Set<string> => {
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
      const isStatic = imp.kind === "import-statement";
      if (!(isStatic || (followDynamic && imp.kind === "dynamic-import"))) {
        continue;
      }
      if (imp.path.startsWith(".")) {
        queue.push(path.resolve(path.dirname(file), imp.path));
      } else if (isStatic) {
        externals.add(imp.path);
      }
    }
  }
  return externals;
};

/** Optional peers reachable from `bundle` via static imports — must be []. */
const offendingOptionalPeers = (
  bundle: string,
  opts?: { followDynamic?: boolean }
): string[] => {
  const externals = staticExternals(bundle, opts);
  return optionalPeers.filter((peer) =>
    [...externals].some(
      (specifier) => specifier === peer || specifier.startsWith(`${peer}/`)
    )
  );
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

    expect(offendingOptionalPeers(cliBundle)).toEqual([]);
  },
  COLD_BUILD_TIMEOUT_MS
);

const ensureBuilt = () => {
  if (!(existsSync(cliBundle) && existsSync(loaderBundle))) {
    const proc = Bun.spawnSync(["bun", "scripts/build.ts"], {
      cwd: pkgRoot,
      stderr: "pipe",
      stdout: "pipe",
    });
    if (!proc.success) {
      throw new Error(`build failed:\n${proc.stderr.toString()}`);
    }
  }
};

test(
  "public loader exports loadFiles without eager optional peer imports",
  async () => {
    ensureBuilt();
    const mod = (await import(loaderBundle)) as Record<string, unknown>;
    expect(typeof mod.loadFiles).toBe("function");

    expect(offendingOptionalPeers(loaderBundle)).toEqual([]);
  },
  COLD_BUILD_TIMEOUT_MS
);

// Regression guard for #105: consumer bundlers (rolldown-vite + the
// Cloudflare Vite plugin, …) resolve the whole module graph at build time,
// including chunks reached only through dynamic imports — so a *static*
// `@aws-sdk/*` import anywhere behind the r2 entry's lazy `import()` boundary
// hard-errors (MISSING_EXPORT) against the bundler's optional-peer
// placeholder, even though that code never runs on the binding/fetch paths.
// Walk the r2 graph the way a bundler does — through dynamic imports — and
// require that optional peers only ever appear as dynamic specifiers.
test(
  "r2 bundle never statically imports an optional peer, even across dynamic chunks (#105)",
  () => {
    ensureBuilt();
    const r2Bundle = path.resolve(distDir, "r2/index.js");
    expect(offendingOptionalPeers(r2Bundle, { followDynamic: true })).toEqual(
      []
    );
  },
  COLD_BUILD_TIMEOUT_MS
);

// The firebase-storage entry reaches `firebase-admin` only through the
// `createRequire` loader — invisible to bundlers — so an injected `Bucket`
// works without the peer being resolvable. Guard against a top-level
// `firebase-admin` import creeping back into the graph.
test(
  "firebase-storage bundle never statically imports an optional peer, even across dynamic chunks",
  () => {
    ensureBuilt();
    const firebaseBundle = path.resolve(distDir, "firebase-storage/index.js");
    expect(
      offendingOptionalPeers(firebaseBundle, { followDynamic: true })
    ).toEqual([]);
  },
  COLD_BUILD_TIMEOUT_MS
);

test(
  "react bundle is a `use client` module importing only react",
  () => {
    ensureBuilt();
    const reactBundle = path.resolve(distDir, "react/index.js");
    expect(readFileSync(reactBundle, "utf-8").startsWith('"use client";')).toBe(
      true
    );
    const externals = [...staticExternals(reactBundle)];
    expect(externals.filter((e) => e !== "react")).toEqual([]);
  },
  COLD_BUILD_TIMEOUT_MS
);

test(
  "gateway, client and next bundles have no node: static imports",
  () => {
    ensureBuilt();
    for (const sub of [
      "api/index.js",
      "client/index.js",
      "hono/index.js",
      "next/index.js",
    ]) {
      const externals = [...staticExternals(path.resolve(distDir, sub))];
      expect(externals.filter((e) => e.startsWith("node:"))).toEqual([]);
    }
  },
  COLD_BUILD_TIMEOUT_MS
);

test(
  "framework bundles import only their framework",
  () => {
    ensureBuilt();
    // vue imports only `vue`; svelte uses an inline store + a type-only
    // `Readable`, so it imports nothing external at all.
    const vue = [...staticExternals(path.resolve(distDir, "vue/index.js"))];
    expect(vue.filter((e) => e !== "vue")).toEqual([]);
    const svelte = [
      ...staticExternals(path.resolve(distDir, "svelte/index.js")),
    ];
    expect(svelte).toEqual([]);
  },
  COLD_BUILD_TIMEOUT_MS
);

// A pure named re-export entry (`export { x } from "./y"`) is stripped by Bun to
// an unbound stub — the runtime export is missing even though the .d.ts is fine,
// and `src`-importing tests never catch it. This imports each shipped bundle and
// asserts the public factory/hook actually resolves to a function.
test(
  "public app-layer bundles export bound runtime values",
  async () => {
    ensureBuilt();
    const cases: [string, string[]][] = [
      ["client", ["createFilesClient", "aggregate"]],
      ["api", ["createFilesRouter"]],
      ["next", ["createRouteHandler"]],
      ["hono", ["createRouteHandler"]],
      ["express", ["createRouteHandler"]],
      ["react", ["useFiles", "useList", "useFile", "useSearch"]],
      ["vue", ["useFiles", "useList", "useFile", "useSearch"]],
      ["svelte", ["useFiles", "useList", "useFile", "useSearch"]],
    ];
    for (const [sub, names] of cases) {
      // eslint-disable-next-line no-await-in-loop -- imports each built subpath and asserts its exports in turn
      const mod = (await import(
        path.resolve(distDir, sub, "index.js")
      )) as Record<string, unknown>;
      for (const name of names) {
        expect(typeof mod[name]).toBe("function");
      }
    }
  },
  COLD_BUILD_TIMEOUT_MS
);
