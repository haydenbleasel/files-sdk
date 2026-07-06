"use client";

import { UploadIcon } from "lucide-react";
import type { ChangeEvent } from "react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { demoFiles } from "@/lib/demo-files";
import { FilePreview } from "@/registry/files-sdk/file-preview/file-preview";

const Example = () => {
  const files = demoFiles;
  const inputRef = useRef<HTMLInputElement>(null);
  // Start on a seeded image so the preview is populated; uploading swaps it out.
  const [key, setKey] = useState<string>("photos/sunset.jpg");

  const handleChange = async (event: ChangeEvent<HTMLInputElement>) => {
    // Capture the element now — React nulls `currentTarget` after the handler's
    // synchronous phase, so it's gone by the time the upload below resolves.
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    const result = await files.upload(`demo/${file.name}`, file, {
      contentType: file.type,
    });
    setKey(result.key);
    input.value = "";
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button
          onClick={() => inputRef.current?.click()}
          type="button"
          variant="outline"
        >
          <UploadIcon />
          Choose a file
        </Button>
        <input
          accept="image/*,text/*,application/pdf"
          aria-label="Choose a file to preview"
          className="hidden"
          onChange={(event) => void handleChange(event)}
          ref={inputRef}
          type="file"
        />
      </div>
      <FilePreview file={key} files={files} />
    </div>
  );
};

export default Example;
