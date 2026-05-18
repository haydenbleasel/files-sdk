"use client";

import { ArrowRight, Star } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";

import { Button } from "@/components/ui/button";

import * as icons from "./icons";

const EASE = [0.16, 1, 0.3, 1] as const;

const iconList = Object.entries(icons) as [
  keyof typeof icons,
  (typeof icons)[keyof typeof icons],
][];

const marqueeList = [...iconList, ...iconList];

export const Hero = () => (
  <section className="relative overflow-hidden">
    <div className="mx-auto flex max-w-5xl flex-col items-center px-6 pt-24 pb-20 text-center sm:pt-32 sm:pb-24 lg:pt-40 lg:pb-28">
      <motion.p
        className="font-mono text-xs text-muted-foreground"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        <span className="mr-1.5 inline-block size-1.5 translate-y-[-1px] rounded-full bg-emerald-500 align-middle" />
        v1.4
      </motion.p>

      <motion.h1
        className="mt-8 max-w-[18ch] text-5xl font-medium tracking-tight text-balance text-foreground sm:text-7xl lg:text-8xl"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.7, ease: EASE }}
      >
        One SDK. Every storage.
      </motion.h1>

      <motion.p
        className="mt-7 max-w-[48ch] text-lg leading-relaxed text-pretty text-muted-foreground sm:text-xl"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18, duration: 0.6, ease: EASE }}
      >
        A unified storage SDK for object and blob backends. One small API, web
        standards, and an escape hatch when you need the native client.
      </motion.p>

      <motion.div
        className="mt-10 flex flex-wrap items-center justify-center gap-3"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.26, duration: 0.6, ease: EASE }}
      >
        <Button asChild size="lg">
          <Link href="/docs">
            Get started
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
      </motion.div>

      <motion.code
        className="mt-8 inline-flex items-center gap-2 font-mono text-sm text-muted-foreground"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.34, duration: 0.5, ease: EASE }}
      >
        <span className="text-muted-foreground/60">$</span>
        npm install files-sdk
      </motion.code>
    </div>

    <motion.div
      className="relative mx-auto max-w-6xl px-6 pb-24 sm:pb-32"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.4, duration: 0.7, ease: EASE }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-background to-transparent"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-background to-transparent"
      />
      <div className="overflow-hidden">
        <div className="flex w-max animate-[marquee_40s_linear_infinite] items-center gap-10">
          {marqueeList.map(([name, Icon], i) => (
            <Icon
              key={`${name}-${i}`}
              className="size-9 shrink-0 rounded opacity-50 grayscale transition hover:opacity-100 hover:grayscale-0"
            />
          ))}
        </div>
      </div>
      <p className="mt-8 text-center font-mono text-xs text-muted-foreground">
        and 26 more —{" "}
        <Link
          href="/adapters"
          className="text-foreground underline-offset-4 hover:underline"
        >
          see every adapter →
        </Link>
      </p>
    </motion.div>
  </section>
);
