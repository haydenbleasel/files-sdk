import { createRequire } from "node:module";

import { isObject, isString } from "../internal/is.js";

// The build puts CLI modules at different depths: the entry lands in
// `dist/cli/index.js`, but code split into a shared or lazily-loaded chunk
// lands in `dist/chunk-*.js`, one level up, and tests run everything from
// `src/cli/`. A fixed `../../package.json` is only right for some of them, so
// try each depth and keep the manifest that is actually this package's.
const MANIFEST_CANDIDATES = ["../package.json", "../../package.json"];

/**
 * The files-sdk version, read from the package's own `package.json` relative
 * to `from` (this module's URL by default). Throws if neither candidate
 * location holds the files-sdk manifest.
 */
export const readPackageVersion = (from: string = import.meta.url): string => {
  const load = createRequire(from);
  for (const candidate of MANIFEST_CANDIDATES) {
    let manifest: unknown;
    try {
      manifest = load(candidate);
    } catch {
      continue;
    }
    if (
      isObject(manifest) &&
      "name" in manifest &&
      manifest.name === "files-sdk" &&
      "version" in manifest &&
      isString(manifest.version)
    ) {
      return manifest.version;
    }
  }
  throw new Error(`files-sdk: no files-sdk package.json found from ${from}`);
};
