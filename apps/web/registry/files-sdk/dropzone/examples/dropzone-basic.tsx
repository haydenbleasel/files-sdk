"use client";

import { demoFiles } from "@/lib/demo-files";
import {
  Dropzone,
  DropzoneContent,
  DropzoneEmptyState,
} from "@/registry/files-sdk/dropzone/dropzone";

const Example = () => {
  const files = demoFiles;

  return (
    <Dropzone accept="image/*" files={files} prefix="demo/">
      <DropzoneEmptyState />
      <DropzoneContent />
    </Dropzone>
  );
};

export default Example;
