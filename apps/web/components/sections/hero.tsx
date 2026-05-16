"use client";

import { motion } from "motion/react";

import { cn } from "@/lib/utils";

import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import * as icons from "./icons";

const EASE = [0.16, 1, 0.3, 1] as const;

const iconLabels: Record<keyof typeof icons, string> = {
  AzureBlobStorage: "Azure Blob Storage",
  Box: "Box",
  BunnyStorage: "Bunny Storage",
  DigitalOcean: "DigitalOcean Spaces",
  Dropbox: "Dropbox",
  GoogleCloudStorage: "Google Cloud Storage",
  GoogleDrive: "Google Drive",
  Minio: "MinIO",
  NetlifyBlobs: "Netlify Blobs",
  OneDrive: "OneDrive",
  R2: "Cloudflare R2",
  S3: "Amazon S3",
  Supabase: "Supabase Storage",
  UploadThing: "UploadThing",
  Vercel: "Vercel Blob",
};

const iconList = Object.entries(icons) as [
  keyof typeof icons,
  (typeof icons)[keyof typeof icons],
][];

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
      A unified storage SDK for object and blob backends. One small, honest API.
      Web-standards I/O. An escape hatch when you need the native client.
    </motion.p>
    <div className="flex items-center -space-x-2 sm:-space-x-1">
      {iconList.map(([name, Icon], index) => {
        const restRotate = index % 2 === 0 ? 3 : -3;
        return (
          <Tooltip key={name}>
            <TooltipTrigger asChild>
              <motion.div
                initial={{ opacity: 0, scale: 0.6, y: -10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{
                  delay: 0.05 * index,
                  duration: 0.5,
                  ease: EASE,
                }}
              >
                <motion.div
                  initial={{ rotate: 0 }}
                  animate={{ rotate: restRotate }}
                  transition={{ duration: 0.3, ease: EASE }}
                  whileHover={{ rotate: restRotate, scale: 1.05, y: -4 }}
                >
                  <Icon
                    className={cn(
                      "size-6 rounded-sm ring-2 ring-background block"
                    )}
                  />
                </motion.div>
              </motion.div>
            </TooltipTrigger>
            <TooltipContent>{iconLabels[name]}</TooltipContent>
          </Tooltip>
        );
      })}
      <motion.span
        className="text-muted-foreground text-xs ml-3"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          delay: 0.05 * iconList.length,
          duration: 0.5,
          ease: EASE,
        }}
      >
        + 23 more
      </motion.span>
    </div>
  </section>
);
