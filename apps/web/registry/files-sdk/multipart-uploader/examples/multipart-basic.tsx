"use client";

import { useFiles } from "files-sdk/react";

import { MultipartUploader } from "@/registry/files-sdk/multipart-uploader/multipart-uploader";

const Example = () => {
  const files = useFiles({ endpoint: "/api/files" });

  return <MultipartUploader files={files} prefix="demo/" />;
};

export default Example;
