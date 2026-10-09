"use client";

import type { FileInfo } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";
import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  HomeIcon,
  Loader2Icon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { FileActions } from "@/components/files-sdk/file-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface FileBrowserProps {
  /** A `useFiles()` instance — folders and files are listed through it. */
  files: UseFilesResult;
  /** Folder to open on mount, e.g. `"photos/"`. Defaults to the root. */
  initialPrefix?: string;
  /** Delimiter that marks a folder boundary. Default `"/"`. */
  delimiter?: string;
  /**
   * Called with the open folder's prefix (`""` for the root) on mount and
   * whenever the user opens another folder, e.g. to point a `Dropzone`'s
   * `prefix` at it.
   */
  onNavigate?: (prefix: string) => void;
  /** Called when a file row (not a folder) is clicked. */
  onSelect?: (file: FileInfo) => void;
  /** Called after a successful copy/rename/move/delete from a row's actions menu. */
  onChanged?: () => void;
  /** Hide the per-file actions menu. */
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
): string => {
  const name = folderPrefix.slice(parent.length);
  return name.endsWith(delimiter) ? name.slice(0, -delimiter.length) : name;
};

/**
 * A file's key relative to the folder being shown. Keys under a delimited
 * listing are direct children, so this is just the basename; in the flat view
 * (adapters with no folder concept) it keeps the nested path under `parent`.
 */
const fileLabel = (key: string, parent: string): string =>
  (key.startsWith(parent) && key.slice(parent.length)) || key;

/**
 * A folder-aware browser for a `useFiles()` instance. Uses `list({ delimiter })`
 * so common prefixes surface as folders you can descend into, with a breadcrumb
 * trail and cursor-based "load more". Each file row carries a `FileActions` menu
 * (download, copy, rename, move, delete) unless `readOnly`. On adapters whose
 * `capabilities().delimiter` is `false` (they have no folder concept and reject
 * a delimiter) it lists flat instead: every key under the current prefix, with
 * its path relative to it. A failed listing is shown, not mistaken for an empty
 * folder. The open folder is re-listed after its own row actions and whenever
 * uploads through the same `files` instance (a `Dropzone`, say) finish.
 */
