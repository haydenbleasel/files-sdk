"use client";

import { useFiles } from "files-sdk/react";

import { ShareDialog } from "@/registry/files-sdk/share-dialog/share-dialog";

const Example = () => {
  const files = useFiles({ endpoint: "/api/files" });

  return <ShareDialog files={files} fileKey="photos/sunset.jpg" />;
};

export default Example;
