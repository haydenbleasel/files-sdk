import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import type { ReactNode } from "react";

import { baseOptions } from "@/app/layout.config";
import { source } from "@/lib/source";

const Layout = ({ children }: { children: ReactNode }) => (
  <DocsLayout
    sidebar={{
      className: "sm:bg-transparent! border-r! xl:border-r-0!",
      collapsible: false,
    }}
    tree={source.pageTree}
    {...baseOptions}
    nav={{
      ...baseOptions.nav,
      mode: "top",
    }}
    links={[]}
  >
    {children}
  </DocsLayout>
);

export default Layout;
