"use client";

import type { AdapterCapabilities } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";
import { CheckIcon, CopyIcon, Link2Icon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface ShareDialogProps {
  /** A `useFiles()` instance — the link is minted through it. */
  files: UseFilesResult;
  /** The key to share. */
  fileKey: string;
  /** `"download"` mints a `url()`; `"upload"` mints a `signedUploadUrl()`. Default `"download"`. */
  mode?: "download" | "upload";
  /** Initial expiry in seconds. Default `3600` (1 hour). */
  defaultExpiresIn?: number;
  /** Custom trigger. Defaults to a "Share" button. */
  children?: ReactNode;
  className?: string;
}

const EXPIRY_PRESETS = [
  { label: "5 min", seconds: 300 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
];

/**
 * A dialog that mints a shareable link for one key. Download links go through
 * `url()` (a signed URL where the adapter supports it, otherwise a public one);
 * upload links go through `signedUploadUrl()`. Pick an expiry, copy the result.
 */
export const ShareDialog = ({
  files,
  fileKey,
  mode = "download",
  defaultExpiresIn = 3600,
  children,
  className,
}: ShareDialogProps) => {
  const [open, setOpen] = useState(false);
  const [expiresIn, setExpiresIn] = useState(defaultExpiresIn);
  const [disposition, setDisposition] = useState<"attachment" | "inline">(
    "attachment"
  );
  const [url, setUrl] = useState<string>();
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [caps, setCaps] = useState<AdapterCapabilities>();

  const filesRef = useRef(files);
  filesRef.current = files;

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const result = await filesRef.current.capabilities();
        if (!cancelled) {
          setCaps(result);
        }
      } catch {
        // Non-fatal: we just lose the expiry clamp + support hint.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const maxExpiresIn = caps?.signedUrl.maxExpiresIn;
  const presets = EXPIRY_PRESETS.filter(
    (preset) => !maxExpiresIn || preset.seconds <= maxExpiresIn
  );

  const generate = useCallback(async () => {
    setIsGenerating(true);
    setCopied(false);
    setUrl(undefined);
    try {
      const ttl = maxExpiresIn ? Math.min(expiresIn, maxExpiresIn) : expiresIn;
      if (mode === "upload") {
        const signed = await filesRef.current.signedUploadUrl(fileKey, {
          expiresIn: ttl,
        });
        setUrl(signed.url);
      } else {
        const link = await filesRef.current.url(fileKey, {
          expiresIn: ttl,
          responseContentDisposition: disposition,
        });
        setUrl(link);
      }
    } catch {
      // The hook mirrors the error to `files.error` for display.
    } finally {
      setIsGenerating(false);
    }
  }, [mode, fileKey, expiresIn, disposition, maxExpiresIn]);

  const copy = useCallback(async () => {
    if (!url) {
      return;
    }
    await navigator.clipboard.writeText(url);
    setCopied(true);
  }, [url]);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        {children ?? (
          <Button
            className={className}
            size="sm"
            type="button"
            variant="outline"
          >
            <Link2Icon />
            Share
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "upload" ? "Upload link" : "Share link"}
          </DialogTitle>
          <DialogDescription className="truncate">{fileKey}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-sm">Expires after</span>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <Button
                  key={preset.seconds}
                  onClick={() => {
                    setExpiresIn(preset.seconds);
                    setUrl(undefined);
                  }}
                  size="xs"
                  type="button"
                  variant={preset.seconds === expiresIn ? "secondary" : "ghost"}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          </div>

          {mode === "download" && (
            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-sm">Open as</span>
              <div className="flex flex-wrap gap-1.5">
                {(["attachment", "inline"] as const).map((value) => (
                  <Button
                    key={value}
                    onClick={() => {
                      setDisposition(value);
                      setUrl(undefined);
                    }}
                    size="xs"
                    type="button"
                    variant={value === disposition ? "secondary" : "ghost"}
                  >
                    {value === "attachment" ? "Download" : "Inline"}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {caps && !caps.signedUrl.supported && mode === "download" && (
            <p className="text-muted-foreground text-xs">
              This adapter can't sign URLs, so the link is a permanent public
              URL and ignores the expiry.
            </p>
          )}

          {url ? (
            <div className="flex gap-2">
              <Input readOnly value={url} />
              <Button
                onClick={() => void copy()}
                type="button"
                variant="outline"
              >
                {copied ? (
                  <CheckIcon className="text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <CopyIcon />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : (
            <Button
              disabled={isGenerating}
              onClick={() => void generate()}
              type="button"
            >
              {isGenerating && <Loader2Icon className="animate-spin" />}
              Generate link
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
