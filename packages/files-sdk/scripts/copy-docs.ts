#!/usr/bin/env bun
import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";

// Bundle the documentation MDX into the published package so consumers can read
// version-matched docs from node_modules/files-sdk/docs. Source of truth is the
// web app's content; this mirrors it into the package root at build time.
const here = import.meta.dirname;
const src = path.resolve(here, "../../../apps/web/docs");
const dest = path.resolve(here, "../docs");

try {
  await stat(src);
} catch {
  throw new Error(`copy-docs: source docs not found at ${src}`);
}

await rm(dest, { force: true, recursive: true });
await cp(src, dest, { recursive: true });

console.log(`copy-docs: copied ${src} -> ${dest}`);
