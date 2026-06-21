"use client";

import { useFiles } from "files-sdk/react";

import { FileList } from "@/registry/files-sdk/file-list/file-list";

const Example = () => {
  const files = useFiles({ endpoint: "/api/files" });

  return <FileList files={files} prefix="photos/" />;
};

export default Example;
