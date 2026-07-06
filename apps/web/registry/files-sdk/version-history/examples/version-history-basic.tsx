"use client";

import { demoFiles } from "@/lib/demo-files";
import { VersionHistory } from "@/registry/files-sdk/version-history/version-history";

const Example = () => {
  // A demo gateway whose `Files` instance is wrapped with the `versioning()`
  // plugin and seeded with a short edit history for `notes.txt`.
  const files = demoFiles;

  return <VersionHistory files={files} fileKey="notes.txt" />;
};

export default Example;
