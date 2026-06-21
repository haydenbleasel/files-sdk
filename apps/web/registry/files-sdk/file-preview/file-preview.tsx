"use client";

import type { StoredFile } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";
import { FileIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface FilePreviewProps {
  /** A `useFiles()` instance — resolves metadata and bytes through it. */
  files: UseFilesResult;
  /** A key string, or an already-resolved `StoredFile`. */
  file: string | StoredFile;
  /** Endpoint for the gateway download-proxy fallback. Default `"/api/files"`. */
  endpoint?: string;
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

const Body = ({
  error,
  isLoading,
  src,
  text,
  type,
}: {
  error?: string;
  isLoading: boolean;
  src?: string;
  text?: string;
  type?: string;
}) => {
  if (isLoading) {
    return (
      <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
    );
  }
  if (error) {
    return <p className="text-destructive text-sm">{error}</p>;
  }
  if (src && type === "application/pdf") {
    return (
      <object
        aria-label="PDF preview"
        className="h-72 w-full"
        data={src}
        type="application/pdf"
      />
    );
  }
  if (src) {
    // Portable <img> rather than next/image so the component drops into any app.
    return (
      // eslint-disable-next-line nextjs/no-img-element
      <img
        alt="preview"
        className="max-h-72 w-auto rounded object-contain"
        src={src}
      />
    );
  }
  if (text !== undefined) {
    return (
      <pre className="max-h-72 w-full overflow-auto whitespace-pre-wrap text-xs">
        {text}
      </pre>
    );
  }
  return (
    <span className="flex flex-col items-center gap-1 text-muted-foreground text-sm">
      <FileIcon className="size-6" />
      No inline preview
    </span>
  );
};

/**
 * Lazy preview of a single stored file. Images and PDFs prefer a direct
 * `url()`, falling back to the gateway download proxy; text is fetched and
 * shown inline. Bytes are only loaded when the component mounts.
 */
export const FilePreview = ({
  files,
  file,
  endpoint = "/api/files",
  className,
}: FilePreviewProps) => {
  const key = typeof file === "string" ? file : file.key;
  const [meta, setMeta] = useState<StoredFile | undefined>(
    typeof file === "string" ? undefined : file
  );
  const [src, setSrc] = useState<string>();
  const [text, setText] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);

  // Read `files` through a ref so the effect doesn't depend on the hook's
  // identity — it returns a fresh object whenever its store changes (e.g. when
  // `url()` throws on an adapter that can't sign), which would otherwise re-run
  // this effect on its own error and loop forever.
  const filesRef = useRef(files);
  filesRef.current = files;

  useEffect(() => {
    const controller = new AbortController();

    const run = async () => {
      setLoadError(undefined);
      setSrc(undefined);
      setText(undefined);
      setIsLoading(true);
      try {
        const resolved =
          typeof file === "string" ? await filesRef.current.head(key) : file;
        if (controller.signal.aborted) {
          return;
        }
        setMeta(resolved);

        if (
          resolved.type.startsWith("text/") ||
          resolved.type === "application/json"
        ) {
          const downloaded = await filesRef.current.download(key);
          const body = await downloaded.text();
          if (!controller.signal.aborted) {
            setText(body);
          }
        } else if (
          resolved.type.startsWith("image/") ||
          resolved.type === "application/pdf"
        ) {
          // Prefer a signed/direct URL, but only when the adapter can actually
          // sign — otherwise `url()` returns a non-loadable placeholder. Fall
          // back to the gateway download proxy, which works on every adapter.
          const proxy = `${endpoint}?op=download&key=${encodeURIComponent(key)}`;
          let resolvedSrc = proxy;
          const caps = await filesRef.current.capabilities();
          if (!controller.signal.aborted && caps.signedUrl.supported) {
            try {
              resolvedSrc = await filesRef.current.url(key);
            } catch {
              resolvedSrc = proxy;
            }
          }
          if (!controller.signal.aborted) {
            setSrc(resolvedSrc);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error ? error.message : "Failed to load file."
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    void run();
    return () => controller.abort();
  }, [endpoint, file, key]);

  return (
    <figure
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card",
        className
      )}
    >
      <div className="flex min-h-40 items-center justify-center bg-muted/30 p-4">
        <Body
          error={loadError}
          isLoading={isLoading}
          src={src}
          text={text}
          type={meta?.type}
        />
      </div>
      <figcaption className="border-border border-t px-3 py-2">
        <p className="truncate font-medium text-sm">{key}</p>
        <p className="text-muted-foreground text-xs">
          {meta ? `${formatBytes(meta.size)} · ${meta.type || "unknown"}` : "—"}
          {meta?.etag ? ` · ${meta.etag}` : ""}
        </p>
      </figcaption>
    </figure>
  );
};
