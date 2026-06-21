"use client";

import type { FileVersion, UseFilesResult } from "files-sdk/react";
import { HistoryIcon, Loader2Icon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface VersionHistoryProps {
  /** A `useFiles()` instance backed by a gateway with the `versioning()` plugin. */
  files: UseFilesResult;
  /** The key whose history to show. */
  fileKey: string;
  /** Called after a successful restore. */
  onRestored?: (file: { key: string }) => void;
  className?: string;
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

/**
 * A version timeline for one key, backed by the `versioning()` plugin. Lists the
 * saved snapshots (newest first) and restores any of them through the same
 * `useFiles()` instance. Restoring snapshots the current bytes first, so it's
 * itself reversible.
 */
export const VersionHistory = ({
  files,
  fileKey,
  onRestored,
  className,
}: VersionHistoryProps) => {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [restoring, setRestoring] = useState<string>();

  const filesRef = useRef(files);
  filesRef.current = files;

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      setVersions(await filesRef.current.versions(fileKey));
    } catch {
      // The hook mirrors the error to `files.error` for display.
    } finally {
      setIsLoading(false);
    }
  }, [fileKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restore = useCallback(
    async (versionId: string) => {
      setRestoring(versionId);
      try {
        const file = await filesRef.current.restoreVersion(fileKey, versionId);
        await refresh();
        onRestored?.(file);
      } catch {
        // Mirrored to `files.error`.
      } finally {
        setRestoring(undefined);
      }
    },
    [fileKey, refresh, onRestored]
  );

  if (isLoading && !versions.length) {
    return (
      <div
        className={cn(
          "flex items-center justify-center gap-2 p-8 text-muted-foreground text-sm",
          className
        )}
      >
        <Loader2Icon className="size-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (!versions.length) {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-1 p-8 text-center text-muted-foreground text-sm",
          className
        )}
      >
        <HistoryIcon className="size-6" />
        No version history yet.
      </div>
    );
  }

  return (
    <ol className={cn("flex flex-col gap-2", className)}>
      {versions.map((version, index) => (
        <li
          className="flex items-center gap-3 rounded-lg border border-border p-2"
          key={version.versionId}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
            <HistoryIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-sm">
              {new Date(version.lastModified).toLocaleString()}
              {index === 0 && (
                <span className="ml-2 text-muted-foreground text-xs">
                  latest
                </span>
              )}
            </p>
            <p className="text-muted-foreground text-xs">
              {formatBytes(version.size)}
              {version.etag ? ` · ${version.etag.slice(0, 12)}` : ""}
            </p>
          </div>
          <Button
            disabled={restoring !== undefined}
            onClick={() => void restore(version.versionId)}
            size="sm"
            type="button"
            variant="outline"
          >
            {restoring === version.versionId ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <RotateCcwIcon />
            )}
            Restore
          </Button>
        </li>
      ))}
    </ol>
  );
};
