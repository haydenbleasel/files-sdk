import { Demo } from "@/components/demo";
import { FadeIn } from "@/components/fade-in";
import { MobileTableOfContents } from "@/components/mobile-table-of-contents";
import { CompatibilityMatrix } from "@/components/sections/compatibility-matrix";
import { Hero } from "@/components/sections/hero";
import { Installation } from "@/components/sections/installation";
import { QuickStart } from "@/components/sections/quick-start";
import { Why } from "@/components/sections/why";
import { flattenSections, HOME_SECTIONS } from "@/lib/sections";

const mobileSections = flattenSections(HOME_SECTIONS);

const Home = () => (
  <>
    <Hero />
    <FadeIn className="lg:hidden">
      <MobileTableOfContents sections={mobileSections} />
    </FadeIn>
    <FadeIn>
      <Demo />
    </FadeIn>
    <FadeIn>
      <Why />
    </FadeIn>
    <FadeIn>
      <Installation />
    </FadeIn>
    <FadeIn>
      <QuickStart />
    </FadeIn>
    <FadeIn>
      <CompatibilityMatrix />
    </FadeIn>
  </>
);

export default Home;
