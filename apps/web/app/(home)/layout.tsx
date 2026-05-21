import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactNode } from "react";

import { baseOptions } from "@/app/layout.config";
import { Footer } from "@/components/sections/footer";

const Layout = ({ children }: { children: ReactNode }) => (
  <HomeLayout {...baseOptions}>
    {children}
    <Footer />
  </HomeLayout>
);

export default Layout;
