"use client";

import type { FileUploadState, UseFilesResult } from "files-sdk/react";
import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export interface UploadProgressProps {
  /** A `useFiles()` instance — reads its ambient `uploads` / `progress`. */
  files: UseFilesResult;
  className?: string;
}

const StatusIcon = ({ status }: { status: FileUploadState["status"] }) => {
  if (status === "success") {
    return <CheckCircle2Icon className="size-4 text-primary" />;
  }
  if (status === "error" || status === "aborted") {
    return <XCircleIcon className="size-4 text-destructive" />;
  }
  return <Loader2Icon className="size-4 animate-spin text-muted-foreground" />;
};

const UploadRow = ({ upload }: { upload: FileUploadState }) => (
  <li className="flex flex-col gap-1.5">
    <div className="flex items-center gap-2 text-sm">
      <StatusIcon status={upload.status} />
      <span className="min-w-0 flex-1 truncate">{upload.name}</span>
      <span className="text-muted-foreground text-xs">
        {Math.round(upload.progress * 100)}%
      </span>
    </div>
    <Progress
      className={cn(
        upload.status === "error" && "bg-destructive/20",
        upload.status === "aborted" && "opacity-50"
      )}
      value={upload.progress * 100}
    />
  </li>
);

/**
 * Renders the ambient upload state of a `useFiles()` instance: one row per file
 * plus an aggregate bar when several are in flight. Returns `null` when idle.
 */
export const UploadProgress = ({ files, className }: UploadProgressProps) => {
  const { progress, uploads } = files;

  if (!uploads.length) {
    return null;
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {uploads.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-muted-foreground text-xs">
            <span>{uploads.length} files</span>
            <span>{Math.round(progress.fraction * 100)}%</span>
          </div>
          <Progress value={progress.fraction * 100} />
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {uploads.map((upload, index) => (
          <UploadRow
            key={upload.key ?? `${upload.name}-${index}`}
            upload={upload}
          />
        ))}
      </ul>
    </div>
  );
};
