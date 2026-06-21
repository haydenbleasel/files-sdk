"use client";

import { useFiles } from "files-sdk/react";

import {
  Dropzone,
  DropzoneContent,
  DropzoneEmptyState,
} from "@/registry/files-sdk/dropzone/dropzone";

const Example = () => {
  const files = useFiles({ endpoint: "/api/files" });

  return (
    <Dropzone accept="image/*" files={files} prefix="demo/">
      <DropzoneEmptyState />
      <DropzoneContent />
    </Dropzone>
  );
};

export default Example;
