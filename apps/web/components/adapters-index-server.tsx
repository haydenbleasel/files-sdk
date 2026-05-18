import { source } from "@/lib/source";

import { AdaptersIndex } from "./adapters-index";
import type { AdaptersIndexEntry } from "./adapters-index";

export const AdaptersIndexServer = () => {
  const adapters: AdaptersIndexEntry[] = source
    .getPages()
    .filter((page) => page.slugs.length === 2 && page.slugs[0] === "adapters")
    .map((page) => ({
      description: page.data.description ?? "",
      name: page.data.title,
      slug: page.slugs[1],
    }));

  return <AdaptersIndex adapters={adapters} />;
};
