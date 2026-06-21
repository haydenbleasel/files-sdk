"use client";

import type { StoredFile } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";
import {
  DownloadIcon,
  FileIcon,
  Loader2Icon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface FileListProps {
  /** A `useFiles()` instance — lists, downloads and deletes through it. */
  files: UseFilesResult;
  /** Only show keys under this prefix (folder), e.g. `"docs/"`. */
  prefix?: string;
  /** Endpoint for inline image thumbnails (the gateway download proxy). Default `"/api/files"`. */
  endpoint?: string;
  /** Hide the delete action. */
  readOnly?: boolean;
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

const Thumbnail = ({
  endpoint,
  file,
}: {
  endpoint: string;
  file: StoredFile;
}) => {
  // A plain <img> (not next/image) keeps the component portable to any React
  // app. The gateway download proxy streams the bytes, so it works on every
  // adapter — even ones that can't mint a public URL.
  if (file.type.startsWith("image/")) {
    return (
      // eslint-disable-next-line nextjs/no-img-element
      <img
        alt={file.key}
        className="size-10 shrink-0 rounded object-cover"
        src={`${endpoint}?op=download&key=${encodeURIComponent(file.key)}`}
      />
    );
  }
  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
      <FileIcon className="size-4" />
    </span>
  );
};

/**
 * Reactive list of stored files for a `useFiles()` instance — thumbnails, size
 * and type, with download and delete actions. Deletes go through the same
 * instance so ambient error state stays consistent.
 */
export const FileList = ({
  files,
  prefix,
  endpoint = "/api/files",
  readOnly = false,
  className,
}: FileListProps) => {
  const [items, setItems] = useState<StoredFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Read `files` through a ref so the fetch effect depends only on `prefix`.
  // The hook returns a fresh object whenever its ambient store changes (e.g. on
  // a failed call), so depending on `files` directly would re-run the effect on
  // every such change — an infinite loop the moment a `list` errors.
  const filesRef = useRef(files);
  filesRef.current = files;

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await filesRef.current.list(
        prefix ? { prefix } : undefined
      );
      setItems(result.items);
    } catch {
      // Leave the current items in place; the hook mirrors the error to
      // `files.error` for display. Crucially, don't re-fetch on failure.
    } finally {
      setIsLoading(false);
    }
  }, [prefix]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = useCallback(async (key: string) => {
    await filesRef.current.delete(key);
    setItems((prev) => prev.filter((item) => item.key !== key));
  }, []);

  const download = useCallback(async (file: StoredFile) => {
    const downloaded = await filesRef.current.download(file.key);
    const blob = await downloaded.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.download = file.key.split("/").pop() ?? file.key;
    anchor.href = url;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  if (isLoading && !items.length) {
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

  if (!items.length) {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-1 p-8 text-center text-muted-foreground text-sm",
          className
        )}
      >
        <FileIcon className="size-6" />
        Nothing here yet.
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">{items.length} files</p>
        <Button
          onClick={() => void refresh()}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <RefreshCwIcon className={cn(isLoading && "animate-spin")} />
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            className="flex items-center gap-3 rounded-lg border border-border p-2"
            key={item.key}
          >
            <Thumbnail endpoint={endpoint} file={item} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-sm">{item.key}</p>
              <p className="text-muted-foreground text-xs">
                {formatBytes(item.size)} · {item.type || "unknown"}
              </p>
            </div>
            <Button
              onClick={() => void download(item)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <DownloadIcon />
            </Button>
            {!readOnly && (
              <Button
                onClick={() => void remove(item.key)}
                size="icon-sm"
                type="button"
                variant="destructive"
              >
                <Trash2Icon />
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};
