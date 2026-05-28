import { Demo } from "@/components/demo";
import { FadeIn } from "@/components/fade-in";
import { Capabilities } from "@/components/sections/capabilities";
import { FinalCta } from "@/components/sections/final-cta";
import { GetStarted } from "@/components/sections/get-started";
import { Hero } from "@/components/sections/hero";
import { ADAPTERS } from "@/lib/adapters";
import { getLatestVersion } from "@/lib/version";

const Home = () => {
  const latestVersion = getLatestVersion();

  return (
    <>
      <Hero adapterCount={ADAPTERS.length} latestVersion={latestVersion} />
      <FadeIn>
        <section>
          <div className="mx-auto max-w-6xl px-6 py-24">
            <div>
              <p className="font-mono text-xs text-muted-foreground">
                Live snippet
              </p>
              <h2 className="mt-3 max-w-[30ch] text-4xl font-medium tracking-tight text-balance text-foreground sm:text-5xl">
                The exact same code. Any backend.
              </h2>
              <p className="mt-5 max-w-[60ch] text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
                Switch the adapter, keep every call site. Here's the same
                upload, download, head, list, and delete sequence across five
                providers.
              </p>
            </div>
            <div className="mt-12">
              <Demo />
            </div>
          </div>
        </section>
      </FadeIn>
      <Capabilities />
      <FadeIn>
        <GetStarted />
      </FadeIn>
      <FadeIn>
        <FinalCta />
      </FadeIn>
    </>
  );
};

export default Home;
