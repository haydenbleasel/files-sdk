"use client";

import { UploadIcon } from "lucide-react";
import type { ChangeEvent } from "react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { demoFiles } from "@/lib/demo-files";
import { UploadProgress } from "@/registry/files-sdk/upload-progress/upload-progress";

const Example = () => {
  const files = demoFiles;
  const inputRef = useRef<HTMLInputElement>(null);

  // Read `files` via a ref so this one-shot effect never re-runs on store
  // changes (see the file-list/file-preview note on the loop footgun).
  const filesRef = useRef(files);
  filesRef.current = files;

  // Kick off a sample upload on mount so the progress UI starts populated.
  useEffect(() => {
    const bytes = new Uint8Array(3 * 1024 * 1024);
    const sample = new File([bytes], "vacation-photo.jpg", {
      type: "image/jpeg",
    });
    void filesRef.current.upload(sample);
  }, []);

  const handleChange = async (event: ChangeEvent<HTMLInputElement>) => {
    // Capture the element now — React nulls `currentTarget` after the handler's
    // synchronous phase, so it's gone by the time the uploads below resolve.
    const input = event.currentTarget;
    const picked = input.files;
    if (!picked?.length) {
      return;
    }
    for (const file of picked) {
      // eslint-disable-next-line no-await-in-loop -- demo uploads files one at a time so progress reads cleanly
      await files.upload(`demo/${file.name}`, file, {
        contentType: file.type,
      });
    }
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
          Choose files
        </Button>
        <input
          aria-label="Choose files to upload"
          className="hidden"
          multiple
          onChange={(event) => void handleChange(event)}
          ref={inputRef}
          type="file"
        />
      </div>
      <UploadProgress files={files} />
    </div>
  );
};

export default Example;
