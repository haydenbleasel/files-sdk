"use client";

import { demoFiles } from "@/lib/demo-files";
import { FileActions } from "@/registry/files-sdk/file-actions/file-actions";

const Example = () => {
  const files = demoFiles;

  return (
    <div className="border-border flex w-full max-w-sm items-center justify-between gap-4 rounded-lg border p-3">
      <span className="truncate text-sm font-medium">photos/sunset.jpg</span>
      <FileActions files={files} fileKey="photos/sunset.jpg" />
    </div>
  );
};

export default Example;
