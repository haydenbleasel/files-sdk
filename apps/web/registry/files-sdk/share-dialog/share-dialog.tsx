"use client";

import type { AdapterCapabilities, SignedUpload } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";
import { CheckIcon, CopyIcon, Link2Icon, Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface ShareDialogProps {
  /** A `useFiles()` instance — the link is minted through it. */
  files: UseFilesResult;
  /** The key to share. */
  fileKey: string;
  /** `"download"` mints a `url()`; `"upload"` mints a `signedUploadUrl()`. Default `"download"`. */
  mode?: "download" | "upload";
  /** Initial expiry in seconds. Default `3600` (1 hour). */
  defaultExpiresIn?: number;
  /** Custom trigger content, rendered inside the trigger button. Defaults to a styled "Share" label. */
  children?: ReactNode;
  className?: string;
}

const EXPIRY_PRESETS = [
  { label: "5 min", seconds: 300 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 604_800 },
];

/** What the dialog minted: a download URL, or a full presigned upload target. */
type Minted =
  | { kind: "download"; url: string }
  | { kind: "upload"; target: SignedUpload };

/**
 * The upload target's required extras — PUT headers (e.g. Azure's
 * `x-ms-blob-type`) or POST form fields. The URL alone is unusable without
 * them, so they're shown and copied alongside it.
 */
const targetExtras = (target: SignedUpload): Record<string, string> =>
  target.method === "POST" ? target.fields : (target.headers ?? {});

interface MintedView {
  url: string;
  /** What Copy puts on the clipboard. */
  copyText: string;
  /** Required headers (PUT) or form fields (POST), as `[name, value]`. */
  extras: [string, string][];
  method?: SignedUpload["method"];
}

const viewOf = (minted: Minted): MintedView => {
  if (minted.kind === "download") {
    return { copyText: minted.url, extras: [], url: minted.url };
  }
  const { target } = minted;
  const extras = Object.entries(targetExtras(target));
  // A bare URL is enough for a header-less PUT; a POST form or required
  // headers need the whole target, so copy it as JSON.
  const copyText =
    target.method === "POST" || extras.length > 0
      ? JSON.stringify(target, null, 2)
      : target.url;
  return { copyText, extras, method: target.method, url: target.url };
};

const methodNote = (view: MintedView): string | undefined => {
  if (view.method === "POST") {
    return "Upload with a multipart/form-data POST to this URL, including these form fields before the file:";
  }
  if (view.method === "PUT") {
    return view.extras.length
      ? "Upload with an HTTP PUT to this URL, sending these headers:"
      : "Upload with an HTTP PUT to this URL.";
  }
  return undefined;
};

const MintedLink = ({
  copied,
  onCopy,
  view,
}: {
  copied: boolean;
  onCopy: () => void;
  view: MintedView;
}) => {
  let copyLabel = view.copyText === view.url ? "Copy" : "Copy details";
  if (copied) {
    copyLabel = "Copied";
  }
  const note = methodNote(view);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input aria-label="Link" readOnly value={view.url} />
        <Button onClick={onCopy} type="button" variant="outline">
          {copied ? (
            <CheckIcon className="text-emerald-600 dark:text-emerald-400" />
          ) : (
            <CopyIcon />
          )}
          {copyLabel}
        </Button>
      </div>
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
      {view.extras.length > 0 && (
        <pre className="bg-muted max-h-32 overflow-auto rounded-md p-2 text-xs">
          {view.extras.map(([name, value]) => `${name}: ${value}`).join("\n")}
        </pre>
      )}
    </div>
  );
};

