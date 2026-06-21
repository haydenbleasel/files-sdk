import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface RegistryFileRef {
  path: string;
  type: string;
  target?: string;
}

export interface RegistryItemMeta {
  name: string;
  type: string;
  title?: string;
  description?: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files: RegistryFileRef[];
}

export interface RegistryIndex {
  $schema: string;
  name: string;
  homepage?: string;
  items: RegistryItemMeta[];
}

export type ResolvedRegistryItem = Omit<RegistryItemMeta, "files"> & {
  $schema: string;
  files: (RegistryFileRef & { content: string })[];
};

// Read from disk rather than `import`ing the JSON — the source `.tsx` files are
// read the same way, and it sidesteps the bundler's JSON-alias resolution.
const loadRegistry = async (): Promise<RegistryIndex> => {
  const raw = await readFile(join(process.cwd(), "registry.json"), "utf-8");
  return JSON.parse(raw) as RegistryIndex;
};

export const getRegistryItems = async (): Promise<RegistryItemMeta[]> => {
  const registry = await loadRegistry();
  return registry.items;
};

/** The registry index (shadcn `registry.json` shape) — metadata + file paths, no content. */
export const getRegistry = async (): Promise<RegistryIndex> => {
  const registry = await loadRegistry();
  return {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    homepage: registry.homepage,
    items: registry.items,
    name: registry.name,
  };
};

/**
 * A single resolved registry item (shadcn `registry-item.json` shape) with each
 * file's `content` inlined from disk. Returns `null` for an unknown name.
 */
export const getRegistryItem = async (
  name: string
): Promise<ResolvedRegistryItem | null> => {
  const registry = await loadRegistry();
  const item = registry.items.find((entry) => entry.name === name);
  if (!item) {
    return null;
  }
  const files = await Promise.all(
    item.files.map(async (file) => ({
      ...file,
      // Scope the dynamic read to the static `registry/` subfolder. `file.path`
      // is always `registry/...` (see registry.json), so re-expressing it with a
      // literal `"registry"` segment lets Node File Trace bundle just that
      // directory instead of conservatively tracing the whole project.
      content: await readFile(
        join(process.cwd(), "registry", file.path.replace(/^registry\//u, "")),
        "utf-8"
      ),
    }))
  );
  return {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    ...item,
    files,
  };
};
