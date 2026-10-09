"use client";

import type { StoredFile } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";
import { FileIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface FilePreviewProps {
  /** A `useFiles()` instance — resolves metadata and bytes through it. */
  files: UseFilesResult;
  /** A key string, or an already-resolved `StoredFile`. */
  file: string | StoredFile;
  /** Endpoint for the gateway download-proxy fallback. Default `"/api/files"`. */
  endpoint?: string;
  /**
   * Replace the built-in preview with a custom viewer (e.g. a PDF, DOCX or
   * CSV viewer component). Called once metadata resolves, with the same
   * `type`, `src` and `text` the built-in preview would use — except that
   * when this is set, a `src` is resolved for **every** non-text type, not
   * just images and PDFs, so viewers for formats the built-in preview can't
   * render still get a URL. PDFs arrive as a `blob:` URL; other types as a
   * signed or proxy URL. `type` is the stored type without parameters, or the
   * inferred one when the stored type is generic (`application/octet-stream`).
   */
  renderPreview?: (preview: {
    file: StoredFile;
    type: string;
    src?: string;
    text?: string;
  }) => ReactNode;
  className?: string;
}

/** The `file` prop is either a bare key or an already-resolved record. */
const isKey = (file: string | StoredFile): file is string =>
  typeof file === "string";

// Stored types that say nothing about the content, e.g. an upload nobody set a
// type on. A file stored with one is previewed by its extension instead.
const GENERIC_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

// The extensions the built-in preview can render. SVG is left out: browsers
// only render it from a response served as `image/svg+xml`.
const TYPES_BY_EXTENSION = new Map([
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["csv", "text/csv"],
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["json", "application/json"],
  ["log", "text/plain"],
  ["md", "text/markdown"],
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["txt", "text/plain"],
  ["webp", "image/webp"],
]);

const PDF_SIGNATURE = "%PDF-";

/** The extension of a key's last segment, lowercased; `""` when it has none. */
const extensionOf = (key: string): string => {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/**
 * The type to preview a file as: its stored type without parameters, or —
 * when that's generic — the type its extension implies, if the preview can
 * render it.
 */
const previewTypeOf = (file: StoredFile): string => {
  const type = file.type.replace(/;.*/su, "").trim().toLowerCase();
  if (!GENERIC_TYPES.has(type)) {
    return type;
  }
  return TYPES_BY_EXTENSION.get(extensionOf(file.key)) ?? type;
};

/**
 * Whether a file starts with the PDF signature. Reads only those bytes, so an
 * extension-less key stored with a generic type can still preview as a PDF
 * without downloading the whole object first. A failed read is treated as no
 * match — the file just gets no inline preview.
 */
const hasPdfSignature = async (
  files: UseFilesResult,
  key: string
): Promise<boolean> => {
  try {
    const head = await files.download(key, {
      range: { end: PDF_SIGNATURE.length - 1, start: 0 },
    });
    return (await head.text()) === PDF_SIGNATURE;
  } catch {
    return false;
  }
};

/**
 * {@link previewTypeOf}, plus one more check for a generic type with no
 * telling extension: the PDF signature, on adapters that can serve the range.
 */
const resolvePreviewType = async (
  files: UseFilesResult,
  file: StoredFile
): Promise<string> => {
  const type = previewTypeOf(file);
  if (!GENERIC_TYPES.has(type) || file.size < PDF_SIGNATURE.length) {
    return type;
  }
  const caps = await files.capabilities();
  return caps.rangeRead && (await hasPdfSignature(files, file.key))
    ? "application/pdf"
    : type;
};

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
      <Loader2Icon className="text-muted-foreground size-6 animate-spin" />
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
      >
        <a href={src} rel="noreferrer" target="_blank">
          Open PDF preview
        </a>
      </object>
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
      <pre className="max-h-72 w-full overflow-auto text-xs whitespace-pre-wrap">
        {text}
      </pre>
    );
  }
  return (
    <span className="text-muted-foreground flex flex-col items-center gap-1 text-sm">
      <FileIcon className="size-6" />
      No inline preview
    </span>
  );
};

