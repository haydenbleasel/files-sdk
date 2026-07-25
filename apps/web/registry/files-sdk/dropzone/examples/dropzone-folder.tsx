"use client";

import { demoFiles } from "@/lib/demo-files";
import {
  Dropzone,
  DropzoneContent,
  DropzoneEmptyState,
  DropzoneError,
} from "@/registry/files-sdk/dropzone/dropzone";

const Example = () => {
  const files = demoFiles;

  return (
    <Dropzone directory files={files} prefix="skills/">
      <DropzoneContent />
      <DropzoneEmptyState />
      <DropzoneError />
    </Dropzone>
  );
};

export default Example;
