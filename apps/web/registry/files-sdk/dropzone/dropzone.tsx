"use client";

import type { UseFilesResult } from "files-sdk/react";
import {
  CheckCircle2Icon,
  Loader2Icon,
  UploadIcon,
  XCircleIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface UploadedEntry {
  key: string;
  /** Display name — the relative path for folder uploads, else the file name. */
  name: string;
}

interface PendingFile {
  file: File;
  /** Path relative to the picked/dropped root (e.g. `docs/guide.md`). Empty for plain files. */
  path: string;
}

interface DropzoneContextValue {
  accept?: string;
  directory: boolean;
  maxFiles: number;
  maxSize?: number;
  isUploading: boolean;
  uploaded: UploadedEntry[];
  /** Failure summary for the most recent batch, if any. */
  error?: string;
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

/** Drain a directory reader — `readEntries` returns results in batches of ≤100. */
const readAllEntries = (
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> =>
  // oxlint-disable-next-line promise/avoid-new -- readEntries is callback-only; there is no promise API to reuse
  new Promise((resolve, reject) => {
    const entries: FileSystemEntry[] = [];
    const drain = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        drain();
      }, reject);
    };
    drain();
  });

const entryFile = (entry: FileSystemFileEntry): Promise<File> =>
  // oxlint-disable-next-line promise/avoid-new -- FileSystemFileEntry.file is callback-only; there is no promise API to reuse
  new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });

const traverseEntry = async (
  entry: FileSystemEntry
): Promise<PendingFile[]> => {
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    // fullPath is absolute (`/folder/sub/file.txt`) — strip the leading slash so
    // keys mirror webkitRelativePath and include the dropped folder's name.
    return [{ file, path: entry.fullPath.slice(1) }];
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(
      (entry as FileSystemDirectoryEntry).createReader()
    );
    const nested = await Promise.all(children.map(traverseEntry));
    return nested.flat();
  }
  return [];
};

/**
 * Flatten a drop into files. Entries must be grabbed synchronously — the
 * DataTransfer goes inert once the event handler yields — after which directory
 * traversal can run async. Plain files keep an empty path so the server can
 * still mint their keys.
 */
const collectDropped = async (
  dataTransfer: DataTransfer
): Promise<PendingFile[]> => {
  const flat: PendingFile[] = [];
  const directories: FileSystemEntry[] = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== "file") {
      continue;
    }
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      directories.push(entry);
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      flat.push({ file, path: "" });
    }
  }
  if (flat.length === 0 && directories.length === 0) {
    return [...dataTransfer.files].map((file) => ({ file, path: "" }));
  }
  const nested = await Promise.all(directories.map(traverseEntry));
  return [...flat, ...nested.flat()];
};

export interface DropzoneProps {
  /** A `useFiles()` instance — the dropzone uploads through it. */
  files: UseFilesResult;
  /** Key prefix (folder) for explicit keys, e.g. `"docs/"`. Empty = server mints the key. */
  prefix?: string;
  /** `accept` attribute for the file input, e.g. `"image/*"`. */
  accept?: string;
  /**
   * Accept whole folders: the picker selects a directory and dropped folders
   * are traversed recursively, with relative paths preserved in keys
   * (`prefix + folder/sub/file.ext`).
   */
  directory?: boolean;
  /** Max files per drop. Default 1, or unlimited when `directory` is set. */
  maxFiles?: number;
  /** Max bytes per file; larger files are reported as failed. */
  maxSize?: number;
  /** Called after each successful upload. */
  onUploaded?: (entry: UploadedEntry) => void;
  /** Called for each file that fails to upload or is rejected client-side. */
  onError?: (error: Error, file: File) => void;
  className?: string;
  children?: ReactNode;
}

/**
 * Drag-and-drop (or click) upload area wired to `files-sdk/react`. Compose with
 * `<DropzoneContent />`, `<DropzoneEmptyState />` and `<DropzoneError />`, or
 * pass your own children. The prompt stays visible after uploads so users can
 * keep adding files.
 */
