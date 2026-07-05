"use client";

import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";

import { InstallCommand } from "@/components/install-command";
import { Button } from "@/components/ui/button";

import * as icons from "./icons";

const EASE = [0.16, 1, 0.3, 1] as const;

const iconList = Object.entries(icons) as [
  keyof typeof icons,
  (typeof icons)[keyof typeof icons],
][];

const marqueeList = [...iconList, ...iconList];

interface HeroProps {
  adapterCount: number;
  latestVersion: string;
}

export const Hero = ({ adapterCount, latestVersion }: HeroProps) => (
  <section className="relative overflow-hidden">
    <div className="mx-auto flex max-w-5xl flex-col items-center px-6 pt-24 pb-20 text-center sm:pt-32 sm:pb-24 lg:pt-40 lg:pb-28">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        <a
          href={`https://github.com/haydenbleasel/files-sdk/releases/tag/${encodeURIComponent(
            `files-sdk@${latestVersion}`
          )}`}
          rel="noreferrer"
          target="_blank"
          className="group inline-flex items-center gap-2 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
          Latest update — v{latestVersion} released
          <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
        </a>
      </motion.div>

      <motion.h1
        className="mt-8 max-w-[18ch] text-[2.5rem]/[1.05] font-medium tracking-tight text-balance text-foreground sm:text-7xl lg:text-8xl"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.7, ease: EASE }}
      >
        Write once. Store anywhere.
      </motion.h1>

      <motion.p
        className="mt-7 max-w-[62ch] text-base leading-relaxed text-pretty text-muted-foreground sm:text-xl"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18, duration: 0.6, ease: EASE }}
      >
        A unified SDK for S3, R2, GCS, Azure, and every other object or blob
        store. One small API, web standards, and an escape hatch when you need
        the native client.
      </motion.p>

      <motion.div
        className="mt-10 flex flex-wrap items-center justify-center gap-3"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.26, duration: 0.6, ease: EASE }}
      >
        <InstallCommand />
        <Button asChild size="lg" variant="ghost">
          <a href="/docs/api">
            Read the docs
            <ArrowRight data-icon="inline-end" />
          </a>
        </Button>
      </motion.div>
    </div>

    <motion.div
      className="relative mx-auto max-w-6xl px-6 pb-24 sm:pb-32"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.4, duration: 0.7, ease: EASE }}
    >
      <div className="overflow-x-clip py-2 [-webkit-mask-image:linear-gradient(to_right,transparent,#000_10%,#000_90%,transparent)] [mask-image:linear-gradient(to_right,transparent,#000_10%,#000_90%,transparent)]">
        <div className="flex w-max animate-[marquee_40s_linear_infinite] items-center gap-7 sm:gap-10">
          {marqueeList.map(([name, Icon], i) => (
            <Icon
              key={`${name}-${i}`}
              className="size-10 shrink-0 rounded transition-transform duration-200 hover:-translate-y-1 sm:size-14"
            />
          ))}
        </div>
      </div>
      <p className="mt-8 text-center font-mono text-xs text-muted-foreground">
        and {adapterCount - iconList.length} more —{" "}
        <a
          href="/docs/adapters"
          className="text-foreground underline-offset-4 hover:underline"
        >
          see every adapter →
        </a>
      </p>
    </motion.div>
  </section>
);
