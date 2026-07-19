import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  getRegistry,
  getRegistryItem,
  getRegistryItems,
} from "../lib/registry";

// Emit the shadcn registry as static JSON under public/r/ so the built Blume
// site can serve it (Blume is a static/managed framework — no route handlers).
// `npx shadcn add <origin>/r/<name>.json` then resolves against these files.
const OUT = path.join(process.cwd(), "public", "r");

const main = async () => {
  await mkdir(OUT, { recursive: true });

  const registry = await getRegistry();
  await writeFile(
    path.join(OUT, "registry.json"),
    `${JSON.stringify(registry, null, 2)}\n`
  );

  const items = await getRegistryItems();
  await Promise.all(
    items.map(async (meta) => {
      const item = await getRegistryItem(meta.name);
      if (item) {
        await writeFile(
          path.join(OUT, `${meta.name}.json`),
          `${JSON.stringify(item, null, 2)}\n`
        );
      }
    })
  );

  // A synthetic bundle: `shadcn add .../r/all.json` installs every component in
  // one run by listing each item as a URL registryDependency. The URLs must be
  // absolute (bare names resolve against shadcn's own registry), so they point
  // at the production site regardless of where this build runs.
  const all = {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    description: "Every files-sdk registry component in one install.",
    files: [],
    name: "all",
    registryDependencies: items.map(
      (meta) => `https://files-sdk.dev/r/${meta.name}.json`
    ),
    title: "All components",
    type: "registry:block",
  };
  await writeFile(
    path.join(OUT, "all.json"),
    `${JSON.stringify(all, null, 2)}\n`
  );

  console.log(`Wrote ${items.length + 2} registry files to public/r/`);
};

await main();
