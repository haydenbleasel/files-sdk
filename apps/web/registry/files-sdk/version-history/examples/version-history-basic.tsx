"use client";

import { useFiles } from "files-sdk/react";

import { VersionHistory } from "@/registry/files-sdk/version-history/version-history";

const Example = () => {
  // A demo gateway whose `Files` instance is wrapped with the `versioning()`
  // plugin and seeded with a short edit history for `notes.txt`.
  const files = useFiles({ endpoint: "/api/files-versions" });

  return <VersionHistory files={files} fileKey="notes.txt" />;
};

export default Example;