/**
 * A dialog that mints a shareable link for one key. Download links go through
 * `url()` (a signed URL where the adapter supports it, otherwise a public one);
 * upload links go through `signedUploadUrl()` and show the method plus any
 * headers or form fields the target requires. Pick an expiry, copy the result.
 * The minted link resets when the dialog closes or `fileKey` / `mode` changes.
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
  const [minted, setMinted] = useState<Minted>();
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [caps, setCaps] = useState<AdapterCapabilities>();

  const filesRef = useRef(files);
  filesRef.current = files;

  // Bumped by every clear(), so a link that finishes minting after the dialog
  // closed or `fileKey` / `mode` changed is dropped instead of shown.
  const generationRef = useRef(0);

  const clear = useCallback(() => {
    generationRef.current += 1;
    setMinted(undefined);
    setCopied(false);
    setFeedback(undefined);
  }, []);

  // A link minted for one key/mode must never be offered for another.
  useEffect(() => {
    clear();
  }, [clear, fileKey, mode]);

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

  // Uploads and downloads have separate signing caps.
  const maxExpiresIn =
    mode === "upload"
      ? caps?.signedUpload.maxExpiresIn
      : caps?.signedUrl.maxExpiresIn;
  // An adapter that only hands out permanent download links can't honor an
  // expiry (v3 refuses one), so the link is minted without it.
  const expires = mode === "upload" || caps?.signedUrl.supported !== false;
  const presets = EXPIRY_PRESETS.filter(
    (preset) => !maxExpiresIn || preset.seconds <= maxExpiresIn
  );

  const generate = useCallback(async () => {
    setIsGenerating(true);
    clear();
    const generation = generationRef.current;
    const current = () => generation === generationRef.current;
    try {
      const ttl = maxExpiresIn ? Math.min(expiresIn, maxExpiresIn) : expiresIn;
      if (mode === "upload") {
        const target = await filesRef.current.signedUploadUrl(fileKey, {
          expiresIn: ttl,
        });
        if (current()) {
          setMinted({ kind: "upload", target });
        }
      } else {
        const url = await filesRef.current.url(fileKey, {
          ...(expires && { expiresIn: ttl }),
          responseContentDisposition: disposition,
        });
        if (current()) {
          setMinted({ kind: "download", url });
        }
      }
    } catch (error) {
      if (!current()) {
        return;
      }
      // Shown here as well as mirrored to `files.error` by the hook.
      setFeedback(
        `Couldn't create the link: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsGenerating(false);
    }
  }, [clear, mode, fileKey, expiresIn, disposition, maxExpiresIn, expires]);

  const view = minted ? viewOf(minted) : undefined;
  const copyText = view?.copyText;

  const copy = useCallback(async () => {
    if (!copyText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setFeedback(undefined);
    } catch {
      setFeedback(
        "Couldn't copy to the clipboard — select the link and copy it."
      );
    }
  }, [copyText]);

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          clear();
        }
      }}
      open={open}
    >
      {/* Styled via buttonVariants instead of asChild-wrapping a Button: the
          trigger must work with both the Radix and Base UI shadcn flavors, and
          Base UI has no asChild (nesting a Button renders <button> inside
          <button>). */}
      <DialogTrigger
        className={cn(
          !children && buttonVariants({ size: "sm", variant: "outline" }),
          className
        )}
      >
        {children ?? (
          <>
            <Link2Icon />
            Share
          </>
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
            <span className="text-sm font-medium">Expires after</span>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <Button
                  aria-pressed={preset.seconds === expiresIn}
                  key={preset.seconds}
                  onClick={() => {
                    setExpiresIn(preset.seconds);
                    clear();
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
              <span className="text-sm font-medium">Open as</span>
              <div className="flex flex-wrap gap-1.5">
                {(["attachment", "inline"] as const).map((value) => (
                  <Button
                    aria-pressed={value === disposition}
                    key={value}
                    onClick={() => {
                      setDisposition(value);
                      clear();
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

          {view ? (
            <MintedLink
              copied={copied}
              onCopy={() => {
                void copy();
              }}
              view={view}
            />
          ) : (
            <Button
              disabled={isGenerating}
              onClick={() => {
                void generate();
              }}
              type="button"
            >
              {isGenerating && <Loader2Icon className="animate-spin" />}
              Generate link
            </Button>
          )}

          {feedback && (
            <p className="text-destructive text-xs" role="alert">
              {feedback}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
