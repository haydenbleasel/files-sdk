import { Demo } from "@/components/demo";
import { Adapters } from "@/components/sections/adapters";
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

export default function Home() {
  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-background">
      <main className="mx-auto w-full max-w-2xl flex-1 border-x border-dotted px-4 sm:px-8 pt-8 pb-8">
        <Header />
        <Hero />
        <Demo />
        <Why />
        <Installation />
        <QuickStart />
        <Adapters />
        <ApiReference />
        <StoredFileType />
        <Errors />
        <EscapeHatch />
        <CompatibilityMatrix />
        <Footer />
      </main>
    </div>
  );
}
