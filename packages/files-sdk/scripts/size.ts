#!/usr/bin/env bun
import { gzipSync } from "node:zlib";

import pkg from "../package.json" with { type: "json" };

interface Row {
  entry: string;
  minified: number;
  gzipped: number;
  error?: string;
}

const peerExternals = Object.keys(pkg.peerDependencies ?? {});

const entries = Object.entries(
  pkg.exports as Record<string, { import: string }>
).map(([subpath, value]) => {
  const src = value.import
    .replace(/^\.\/dist\//u, "src/")
    .replace(/\.js$/u, ".ts");
  return {
    src,
    subpath: subpath === "." ? "files-sdk" : `files-sdk${subpath.slice(1)}`,
  };
});

const results: Row[] = [];

for (const { subpath, src } of entries) {
  try {
    const built = await Bun.build({
      entrypoints: [src],
      external: peerExternals,
      format: "esm",
      minify: true,
      sourcemap: "none",
      target: "node",
    });

    if (!built.success) {
      results.push({
        entry: subpath,
        error: built.logs.map((l) => l.message).join("; ") || "build failed",
        gzipped: 0,
        minified: 0,
      });
      continue;
    }

    let minified = 0;
    let gzipped = 0;
    for (const output of built.outputs) {
      const bytes = new Uint8Array(await output.arrayBuffer());
      minified += bytes.length;
      gzipped += gzipSync(bytes).length;
    }

    results.push({ entry: subpath, gzipped, minified });
  } catch (error) {
    results.push({
      entry: subpath,
      error: error instanceof Error ? error.message : String(error),
      gzipped: 0,
      minified: 0,
    });
  }
}

results.sort((a, b) => b.gzipped - a.gzipped);

const fmt = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const nameWidth = Math.max(...results.map((r) => r.entry.length), 5);
const minWidth = Math.max(...results.map((r) => fmt(r.minified).length), 8);
const gzWidth = Math.max(...results.map((r) => fmt(r.gzipped).length), 7);

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));

console.log(
  `${pad("Entry", nameWidth)}  ${pad("Minified", minWidth)}  ${pad("Gzipped", gzWidth)}`
);
console.log(
  `${"-".repeat(nameWidth)}  ${"-".repeat(minWidth)}  ${"-".repeat(gzWidth)}`
);

for (const row of results) {
  if (row.error) {
    console.log(
      `${pad(row.entry, nameWidth)}  ${pad("ERROR", minWidth)}  ${pad(row.error, gzWidth)}`
    );
    continue;
  }
  console.log(
    `${pad(row.entry, nameWidth)}  ${pad(fmt(row.minified), minWidth)}  ${pad(fmt(row.gzipped), gzWidth)}`
  );
}

const totalMin = results.reduce((s, r) => s + r.minified, 0);
const totalGz = results.reduce((s, r) => s + r.gzipped, 0);
console.log(
  `${"-".repeat(nameWidth)}  ${"-".repeat(minWidth)}  ${"-".repeat(gzWidth)}`
);
console.log(
  `${pad("Total", nameWidth)}  ${pad(fmt(totalMin), minWidth)}  ${pad(fmt(totalGz), gzWidth)}`
);
console.log(
  `\nNote: peer dependencies (${peerExternals.join(", ")}) are treated as external.`
);