export const FileBrowser = ({
  files,
  initialPrefix = "",
  delimiter = "/",
  onNavigate,
  onSelect,
  onChanged,
  readOnly = false,
  className,
}: FileBrowserProps) => {
  const [prefix, setPrefix] = useState(initialPrefix);
  const [folders, setFolders] = useState<string[]>([]);
  const [items, setItems] = useState<FileInfo[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string>();
  // `undefined` until capabilities resolve; listing waits for it so the first
  // request already knows whether it may pass a delimiter.
  const [canDelimit, setCanDelimit] = useState<boolean>();

  // Read `files` through a ref so the fetch effect depends only on `prefix` —
  // the hook returns a fresh object whenever its ambient store changes, so
  // depending on it directly would re-list on every change (an infinite loop
  // the moment a `list` errors). Same pattern as `file-list`.
  const filesRef = useRef(files);
  filesRef.current = files;
  // Every load takes a ticket; only the newest may apply its result, so a slow
  // response for a folder you've already left (or a stale "load more") can't
  // overwrite the one you're looking at.
  const requestRef = useRef(0);

  // Report the open folder. The callback is read through a ref so an inline
  // arrow (a new function every render) doesn't re-fire it for the same folder.
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  useEffect(() => {
    onNavigateRef.current?.(prefix);
  }, [prefix]);

  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      // Capabilities unreachable (e.g. not authorized): try a delimited
      // listing anyway — if the adapter rejects it, that error is shown.
      let supported = true;
      try {
        const caps = await filesRef.current.capabilities();
        supported = caps.delimiter !== false;
      } catch {
        // Keep the default above.
      }
      if (!cancelled) {
        setCanDelimit(supported);
      }
    };
    void resolve();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(
    async (next?: string) => {
      if (canDelimit === undefined) {
        return;
      }
      requestRef.current += 1;
      const request = requestRef.current;
      setIsLoading(true);
      setListError(undefined);
      try {
        // The client drops `undefined` options from the request, so an absent
        // cursor and an explicit `undefined` are the same first-page call.
        const result = await filesRef.current.list({
          cursor: next || undefined,
          delimiter: canDelimit ? delimiter : undefined,
          prefix: prefix || undefined,
        });
        if (request !== requestRef.current) {
          return;
        }
        setFolders((prev) =>
          next
            ? [...new Set([...prev, ...(result.prefixes ?? [])])]
            : (result.prefixes ?? [])
        );
        setItems((prev) => (next ? [...prev, ...result.items] : result.items));
        setCursor(result.cursor);
      } catch (error) {
        if (request === requestRef.current) {
          setListError(
            error instanceof Error ? error.message : "Something went wrong."
          );
        }
      } finally {
        if (request === requestRef.current) {
          setIsLoading(false);
        }
      }
    },
    [canDelimit, prefix, delimiter]
  );

  // A new folder starts from a clean slate rather than showing the previous
  // folder's rows under the new breadcrumb while it loads.
  useEffect(() => {
    setFolders([]);
    setItems([]);
    setCursor(undefined);
    void load();
  }, [load]);

  // Uploads through the same `files` instance (a Dropzone, or the page calling
  // `files.upload()`) can land in this folder, so re-list it when they finish.
  // The rows on screen stay put until the new listing replaces them. A
  // Dropzone uploads one file at a time, so `isUploading` dips between files;
  // the timer is cancelled when the next file starts, so a batch re-lists
  // once, at its end.
  const wasUploading = useRef(files.isUploading);
  useEffect(() => {
    const settled = wasUploading.current && !files.isUploading;
    wasUploading.current = files.isUploading;
    if (!settled) {
      return;
    }
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [files.isUploading, load]);

  // A copy/rename/move/delete can move a key out of (or into) the current
  // folder, so re-list the prefix from scratch rather than splicing locally.
  const changed = useCallback(() => {
    void load();
    onChanged?.();
  }, [load, onChanged]);

  const crumbs = crumbsOf(prefix, delimiter);
  const isEmpty = !(isLoading || listError || folders.length || items.length);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <nav
        aria-label="Folder path"
        className="flex flex-wrap items-center gap-0.5 text-sm"
      >
        <Button
          aria-current={crumbs.length === 0 ? "page" : undefined}
          aria-label="Root folder"
          onClick={() => setPrefix("")}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <HomeIcon />
        </Button>
        {crumbs.map((crumb, index) => (
          <Fragment key={crumb.prefix}>
            <ChevronRightIcon
              aria-hidden="true"
              className="text-muted-foreground size-3"
            />
            <Button
              aria-current={index === crumbs.length - 1 ? "page" : undefined}
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

      {canDelimit === false && (
        <p className="text-muted-foreground text-xs">
          This storage has no folders, so every file under this path is listed.
        </p>
      )}

      <ul className="flex flex-col gap-1">
        {folders.map((folder) => (
          <li key={folder}>
            <button
              className="border-border hover:bg-muted flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors"
              onClick={() => setPrefix(folder)}
              type="button"
            >
              <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded">
                <FolderIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {folderName(folder, prefix, delimiter)}
              </span>
              <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
            </button>
          </li>
        ))}
        {items.map((item) => (
          <li
            className="border-border flex items-center gap-3 rounded-lg border p-2"
            key={item.key}
          >
            <button
              className="hover:bg-muted -m-1 flex min-w-0 flex-1 items-center gap-3 rounded-md p-1 text-left transition-colors disabled:cursor-default disabled:hover:bg-transparent"
              disabled={!onSelect}
              onClick={() => onSelect?.(item)}
              type="button"
            >
              <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded">
                <FileIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {fileLabel(item.key, prefix)}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {formatBytes(item.size)} · {item.contentType || "unknown"}
                </span>
              </span>
            </button>
            {!readOnly && (
              <FileActions
                files={files}
                fileKey={item.key}
                onChanged={changed}
              />
            )}
          </li>
        ))}
      </ul>

      {isLoading && (
        <div className="text-muted-foreground flex items-center justify-center gap-2 p-4 text-sm">
          <Loader2Icon className="size-4 animate-spin" /> Loading…
        </div>
      )}

      {listError && !isLoading && (
        <div
          className="text-destructive flex flex-col items-center gap-2 p-6 text-center text-sm"
          role="alert"
        >
          <span>Couldn't list this folder: {listError}</span>
          <Button
            onClick={() => {
              void load();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        </div>
      )}

      {isEmpty && (
        <div className="text-muted-foreground flex flex-col items-center gap-1 p-8 text-center text-sm">
          <FolderIcon className="size-6" />
          This folder is empty.
        </div>
      )}

      {cursor && !isLoading && !listError && (
        <Button
          onClick={() => {
            void load(cursor);
          }}
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
