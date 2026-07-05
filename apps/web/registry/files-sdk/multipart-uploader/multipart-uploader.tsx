"use client";

import type { UseFilesResult } from "files-sdk/react";
import { FileIcon, Loader2Icon, UploadIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type QueueStatus = "pending" | "uploading" | "success" | "error";

interface QueueItem {
  id: number;
  file: File;
  status: QueueStatus;
  /** 0–1. */
  progress: number;
  key?: string;
  error?: string;
}

export interface MultipartUploaderProps {
  /** A `useFiles()` instance — uploads through it. */
  files: UseFilesResult;
  /** Key prefix (folder) for explicit keys, e.g. `"docs/"`. Empty = server mints keys. */
  prefix?: string;
  /** `accept` attribute for the file input. */
  accept?: string;
  /** Parallel uploads. Default 3. */
  concurrency?: number;
  onUploaded?: (entry: { key: string; name: string }) => void;
  className?: string;
}

/**
 * Multi-file queue uploader. Files upload with bounded concurrency and live
 * per-file progress; large files are chunked into a multipart upload by the
 * gateway transparently. Cancel aborts everything in flight.
 */
export const MultipartUploader = ({
  files,
  prefix = "",
  accept,
  concurrency = 3,
  onUploaded,
  className,
}: MultipartUploaderProps) => {
  const idRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const patch = useCallback((id: number, next: Partial<QueueItem>) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...next } : item))
    );
  }, []);

  const add = useCallback((list: FileList | null) => {
    if (!list?.length) {
      return;
    }
    const additions: QueueItem[] = [...list].map((file) => {
      const id = idRef.current;
      idRef.current += 1;
      return { file, id, progress: 0, status: "pending" };
    });
    setQueue((prev) => [...prev, ...additions]);
  }, []);

  const start = useCallback(async () => {
    const pending = queue.filter((item) => item.status === "pending");
    if (!pending.length) {
      return;
    }
    // Re-arm the hook in case a previous run was cancelled (aborted) controller.
    files.reset();
    setIsUploading(true);

    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        const item = pending[cursor];
        cursor += 1;
        patch(item.id, { error: undefined, status: "uploading" });
        try {
          const onProgress = (p: { fraction: number }) =>
            patch(item.id, { progress: p.fraction });
          const result = prefix
            ? // eslint-disable-next-line no-await-in-loop -- bounded-concurrency worker pulls items from a shared queue; each upload runs in order within its worker
              await files.upload(`${prefix}${item.file.name}`, item.file, {
                contentType: item.file.type,
                onProgress,
              })
            : // eslint-disable-next-line no-await-in-loop -- bounded-concurrency worker pulls items from a shared queue; each upload runs in order within its worker
              await files.upload(item.file, { onProgress });
          patch(item.id, { key: result.key, progress: 1, status: "success" });
          onUploaded?.({ key: result.key, name: item.file.name });
        } catch (error) {
          patch(item.id, {
            error: error instanceof Error ? error.message : "Upload failed",
            status: "error",
          });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, pending.length) }, worker)
    );
    setIsUploading(false);
  }, [concurrency, files, onUploaded, patch, prefix, queue]);

  const cancel = useCallback(() => {
    files.abort();
    setIsUploading(false);
    setQueue((prev) =>
      prev.map((item) =>
        item.status === "uploading"
          ? { ...item, error: "Cancelled", status: "error" }
          : item
      )
    );
  }, [files]);

  const remove = useCallback((id: number) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const pendingCount = queue.filter((item) => item.status === "pending").length;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <Button
        className="flex h-auto flex-col items-center justify-center gap-2 p-6"
        onClick={() => inputRef.current?.click()}
        type="button"
        variant="outline"
      >
        <input
          accept={accept}
          aria-label="Add files"
          className="hidden"
          multiple
          onChange={(event) => {
            add(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
          ref={inputRef}
          type="file"
        />
        <UploadIcon className="size-5 text-muted-foreground" />
        <span className="font-medium text-sm">Add files</span>
        <span className="text-muted-foreground text-xs">
          Large files upload in parts automatically.
        </span>
      </Button>

      {queue.length > 0 && (
        <ul className="flex flex-col gap-2">
          {queue.map((item) => (
            <li className="flex flex-col gap-1.5" key={item.id}>
              <div className="flex items-center gap-2 text-sm">
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {item.file.name}
                </span>
                {item.status === "uploading" ? (
                  <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <Button
                    className="text-muted-foreground"
                    onClick={() => remove(item.id)}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                )}
              </div>
              {(item.status === "uploading" || item.status === "success") && (
                <Progress value={item.progress * 100} />
              )}
              {item.error && (
                <p className="text-destructive text-xs">{item.error}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {queue.length > 0 && (
        <div className="flex gap-2">
          <Button
            disabled={!pendingCount || isUploading}
            onClick={() => void start()}
            type="button"
          >
            {isUploading
              ? "Uploading…"
              : `Upload ${pendingCount} file${pendingCount === 1 ? "" : "s"}`}
          </Button>
          {isUploading && (
            <Button onClick={cancel} type="button" variant="outline">
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
