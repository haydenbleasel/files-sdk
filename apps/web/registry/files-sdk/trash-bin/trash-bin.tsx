"use client";

import type { TrashedFile, UseFilesResult } from "files-sdk/react";
import {
  Loader2Icon,
  RotateCcwIcon,
  Trash2Icon,
  TrashIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface TrashBinProps {
  /** A `useFiles()` instance backed by a gateway with the `softDelete()` plugin. */
  files: UseFilesResult;
  /** Called after a successful restore or purge. */
  onChanged?: () => void;
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
 * A recycle bin backed by the `softDelete()` plugin. Lists trashed objects and
 * restores or permanently purges them through the same `useFiles()` instance.
 * Purges (single + "empty trash") confirm first, since they're the only way the
 * bytes actually leave storage.
 */
export const TrashBin = ({ files, onChanged, className }: TrashBinProps) => {
  const [trashed, setTrashed] = useState<TrashedFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  // `null` = closed; `{ key }` = purge one; `{}` = empty the whole trash.
  const [pending, setPending] = useState<{ key?: string } | null>(null);

  const filesRef = useRef(files);
  filesRef.current = files;

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      setTrashed(await filesRef.current.trashed());
    } catch {
      // The hook mirrors the error to `files.error` for display.
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const restore = useCallback(
    async (key: string) => {
      setBusy(key);
      try {
        await filesRef.current.restoreTrashed(key);
        await refresh();
        onChanged?.();
      } catch {
        // Mirrored to `files.error`.
      } finally {
        setBusy(undefined);
      }
    },
    [refresh, onChanged]
  );

  const purge = useCallback(async () => {
    if (!pending) {
      return;
    }
    setBusy(pending.key ?? "all");
    try {
      await filesRef.current.purge(pending.key);
      setPending(null);
      await refresh();
      onChanged?.();
    } catch {
      // Mirrored to `files.error`.
    } finally {
      setBusy(undefined);
    }
  }, [pending, refresh, onChanged]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {trashed.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-xs">
            {trashed.length} in trash
          </p>
          <Button
            onClick={() => setPending({})}
            size="sm"
            type="button"
            variant="ghost"
          >
            <TrashIcon />
            Empty trash
          </Button>
        </div>
      )}

      {isLoading && !trashed.length && (
        <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground text-sm">
          <Loader2Icon className="size-4 animate-spin" /> Loading…
        </div>
      )}

      {!(isLoading || trashed.length) && (
        <div className="flex flex-col items-center gap-1 p-8 text-center text-muted-foreground text-sm">
          <TrashIcon className="size-6" />
          Trash is empty.
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {trashed.map((item) => (
          <li
            className="flex items-center gap-3 rounded-lg border border-border p-2"
            key={item.key}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
              <Trash2Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-sm">{item.key}</p>
              <p className="text-muted-foreground text-xs">
                {formatBytes(item.size)}
                {item.lastModified
                  ? ` · ${new Date(item.lastModified).toLocaleDateString()}`
                  : ""}
              </p>
            </div>
            <Button
              disabled={busy !== undefined}
              onClick={() => void restore(item.key)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              {busy === item.key ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <RotateCcwIcon />
              )}
              <span className="sr-only">Restore</span>
            </Button>
            <Button
              disabled={busy !== undefined}
              onClick={() => setPending({ key: item.key })}
              size="icon-sm"
              type="button"
              variant="destructive"
            >
              <Trash2Icon />
              <span className="sr-only">Delete forever</span>
            </Button>
          </li>
        ))}
      </ul>

      <Dialog
        onOpenChange={(open) => !open && setPending(null)}
        open={pending !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pending?.key ? "Delete forever?" : "Empty the trash?"}
            </DialogTitle>
            <DialogDescription>
              {pending?.key
                ? `"${pending.key}" will be permanently deleted. This can't be undone.`
                : "Every item in the trash will be permanently deleted. This can't be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setPending(null)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={busy !== undefined}
              onClick={() => void purge()}
              type="button"
              variant="destructive"
            >
              {busy !== undefined && <Loader2Icon className="animate-spin" />}
              Delete forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
