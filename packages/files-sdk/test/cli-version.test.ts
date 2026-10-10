import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import pkg from "../package.json" with { type: "json" };
import { readPackageVersion } from "../src/cli/version.js";

const dirs: string[] = [];

// A throwaway package root holding the given manifests, keyed by path
// relative to the root.
const fixture = (manifests: Record<string, unknown>): string => {
  const root = mkdtempSync(path.join(tmpdir(), "files-sdk-version-"));
  dirs.push(root);
  for (const [rel, manifest] of Object.entries(manifests)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(manifest));
  }
  return root;
};

const moduleUrl = (root: string, rel: string): string =>
  pathToFileURL(path.join(root, rel)).href;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("reads the package version from the source tree", () => {
  expect(readPackageVersion()).toBe(pkg.version);
});

test("finds the manifest from a chunk one level under the package root", () => {
  const root = fixture({
    "package.json": { name: "files-sdk", version: "9.8.7" },
  });
  expect(readPackageVersion(moduleUrl(root, "dist/chunk-abc.js"))).toBe(
    "9.8.7"
  );
});

test("finds the manifest from an entry two levels under the package root", () => {
  const root = fixture({
    "package.json": { name: "files-sdk", version: "9.8.7" },
  });
  expect(readPackageVersion(moduleUrl(root, "dist/cli/index.js"))).toBe(
    "9.8.7"
  );
});

test("skips a nearer manifest that belongs to another package", () => {
  const root = fixture({
    "dist/package.json": { name: "something-else", version: "1.0.0" },
    "package.json": { name: "files-sdk", version: "9.8.7" },
  });
  expect(readPackageVersion(moduleUrl(root, "dist/cli/index.js"))).toBe(
    "9.8.7"
  );
});

test("skips a files-sdk manifest without a string version", () => {
  const root = fixture({
    "dist/package.json": { name: "files-sdk", version: 3 },
    "package.json": { name: "files-sdk", version: "9.8.7" },
  });
  expect(readPackageVersion(moduleUrl(root, "dist/cli/index.js"))).toBe(
    "9.8.7"
  );
});

test("throws when no candidate is the files-sdk manifest", () => {
  const root = fixture({
    "package.json": { name: "something-else", version: "1.0.0" },
  });
  const from = moduleUrl(root, "dist/chunk-abc.js");
  expect(() => readPackageVersion(from)).toThrow(
    `files-sdk: no files-sdk package.json found from ${from}`
  );
});
