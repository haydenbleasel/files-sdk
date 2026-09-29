"use client";

import type { FileUploadState, UseFilesResult } from "files-sdk/react";
import { UploadIcon } from "lucide-react";
import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { demoFiles } from "@/lib/demo-files";
import { UploadProgress } from "@/registry/files-sdk/upload-progress/upload-progress";

// The docs preview has no gateway, so it simulates the ambient `uploads` /
// `progress` state a real `useFiles()` instance exposes: four seeded files
// (and anything you pick) advance on a timer, one sample fails and one is
// cancelled, so every row state shows. In an app you pass `useFiles()`
// directly — see Usage below.

interface Simulated {
  state: FileUploadState;
  /** Fraction of the file sent per tick. */
  step: number;
  /** Stop here with this terminal status instead of finishing. */
  stopAt?: { fraction: number; status: "error" | "aborted" };
}

const TICK_MS = 250;

const simulate = (
  file: File,
  step: number,
  stopAt?: Simulated["stopAt"],
  // Seeded samples are empty Files with a pretend size, so the preview
  // doesn't allocate megabytes just to draw a bar.
  size = file.size
): Simulated => ({
  state: {
    file,
    loaded: 0,
    name: file.name,
    progress: 0,
    size,
    status: "pending",
    total: size,
    type: file.type || "application/octet-stream",
  },
  step,
  stopAt,
});

const seeded = (): Simulated[] => [
  simulate(
    new File([], "notes.txt", { type: "text/plain" }),
    0.5,
    undefined,
    20 * 1024
  ),
  simulate(
    new File([], "report.pdf", { type: "application/pdf" }),
    0.12,
    { fraction: 0.6, status: "error" },
    1200 * 1024
  ),
  simulate(
    new File([], "vacation-photo.jpg", { type: "image/jpeg" }),
    0.04,
    undefined,
    3 * 1024 * 1024
  ),
  simulate(
    new File([], "draft.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    0.1,
    { fraction: 0.3, status: "aborted" },
    900 * 1024
  ),
];

const advance = (item: Simulated): Simulated => {
  const { state, step, stopAt } = item;
  if (state.status !== "pending" && state.status !== "uploading") {
    return item;
  }
  const progress = Math.min(1, state.progress + step);
  if (stopAt && progress >= stopAt.fraction) {
    return {
      ...item,
      state: { ...state, status: stopAt.status },
    };
  }
  return {
    ...item,
    state: {
      ...state,
      loaded: Math.round(progress * state.total),
      progress,
      status: progress >= 1 ? "success" : "uploading",
    },
  };
};

const Example = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Simulated[]>(seeded);

  const isActive = items.some(
    ({ state }) => state.status === "pending" || state.status === "uploading"
  );

  useEffect(() => {
    if (!isActive) {
      return;
    }
    const timer = setInterval(() => {
      setItems((prev) => prev.map(advance));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [isActive]);

  const files = useMemo<UseFilesResult>(() => {
    const uploads = items.map(({ state }) => state);
    let loaded = 0;
    let total = 0;
    for (const upload of uploads) {
      loaded += upload.loaded;
      total += upload.total;
    }
    return {
      ...demoFiles,
      isUploading: isActive,
      progress: { fraction: total === 0 ? 0 : loaded / total, loaded, total },
      // Like the hook's reset(): clear finished rows, keep in-flight ones.
      reset: () =>
        setItems((prev) =>
          prev.filter(
            ({ state }) =>
              state.status === "pending" || state.status === "uploading"
          )
        ),
      uploads,
    };
  }, [isActive, items]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = "";
    setItems((prev) => [
      ...prev,
      ...picked.map((file) => simulate(file, 0.08)),
    ]);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Button
          onClick={() => inputRef.current?.click()}
          type="button"
          variant="outline"
        >
          <UploadIcon />
          Choose files
        </Button>
        <Button onClick={() => files.reset()} type="button" variant="ghost">
          Clear finished
        </Button>
        <input
          aria-label="Choose files to upload"
          className="hidden"
          multiple
          onChange={handleChange}
          ref={inputRef}
          type="file"
        />
      </div>
      <UploadProgress files={files} />
    </div>
  );
};

export default Example;
