"use client";

import { demoFiles } from "@/lib/demo-files";
import { FileList } from "@/registry/files-sdk/file-list/file-list";

const Example = () => {
  const files = demoFiles;

  return <FileList files={files} prefix="documents/" />;
};

export default Example;
