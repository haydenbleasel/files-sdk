import { ArrowRight, Star } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

export const FinalCta = () => (
  <section>
    <div className="mx-auto flex max-w-6xl flex-col items-center px-6 py-24 text-center sm:py-32">
      <h2 className="mx-auto max-w-[20ch] text-5xl font-medium tracking-tight text-balance text-foreground sm:text-6xl lg:text-7xl">
        Ship the storage layer once.
      </h2>
      <p className="mx-auto mt-6 max-w-[48ch] text-lg leading-relaxed text-pretty text-muted-foreground">
        Open source, MIT licensed, built around web standards. Drop in an
        adapter and forget the difference.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <Button asChild size="lg">
          <Link href="/docs">
            Read the docs
            <ArrowRight data-icon="inline-end" />
          </Link>
        </Button>
        <Button asChild size="lg" variant="ghost">
          <a
            href="https://github.com/haydenbleasel/files-sdk"
            target="_blank"
            rel="noreferrer"
          >
            <Star data-icon="inline-start" />
            Star on GitHub
          </a>
        </Button>
      </div>
      <code className="mt-10 inline-flex items-center gap-2 font-mono text-sm text-muted-foreground">
        <span className="text-muted-foreground/60">$</span>
        npm install files-sdk
      </code>
    </div>
  </section>
);
