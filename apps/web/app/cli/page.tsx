import type { Metadata } from "next";

import { FadeIn } from "@/components/fade-in";
import { MobileTableOfContents } from "@/components/mobile-table-of-contents";
import { Cli } from "@/components/sections/cli";
import { PageHero } from "@/components/sections/page-hero";
import { CLI_SECTIONS, flattenSections } from "@/lib/sections";

const mobileSections = flattenSections(CLI_SECTIONS);

export const metadata: Metadata = {
  alternates: { canonical: "/cli" },
  description:
    "Agent-friendly CLI for files-sdk. One binary, every provider, JSON-by-default output, stdin/stdout streaming, and a built-in MCP server.",
  openGraph: { url: "/cli" },
  title: "CLI",
};

const CliPage = () => (
  <>
    <PageHero
      title="CLI"
      description="One binary for every provider. JSON-by-default output, stdin/stdout streaming, dry-run, and a stdio MCP server — built for agents and scripts."
    />
    <FadeIn className="lg:hidden">
      <MobileTableOfContents sections={mobileSections} />
    </FadeIn>
    <FadeIn>
      <Cli />
    </FadeIn>
  </>
);

export default CliPage;
