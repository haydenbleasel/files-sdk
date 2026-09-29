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
    return <CheckCircle2Icon className="text-primary size-4" />;
  }
  if (status === "error") {
    return <XCircleIcon className="text-destructive size-4" />;
  }
  if (status === "aborted") {
    return <XCircleIcon className="text-muted-foreground size-4" />;
  }
  return <Loader2Icon className="text-muted-foreground size-4 animate-spin" />;
};

const statusText = (upload: FileUploadState): string => {
  if (upload.status === "error") {
    return upload.error?.message
      ? `Failed: ${upload.error.message}`
      : "Upload failed";
  }
  if (upload.status === "aborted") {
    return "Cancelled";
  }
  return `${Math.round(upload.progress * 100)}%`;
};

const UploadRow = ({ upload }: { upload: FileUploadState }) => (
  <li className="flex flex-col gap-1.5">
    <div className="flex items-center gap-2 text-sm">
      <StatusIcon status={upload.status} />
      <span className="min-w-0 flex-1 truncate">{upload.name}</span>
      <span
        className={cn(
          "text-muted-foreground max-w-[50%] truncate text-xs",
          upload.status === "error" && "text-destructive"
        )}
      >
        {statusText(upload)}
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
 * (uploading, done, failed with its error, or cancelled) plus an aggregate bar
 * once there's more than one. The hook keeps finished rows across uploads until
 * `files.reset()` clears them. Returns `null` when there's nothing to show.
 */
export const UploadProgress = ({ files, className }: UploadProgressProps) => {
  const { progress, uploads } = files;

  if (!uploads.length) {
    return null;
  }

  const finished = uploads.filter(
    (upload) => upload.status !== "pending" && upload.status !== "uploading"
  ).length;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {uploads.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <span>
              {finished} of {uploads.length} files finished
            </span>
            <span>{Math.round(progress.fraction * 100)}%</span>
          </div>
          <Progress value={progress.fraction * 100} />
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {uploads.map((upload, index) => (
          // The hook appends one entry per file across calls, so the same key
          // can appear twice (a re-upload); the index keeps React keys unique.
          <UploadRow
            key={`${upload.key ?? upload.name}-${index}`}
            upload={upload}
          />
        ))}
      </ul>
    </div>
  );
};
