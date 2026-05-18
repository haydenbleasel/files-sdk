import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";

import { baseOptions } from "@/app/layout.config";
import { source } from "@/lib/source";

const Layout = ({ children }: { children: ReactNode }) => (
  <DocsLayout
    sidebar={{
      className: "bg-transparent! border-dotted",
      collapsible: false,
    }}
    tree={source.pageTree}
    {...baseOptions}
    links={[]}
  >
    {children}
  </DocsLayout>
);

export default Layout;
