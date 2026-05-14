import type { Metadata } from "next";

import { FadeIn } from "@/components/fade-in";
import { MobileTableOfContents } from "@/components/mobile-table-of-contents";
import { AiTools } from "@/components/sections/ai-tools";
import { PageHero } from "@/components/sections/page-hero";
import { AI_SECTIONS, flattenSections } from "@/lib/sections";

const mobileSections = flattenSections(AI_SECTIONS);

export const metadata: Metadata = {
  alternates: { canonical: "/ai" },
  description:
    "First-class tool factories for OpenAI, the Vercel AI SDK, and the Claude Agent SDK - same eight operations, Zod-validated, approval-gated by default.",
  openGraph: { url: "/ai" },
  title: "AI tools",
};

const AiPage = () => (
  <>
    <PageHero
      title="AI tools"
      description="Tool factories for OpenAI, Vercel AI SDK, and Claude Agent SDK. Same eight operations, Zod-validated, approval-gated by default. Each is tree-shakeable with its own peer deps."
    />
    <FadeIn className="lg:hidden">
      <MobileTableOfContents sections={mobileSections} />
    </FadeIn>
    <FadeIn>
      <AiTools />
    </FadeIn>
  </>
);

export default AiPage;
