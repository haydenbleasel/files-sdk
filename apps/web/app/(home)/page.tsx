import { Demo } from "@/components/demo";
import { FadeIn } from "@/components/fade-in";
import { AdapterCloud } from "@/components/sections/adapter-cloud";
import { Features } from "@/components/sections/features";
import { FinalCta } from "@/components/sections/final-cta";
import { GetStarted } from "@/components/sections/get-started";
import { Hero } from "@/components/sections/hero";
import { getLatestVersion } from "@/lib/version";

const Home = () => {
  const latestVersion = getLatestVersion();

  return (
    <>
      <Hero latestVersion={latestVersion} />
      <FadeIn>
        <AdapterCloud />
      </FadeIn>
      <FadeIn>
        <section>
          <div className="mx-auto max-w-6xl px-6 py-24 sm:py-32">
            <div>
              <p className="font-mono text-xs text-muted-foreground">
                Live snippet
              </p>
              <h2 className="mt-3 max-w-[30ch] text-4xl font-medium tracking-tight text-balance text-foreground sm:text-5xl">
                The exact same code. Any backend.
              </h2>
              <p className="mt-5 max-w-[60ch] text-lg leading-relaxed text-pretty text-muted-foreground">
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
      <FadeIn>
        <Features />
      </FadeIn>
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
