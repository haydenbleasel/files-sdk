"use client";

import type { UseFilesResult } from "files-sdk/react";
import {
  CopyIcon,
  DownloadIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

export interface FileActionsProps {
  /** A `useFiles()` instance — every action runs through it. */
  files: UseFilesResult;
  /** The key the actions operate on. */
  fileKey: string;
  /** Called after a successful copy/rename/move/delete so the parent can refresh. */
  onChanged?: () => void;
  /** Custom trigger. Defaults to a `⋯` icon button. */
  children?: ReactNode;
  className?: string;
}

type Action = "copy" | "rename" | "move" | "delete";

const TITLES: Record<Action, string> = {
  copy: "Copy to",
  delete: "Delete file",
  move: "Move to",
  rename: "Rename file",
};

const parentOf = (key: string): string => {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? "" : key.slice(0, slash + 1);
};

/**
 * A `⋯` actions menu for a single key — download, copy, rename, move and delete,
 * all routed through the `useFiles()` instance you pass in. Copy/rename/move open
 * a small prompt for the destination; delete confirms first.
 */
export const FileActions = ({
  files,
  fileKey,
  onChanged,
  children,
  className,
}: FileActionsProps) => {
  const [action, setAction] = useState<Action | null>(null);
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);

  const open = useCallback(
    (next: Action) => {
      const parent = parentOf(fileKey);
      // Rename edits just the basename; copy/move edit the whole key.
      setDest(next === "rename" ? fileKey.slice(parent.length) : fileKey);
      setAction(next);
    },
    [fileKey]
  );

  const download = useCallback(async () => {
    const file = await files.download(fileKey);
    const blob = await file.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.download = fileKey.split("/").pop() ?? fileKey;
    anchor.href = url;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [files, fileKey]);

  const confirm = useCallback(async () => {
    if (!action) {
      return;
    }
    setBusy(true);
    try {
      if (action === "delete") {
        await files.delete(fileKey);
      } else if (action === "copy") {
        await files.copy(fileKey, dest);
      } else {
        // rename + move are both a `move`; rename re-attaches the parent prefix.
        const target = action === "rename" ? parentOf(fileKey) + dest : dest;
        await files.move(fileKey, target);
      }
      setAction(null);
      onChanged?.();
    } catch {
      // The hook mirrors the error to `files.error` for display.
    } finally {
      setBusy(false);
    }
  }, [action, dest, files, fileKey, onChanged]);

  const isRename = action === "rename";
  const isDelete = action === "delete";
  const destUnchanged =
    action === "rename"
      ? fileKey.slice(parentOf(fileKey).length) === dest
      : fileKey === dest;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {children ?? (
            <Button
              className={className}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <MoreHorizontalIcon />
              <span className="sr-only">Actions</span>
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void download()}>
            <DownloadIcon />
            Download
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => open("copy")}>
            <CopyIcon />
            Copy
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => open("rename")}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => open("move")}>
            <CopyIcon />
            Move
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => open("delete")}
            variant="destructive"
          >
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        onOpenChange={(next) => !next && setAction(null)}
        open={action !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{action ? TITLES[action] : ""}</DialogTitle>
            <DialogDescription className="truncate">
              {fileKey}
            </DialogDescription>
          </DialogHeader>

          {!isDelete && (
            <Input
              autoFocus
              onChange={(event) => setDest(event.target.value)}
              placeholder={isRename ? "New name" : "Destination key"}
              value={dest}
            />
          )}

          <DialogFooter>
            <Button
              onClick={() => setAction(null)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={busy || (!isDelete && (!dest.trim() || destUnchanged))}
              onClick={() => void confirm()}
              type="button"
              variant={isDelete ? "destructive" : "default"}
            >
              {busy && <Loader2Icon className="animate-spin" />}
              {isDelete ? "Delete" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
