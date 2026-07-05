"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

export interface CodeTab {
  label: string;
  /** Pre-highlighted HTML from Blume's `highlightCode` (built at page build). */
  html: string;
}

interface CodeTabsProps {
  tabs: CodeTab[];
}

// A small client island: switches between pre-highlighted code panes. The HTML
// is produced at build time in index.astro, so there's no client-side Shiki.
export default function CodeTabs({ tabs }: CodeTabsProps) {
  const [active, setActive] = useState(0);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap gap-1 border-b border-border px-2 pt-2">
        {tabs.map((tab, i) => (
          <button
            className={cn(
              "rounded-md px-3 py-1.5 font-mono text-xs transition-colors",
              i === active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
            key={tab.label}
            onClick={() => setActive(i)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time Shiki HTML
        dangerouslySetInnerHTML={{ __html: tabs[active].html }}
        className="prose flush-code max-w-none"
      />
    </div>
  );
}
