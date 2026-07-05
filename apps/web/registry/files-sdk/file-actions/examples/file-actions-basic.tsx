"use client";

import { demoFiles } from "@/lib/demo-files";
import { FileActions } from "@/registry/files-sdk/file-actions/file-actions";

const Example = () => {
  const files = demoFiles;

  return (
    <div className="flex w-full max-w-sm items-center justify-between gap-4 rounded-lg border border-border p-3">
      <span className="truncate font-medium text-sm">photos/sunset.jpg</span>
      <FileActions files={files} fileKey="photos/sunset.jpg" />
    </div>
  );
};

export default Example;
