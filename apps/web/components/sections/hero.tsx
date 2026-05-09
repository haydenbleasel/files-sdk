"use client";

import { motion } from "motion/react";

import { cn } from "@/lib/utils";

import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import * as icons from "./icons";

const EASE = [0.16, 1, 0.3, 1] as const;

const iconLabels: Record<keyof typeof icons, string> = {
  Akamai: "Akamai",
  AzureBlobStorage: "Azure Blob Storage",
  DigitalOcean: "DigitalOcean Spaces",
  GoogleCloudStorage: "Google Cloud Storage",
  GoogleDrive: "Google Drive",
  Hetzner: "Hetzner",
  Minio: "MinIO",
  NetlifyBlobs: "Netlify Blobs",
  OneDrive: "OneDrive",
  R2: "Cloudflare R2",
  S3: "Amazon S3",
  Storj: "Storj",
  Supabase: "Supabase Storage",
  UploadThing: "UploadThing",
  Vercel: "Vercel Blob",
  dropbox: "Dropbox",
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
    <div className="flex items-center -space-x-1">
      {iconList.map(([name, Icon], index) => {
        const restRotate = index % 2 === 0 ? 3 : -3;
        return (
          <Tooltip key={name}>
            <TooltipTrigger asChild>
              <motion.div
                initial={{ opacity: 0, rotate: 0, scale: 0.6, y: -10 }}
                animate={{
                  opacity: 1,
                  rotate: restRotate,
                  scale: 1,
                  transition: {
                    delay: 0.05 * index,
                    duration: 0.5,
                    ease: EASE,
                  },
                  y: 0,
                }}
                transition={{ duration: 0.3, ease: EASE }}
                whileHover={{ rotate: restRotate, scale: 1.05, y: -4 }}
              >
                <Icon
                  className={cn(
                    "size-6 rounded-sm ring-2 ring-background block"
                  )}
                />
              </motion.div>
            </TooltipTrigger>
            <TooltipContent>{iconLabels[name]}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  </section>
);
