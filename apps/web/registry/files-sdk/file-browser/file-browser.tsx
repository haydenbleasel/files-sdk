"use client";

import type { StoredFile } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";
import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  HomeIcon,
  Loader2Icon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface FileBrowserProps {
  /** A `useFiles()` instance — folders and files are listed through it. */
  files: UseFilesResult;
  /** Folder to open on mount, e.g. `"photos/"`. Defaults to the root. */
  initialPrefix?: string;
  /** Delimiter that marks a folder boundary. Default `"/"`. */
  delimiter?: string;
  /** Called when a file row (not a folder) is clicked. */
  onSelect?: (file: StoredFile) => void;
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

/** Split `"photos/2024/"` into clickable crumbs with their cumulative prefix. */
const crumbsOf = (
  prefix: string,
  delimiter: string
): { label: string; prefix: string }[] => {
  const parts = prefix.split(delimiter).filter(Boolean);
  let acc = "";
  return parts.map((label) => {
    acc += label + delimiter;
    return { label, prefix: acc };
  });
};

/** Strip the parent prefix + trailing delimiter so a folder shows its own name. */
const folderName = (
  folderPrefix: string,
  parent: string,
  delimiter: string
): string => folderPrefix.slice(parent.length).replace(delimiter, "");

/**
 * A folder-aware browser for a `useFiles()` instance. Uses `list({ delimiter })`
 * so common prefixes surface as folders you can descend into, with a breadcrumb
 * trail and cursor-based "load more". Falls back gracefully on adapters that
 * can't delimit — everything just appears as files at the root.
 */
export const FileBrowser = ({
  files,
  initialPrefix = "",
  delimiter = "/",
  onSelect,
  className,
}: FileBrowserProps) => {
  const [prefix, setPrefix] = useState(initialPrefix);
  const [folders, setFolders] = useState<string[]>([]);
  const [items, setItems] = useState<StoredFile[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);

  // Read `files` through a ref so the fetch effect depends only on `prefix` —
  // the hook returns a fresh object whenever its ambient store changes, so
  // depending on it directly would re-list on every change (an infinite loop
  // the moment a `list` errors). Same pattern as `file-list`.
  const filesRef = useRef(files);
  filesRef.current = files;

  const load = useCallback(
    async (next?: string) => {
      setIsLoading(true);
      try {
        const result = await filesRef.current.list({
          delimiter,
          prefix: prefix || undefined,
          ...(next ? { cursor: next } : {}),
        });
        setFolders((prev) =>
          next
            ? [...new Set([...prev, ...(result.prefixes ?? [])])]
            : (result.prefixes ?? [])
        );
        setItems((prev) => (next ? [...prev, ...result.items] : result.items));
        setCursor(result.cursor);
      } catch {
        // The hook mirrors the error to `files.error` for display; don't re-fetch.
      } finally {
        setIsLoading(false);
      }
    },
    [prefix, delimiter]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const crumbs = crumbsOf(prefix, delimiter);
  const isEmpty = !(isLoading || folders.length || items.length);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <nav className="flex flex-wrap items-center gap-0.5 text-sm">
        <Button
          onClick={() => setPrefix("")}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <HomeIcon />
        </Button>
        {crumbs.map((crumb) => (
          <Fragment key={crumb.prefix}>
            <ChevronRightIcon className="size-3 text-muted-foreground" />
            <Button
              onClick={() => setPrefix(crumb.prefix)}
              size="xs"
              type="button"
              variant="ghost"
            >
              {crumb.label}
            </Button>
          </Fragment>
        ))}
      </nav>

      <ul className="flex flex-col gap-1">
        {folders.map((folder) => (
          <li key={folder}>
            <button
              className="flex w-full items-center gap-3 rounded-lg border border-border p-2 text-left transition-colors hover:bg-muted"
              onClick={() => setPrefix(folder)}
              type="button"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                <FolderIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-sm">
                {folderName(folder, prefix, delimiter)}
              </span>
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
        {items.map((item) => (
          <li key={item.key}>
            <button
              className="flex w-full items-center gap-3 rounded-lg border border-border p-2 text-left transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
              disabled={!onSelect}
              onClick={() => onSelect?.(item)}
              type="button"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                <FileIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sm">
                  {folderName(item.key, prefix, delimiter) || item.key}
                </span>
                <span className="block text-muted-foreground text-xs">
                  {formatBytes(item.size)} · {item.type || "unknown"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {isLoading && (
        <div className="flex items-center justify-center gap-2 p-4 text-muted-foreground text-sm">
          <Loader2Icon className="size-4 animate-spin" /> Loading…
        </div>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center gap-1 p-8 text-center text-muted-foreground text-sm">
          <FolderIcon className="size-6" />
          This folder is empty.
        </div>
      )}

      {cursor && !isLoading && (
        <Button
          onClick={() => void load(cursor)}
          size="sm"
          type="button"
          variant="outline"
        >
          Load more
        </Button>
      )}
    </div>
  );
};
