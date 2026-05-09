"use client";

import { motion } from "motion/react";

const EASE = [0.16, 1, 0.3, 1] as const;

export const Hero = () => (
  <section className="hero mt-16">
    <motion.div
      className="flex items-center gap-3"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: EASE }}
    >
      <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
        Files SDK
      </h1>
    </motion.div>
    <motion.p
      className="text-muted-foreground text-balance leading-relaxed"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.12, duration: 0.6, ease: EASE }}
    >
      A unified storage SDK for object and blob backends — S3, Cloudflare R2,
      Vercel Blob, MinIO, DigitalOcean Spaces, GCS, Azure, Supabase,
      UploadThing. One small, honest API. Web-standards I/O. An escape hatch
      when you need the native client.
    </motion.p>
  </section>
);
