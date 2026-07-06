"use client";

import { demoFiles } from "@/lib/demo-files";
import { MultipartUploader } from "@/registry/files-sdk/multipart-uploader/multipart-uploader";

const Example = () => {
  const files = demoFiles;

  return <MultipartUploader files={files} prefix="demo/" />;
};

export default Example;
