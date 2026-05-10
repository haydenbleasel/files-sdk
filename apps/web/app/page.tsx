import { Demo } from "@/components/demo";
import { FadeIn } from "@/components/fade-in";
import { MobileTableOfContents } from "@/components/mobile-table-of-contents";
import { Adapters } from "@/components/sections/adapters";
import { AiSdkTools } from "@/components/sections/ai-sdk-tools";
import { ApiReference } from "@/components/sections/api-reference";
import { CompatibilityMatrix } from "@/components/sections/compatibility-matrix";
import { Errors } from "@/components/sections/errors";
import { EscapeHatch } from "@/components/sections/escape-hatch";
import { Footer } from "@/components/sections/footer";
import { Header } from "@/components/sections/header";
import { Hero } from "@/components/sections/hero";
import { Installation } from "@/components/sections/installation";
import { QuickStart } from "@/components/sections/quick-start";
import { StoredFileType } from "@/components/sections/stored-file-type";
import { Why } from "@/components/sections/why";
import { TableOfContents } from "@/components/table-of-contents";

export default function Home() {
  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-background">
      <div className="mx-auto w-full max-w-7xl flex-1 lg:grid lg:grid-cols-[1fr_42rem_1fr]">
        <div aria-hidden className="hidden lg:block" />
        <main className="mx-auto w-full max-w-2xl border-x border-dotted px-4 sm:px-8 pt-8 pb-8">
          <Header />
          <Hero />
          <FadeIn className="lg:hidden">
            <MobileTableOfContents />
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
            <Adapters />
          </FadeIn>
          <FadeIn>
            <ApiReference />
          </FadeIn>
          <FadeIn>
            <StoredFileType />
          </FadeIn>
          <FadeIn>
            <Errors />
          </FadeIn>
          <FadeIn>
            <EscapeHatch />
          </FadeIn>
          <FadeIn>
            <AiSdkTools />
          </FadeIn>
          <FadeIn>
            <CompatibilityMatrix />
          </FadeIn>
          <FadeIn>
            <Footer />
          </FadeIn>
        </main>
        <aside className="hidden lg:block pr-8 pt-44">
          <div className="sticky top-8">
            <TableOfContents />
          </div>
        </aside>
      </div>
    </div>
  );
}
