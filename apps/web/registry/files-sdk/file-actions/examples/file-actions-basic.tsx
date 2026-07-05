"use client";

import { demoFiles } from "@/lib/demo-files";
import { FileActions } from "@/registry/files-sdk/file-actions/file-actions";

const Example = () => {
  const files = demoFiles;

  return (
    <div className="flex items-center justify-between rounded-lg border border-border p-3">
      <span className="font-medium text-sm">photos/sunset.jpg</span>
      <FileActions files={files} fileKey="photos/sunset.jpg" />
    </div>
  );
};

export default Example;
