"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

const COMMAND = "npm install files-sdk";

interface InstallCommandProps {
  className?: string;
}

export const InstallCommand = ({ className }: InstallCommandProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard unavailable — silently ignore
    }
  };

  return (
    <button
      aria-label={copied ? "Copied" : "Copy install command"}
      className={cn(
        "group inline-flex h-10 items-center gap-3 rounded-4xl border border-border bg-input/30 px-4 font-mono text-sm text-foreground transition-colors hover:bg-input/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        className
      )}
      onClick={handleCopy}
      type="button"
    >
      <span aria-hidden className="text-muted-foreground/60">
        $
      </span>
      <span>{COMMAND}</span>
      <span
        aria-hidden
        className="text-muted-foreground transition-colors group-hover:text-foreground"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </span>
    </button>
  );
};
