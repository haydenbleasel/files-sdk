"use client";

import { useFiles } from "files-sdk/react";

import { FileActions } from "@/registry/files-sdk/file-actions/file-actions";

const Example = () => {
  const files = useFiles({ endpoint: "/api/files" });

  return (
    <div className="flex items-center justify-between rounded-lg border border-border p-3">
      <span className="font-medium text-sm">photos/sunset.jpg</span>
      <FileActions files={files} fileKey="photos/sunset.jpg" />
    </div>
  );
};

export default Example;
