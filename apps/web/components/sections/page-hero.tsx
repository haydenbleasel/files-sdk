"use client";

import { motion } from "motion/react";

const EASE = [0.16, 1, 0.3, 1] as const;

interface PageHeroProps {
  title: string;
  description?: string;
}

export const PageHero = ({ title, description }: PageHeroProps) => (
  <section className="hero mt-16">
    <motion.div
      className="flex items-center gap-3"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE }}
    >
      <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
    </motion.div>
    {description ? (
      <motion.p
        className="text-muted-foreground text-balance leading-relaxed"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.12, duration: 0.6, ease: EASE }}
      >
        {description}
      </motion.p>
    ) : null}
  </section>
);
