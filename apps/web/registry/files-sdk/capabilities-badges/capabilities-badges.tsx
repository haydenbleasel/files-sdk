"use client";

import type { AdapterCapabilities } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";
import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface CapabilitiesBadgesProps {
  /** A `useFiles()` instance — capabilities are read through it. */
  files: UseFilesResult;
  /** Hide capabilities the adapter does not support instead of dimming them. */
  supportedOnly?: boolean;
  className?: string;
}

/** Render a seconds duration as a compact `7d` / `4h` / `30m` label. */
const formatDuration = (seconds: number): string => {
  const units: [number, string][] = [
    [86_400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [size, suffix] of units) {
    if (seconds % size === 0 || seconds >= size) {
      return `${Math.round(seconds / size)}${suffix}`;
    }
  }
  return `${seconds}s`;
};

const describe = (
  caps: AdapterCapabilities
): { label: string; supported: boolean }[] => [
  { label: "Folder listing", supported: caps.delimiter },
  {
    label: caps.signedUrl.maxExpiresIn
      ? `Signed URLs (max ${formatDuration(caps.signedUrl.maxExpiresIn)})`
      : "Signed URLs",
    supported: caps.signedUrl.supported,
  },
  { label: "Range reads", supported: caps.rangeRead },
  { label: "Multipart uploads", supported: caps.multipart },
  { label: "Upload progress", supported: caps.uploadProgress },
  { label: "Server-side copy", supported: caps.serverSideCopy },
  { label: "Custom metadata", supported: caps.metadata },
  { label: "Cache-Control", supported: caps.cacheControl },
];

/**
 * Reads `capabilities()` and renders each adapter feature as a badge — a
 * supported check or an unsupported cross. Useful for surfacing what the
 * configured storage backend can do, and a building block for gating actions
 * (hide a "share link" button when `Signed URLs` is unsupported, etc.).
 */
export const CapabilitiesBadges = ({
  files,
  supportedOnly = false,
  className,
}: CapabilitiesBadgesProps) => {
  const [caps, setCaps] = useState<AdapterCapabilities>();
  const [isLoading, setIsLoading] = useState(true);

  const filesRef = useRef(files);
  filesRef.current = files;

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setIsLoading(true);
      try {
        const result = await filesRef.current.capabilities();
        if (!cancelled) {
          setCaps(result);
        }
      } catch {
        // The hook mirrors the error to `files.error` for display.
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading && !caps) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-muted-foreground text-sm",
          className
        )}
      >
        <Loader2Icon className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (!caps) {
    return null;
  }

  const rows = describe(caps).filter((row) => !supportedOnly || row.supported);

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {rows.map((row) => (
        <Badge
          key={row.label}
          variant={row.supported ? "secondary" : "outline"}
        >
          {row.supported ? (
            <CheckIcon className="text-emerald-600 dark:text-emerald-400" />
          ) : (
            <XIcon className="text-muted-foreground" />
          )}
          <span className={cn(!row.supported && "text-muted-foreground")}>
            {row.label}
          </span>
        </Badge>
      ))}
    </div>
  );
};