export const Dropzone = ({
  files,
  prefix = "",
  accept,
  directory = false,
  maxFiles: maxFilesProp,
  maxSize,
  onUploaded,
  onError,
  className,
  children,
}: DropzoneProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [uploaded, setUploaded] = useState<UploadedEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  const maxFiles = maxFilesProp ?? (directory ? Number.POSITIVE_INFINITY : 1);

  const upload = useCallback(
    async (pending: PendingFile[]) => {
      if (!pending.length) {
        return;
      }
      setErrorMessage(undefined);
      const failures: string[] = [];
      const fail = (name: string, file: File, cause: Error): void => {
        failures.push(`${name} (${cause.message})`);
        onError?.(cause, file);
      };
      const batch = pending.slice(0, maxFiles);
      for (const { file, path } of batch) {
        const name = path || file.name;
        if (maxSize && file.size > maxSize) {
          fail(name, file, new Error(`larger than ${formatBytes(maxSize)}`));
          continue;
        }
        let key: string | undefined;
        if (path) {
          key = `${prefix}${path}`;
        } else if (prefix) {
          key = `${prefix}${file.name}`;
        }
        try {
          const result = key
            ? // eslint-disable-next-line no-await-in-loop -- uploads run sequentially to avoid firing an unbounded burst of parallel requests at the server
              await files.upload(key, file, { contentType: file.type })
            : // eslint-disable-next-line no-await-in-loop -- uploads run sequentially to avoid firing an unbounded burst of parallel requests at the server
              await files.upload(file);
          const entry: UploadedEntry = { key: result.key, name };
          setUploaded((prev) => [...prev, entry]);
          onUploaded?.(entry);
        } catch (error) {
          fail(
            name,
            file,
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
      if (pending.length > batch.length) {
        const skipped = pending.length - batch.length;
        failures.push(
          `${skipped} file${skipped === 1 ? "" : "s"} over the ${maxFiles}-file limit`
        );
      }
      if (failures.length) {
        setErrorMessage(
          failures.length === 1
            ? `Upload failed: ${failures[0]}`
            : `${failures.length} uploads failed: ${failures.join(", ")}`
        );
      }
    },
    [files, maxFiles, maxSize, onError, onUploaded, prefix]
  );

  // Called synchronously from the drop event so collectDropped can grab the
  // DataTransfer entries before the handler yields.
  const handleDrop = useCallback(
    async (dataTransfer: DataTransfer) => {
      await upload(await collectDropped(dataTransfer));
    },
    [upload]
  );

  const open = useCallback(() => inputRef.current?.click(), []);

  const contextValue = useMemo(
    () => ({
      accept,
      directory,
      error: errorMessage,
      isUploading: files.isUploading,
      maxFiles,
      maxSize,
      open,
      uploaded,
    }),
    [
      accept,
      directory,
      errorMessage,
      files.isUploading,
      maxFiles,
      maxSize,
      open,
      uploaded,
    ]
  );

  return (
    <DropzoneContext.Provider value={contextValue}>
      <Button
        className={cn(
          "relative flex h-auto w-full flex-col items-center justify-center gap-2 overflow-hidden p-8",
          isDragActive && "border-primary ring-primary ring-1",
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
          void handleDrop(event.dataTransfer);
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
            const picked = [...(event.currentTarget.files ?? [])].map(
              (file) => ({ file, path: file.webkitRelativePath || "" })
            );
            void upload(picked);
            event.currentTarget.value = "";
          }}
          ref={(node) => {
            inputRef.current = node;
            // React's types don't know the non-standard directory-picker
            // attribute, so set it imperatively.
            node?.toggleAttribute("webkitdirectory", directory);
          }}
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

/** Default prompt — stays visible after uploads so more files can be added. */
export const DropzoneEmptyState = ({
  className,
  children,
}: DropzoneEmptyStateProps) => {
  const { accept, directory, isUploading, maxFiles, maxSize } =
    useDropzoneContext();

  if (children) {
    return <div className={className}>{children}</div>;
  }

  let countLabel = "1 file";
  if (directory) {
    countLabel = Number.isFinite(maxFiles)
      ? `folder · up to ${maxFiles} files`
      : "folder upload";
  } else if (maxFiles > 1) {
    countLabel = `up to ${maxFiles} files`;
  }

  const prompt = directory
    ? "Drag & drop a folder or click to upload"
    : "Drag & drop or click to upload";

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1 text-center",
        className
      )}
    >
      {isUploading ? (
        <Loader2Icon className="text-muted-foreground size-6 animate-spin" />
      ) : (
        <UploadIcon className="text-muted-foreground size-6" />
      )}
      <p className="text-sm font-medium">
        {isUploading ? "Uploading…" : prompt}
      </p>
      <p className="text-muted-foreground text-xs">
        {accept ? `${accept} · ` : ""}
        {countLabel}
        {maxSize ? ` · max ${formatBytes(maxSize)}` : ""}
      </p>
    </div>
  );
};

export interface DropzoneContentProps {
  className?: string;
  children?: ReactNode;
}

/** Success summary shown once one or more uploads have completed. */
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
    <p
      className={cn("flex items-center gap-1.5 text-sm font-medium", className)}
    >
      <CheckCircle2Icon className="text-primary size-4" />
      {uploaded.length === 1
        ? `Uploaded ${uploaded[0].name}`
        : `${uploaded.length} files uploaded`}
    </p>
  );
};

export interface DropzoneErrorProps {
  className?: string;
  children?: ReactNode;
}

/** Failure summary — renders only when the most recent batch had errors. */
export const DropzoneError = ({ className, children }: DropzoneErrorProps) => {
  const { error } = useDropzoneContext();

  if (!error) {
    return null;
  }

  if (children) {
    return <div className={className}>{children}</div>;
  }

  return (
    <p
      className={cn(
        "text-destructive flex items-center gap-1.5 text-sm",
        className
      )}
    >
      <XCircleIcon className="size-4" />
      {error}
    </p>
  );
};
