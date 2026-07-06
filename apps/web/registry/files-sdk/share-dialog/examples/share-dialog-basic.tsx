"use client";

import { demoFiles } from "@/lib/demo-files";
import { ShareDialog } from "@/registry/files-sdk/share-dialog/share-dialog";

const Example = () => {
  const files = demoFiles;

  return <ShareDialog files={files} fileKey="photos/sunset.jpg" />;
};

export default Example;