/**
 * Lazy preview of a single stored file. Images prefer a direct `url()`,
 * falling back to the gateway download proxy; PDFs are downloaded and shown
 * from a `blob:` URL; text is fetched and shown inline. A file stored with a
 * generic type (`application/octet-stream`) is previewed by its extension, or
 * as a PDF when its first bytes are the PDF signature. Bytes are only loaded
 * when the component mounts.
 */
export const FilePreview = ({
  files,
  file,
  endpoint = "/api/files",
  renderPreview,
  className,
}: FilePreviewProps) => {
  const key = isKey(file) ? file : file.key;
  const [meta, setMeta] = useState<StoredFile | undefined>(
    isKey(file) ? undefined : file
  );
  const [type, setType] = useState<string>();
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

  // The effect only cares whether a custom renderer exists (it widens which
  // types get a `src`), not about the callback's identity — an inline arrow
  // would re-run it every render.
  const hasCustomRenderer = renderPreview !== undefined;

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;

    const run = async () => {
      setLoadError(undefined);
      setType(undefined);
      setSrc(undefined);
      setText(undefined);
      setIsLoading(true);
      try {
        const resolved = isKey(file) ? await filesRef.current.head(key) : file;
        const resolvedType = await resolvePreviewType(
          filesRef.current,
          resolved
        );
        if (controller.signal.aborted) {
          return;
        }
        setMeta(resolved);
        setType(resolvedType);

        if (
          resolvedType.startsWith("text/") ||
          resolvedType === "application/json"
        ) {
          const downloaded = await filesRef.current.download(key);
          const body = await downloaded.text();
          if (!controller.signal.aborted) {
            setText(body);
          }
        } else if (resolvedType === "application/pdf") {
          // The gateway forces `Content-Disposition: attachment` on both
          // `url()` and the download proxy (its stored-XSS guard), and
          // browsers download an <object>'s document instead of rendering it
          // when that header is present. A `blob:` URL carries no headers, so
          // fetch the bytes and preview those.
          const downloaded = await filesRef.current.download(key);
          const blob = await downloaded.blob();
          if (!controller.signal.aborted) {
            objectUrl = URL.createObjectURL(
              blob.type === "application/pdf"
                ? blob
                : new Blob([blob], { type: "application/pdf" })
            );
            setSrc(objectUrl);
          }
        } else if (resolvedType.startsWith("image/") || hasCustomRenderer) {
          // Prefer a signed/direct URL, but only when the adapter can actually
          // sign — otherwise `url()` returns a non-loadable placeholder. Fall
          // back to the gateway download proxy, which works on every adapter.
          const proxy = `${endpoint}${endpoint.includes("?") ? "&" : "?"}op=download&key=${encodeURIComponent(key)}`;
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
    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [endpoint, file, key, hasCustomRenderer]);

  return (
    <figure
      className={cn(
        "border-border bg-card overflow-hidden rounded-lg border",
        className
      )}
    >
      <div className="bg-muted/30 flex min-h-40 items-center justify-center p-4">
        {renderPreview && !isLoading && !loadError && meta ? (
          renderPreview({ file: meta, src, text, type: type ?? meta.type })
        ) : (
          <Body
            error={loadError}
            isLoading={isLoading}
            src={src}
            text={text}
            type={type}
          />
        )}
      </div>
      <figcaption className="border-border border-t px-3 py-2">
        <p className="truncate text-sm font-medium">{key}</p>
        <p className="text-muted-foreground text-xs">
          {meta ? `${formatBytes(meta.size)} · ${meta.type || "unknown"}` : "—"}
          {meta?.etag ? ` · ${meta.etag}` : ""}
        </p>
      </figcaption>
    </figure>
  );
};
