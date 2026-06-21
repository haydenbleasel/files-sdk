"use client";

import type { UseFilesResult } from "files-sdk/react";
import { FileIcon, Loader2Icon, UploadIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface UploadedEntry {
  key: string;
  name: string;
}

interface DropzoneContextValue {
  accept?: string;
  maxFiles: number;
  maxSize?: number;
  isUploading: boolean;
  uploaded: UploadedEntry[];
  open: () => void;
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

const DropzoneContext = createContext<DropzoneContextValue | null>(null);

const useDropzoneContext = (): DropzoneContextValue => {
  const ctx = useContext(DropzoneContext);
  if (!ctx) {
    throw new Error("Dropzone components must be used inside <Dropzone>.");
  }
  return ctx;
};

export interface DropzoneProps {
  /** A `useFiles()` instance — the dropzone uploads through it. */
  files: UseFilesResult;
  /** Key prefix (folder) for explicit keys, e.g. `"docs/"`. Empty = server mints the key. */
  prefix?: string;
  /** `accept` attribute for the file input, e.g. `"image/*"`. */
  accept?: string;
  /** Max files per drop. Default 1. */
  maxFiles?: number;
  /** Max bytes per file; larger files are skipped. */
  maxSize?: number;
  /** Called after each successful upload. */
  onUploaded?: (entry: UploadedEntry) => void;
  className?: string;
  children?: ReactNode;
}

/**
 * Drag-and-drop (or click) upload area wired to `files-sdk/react`. Compose with
 * `<DropzoneEmptyState />` and `<DropzoneContent />`, or pass your own children.
 */
export const Dropzone = ({
  files,
  prefix = "",
  accept,
  maxFiles = 1,
  maxSize,
  onUploaded,
  className,
  children,
}: DropzoneProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [uploaded, setUploaded] = useState<UploadedEntry[]>([]);

  const upload = useCallback(
    async (list: FileList | null) => {
      if (!list?.length) {
        return;
      }
      for (const file of [...list].slice(0, maxFiles)) {
        if (maxSize && file.size > maxSize) {
          continue;
        }
        const result = prefix
          ? await files.upload(`${prefix}${file.name}`, file, {
              contentType: file.type,
            })
          : await files.upload(file);
        const entry: UploadedEntry = { key: result.key, name: file.name };
        setUploaded((prev) => [...prev, entry]);
        onUploaded?.(entry);
      }
    },
    [files, maxFiles, maxSize, onUploaded, prefix]
  );

  const open = useCallback(() => inputRef.current?.click(), []);

  return (
    <DropzoneContext.Provider
      value={{
        accept,
        isUploading: files.isUploading,
        maxFiles,
        maxSize,
        open,
        uploaded,
      }}
    >
      <Button
        className={cn(
          "relative flex h-auto w-full flex-col items-center justify-center gap-2 overflow-hidden p-8",
          isDragActive && "border-primary ring-1 ring-primary",
          className
        )}
        disabled={files.isUploading}
        onClick={open}
        onDragLeave={() => setIsDragActive(false)}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragActive(true);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragActive(false);
          void upload(event.dataTransfer.files);
        }}
        type="button"
        variant="outline"
      >
        <input
          accept={accept}
          aria-label="Upload files"
          className="hidden"
          multiple={maxFiles > 1}
          onChange={(event) => {
            void upload(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
          ref={inputRef}
          type="file"
        />
        {children}
      </Button>
    </DropzoneContext.Provider>
  );
};

export interface DropzoneEmptyStateProps {
  className?: string;
  children?: ReactNode;
}

/** Default prompt shown before anything has been uploaded. */
export const DropzoneEmptyState = ({
  className,
  children,
}: DropzoneEmptyStateProps) => {
  const { accept, isUploading, maxFiles, maxSize, uploaded } =
    useDropzoneContext();

  if (uploaded.length) {
    return null;
  }

  if (children) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1 text-center",
        className
      )}
    >
      {isUploading ? (
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      ) : (
        <UploadIcon className="size-6 text-muted-foreground" />
      )}
      <p className="font-medium text-sm">
        {isUploading ? "Uploading…" : "Drag & drop or click to upload"}
      </p>
      <p className="text-muted-foreground text-xs">
        {accept ? `${accept} · ` : ""}
        {maxFiles > 1 ? `up to ${maxFiles} files` : "1 file"}
        {maxSize ? ` · max ${formatBytes(maxSize)}` : ""}
      </p>
    </div>
  );
};

export interface DropzoneContentProps {
  className?: string;
  children?: ReactNode;
}

/** Summary shown after one or more successful uploads. */
export const DropzoneContent = ({
  className,
  children,
}: DropzoneContentProps) => {
  const { uploaded } = useDropzoneContext();

  if (!uploaded.length) {
    return null;
  }

  if (children) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1 text-center",
        className
      )}
    >
      <FileIcon className="size-6 text-muted-foreground" />
      <p className="font-medium text-sm">
        {uploaded.length === 1
          ? uploaded[0].name
          : `${uploaded.length} files uploaded`}
      </p>
    </div>
  );
};
