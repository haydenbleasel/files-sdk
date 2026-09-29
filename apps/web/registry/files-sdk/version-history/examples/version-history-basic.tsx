"use client";

import { demoFiles } from "@/lib/demo-files";
import { VersionHistory } from "@/registry/files-sdk/version-history/version-history";

const Example = () => {
  // The docs preview has no gateway: `demoFiles` is a static stand-in for
  // `useFiles()` whose `versions()` returns a canned three-snapshot history and
  // whose `restoreVersion()` only logs. In an app, pass `useFiles()` against a
  // gateway whose `Files` instance uses the `versioning()` plugin.
  const files = demoFiles;

  return <VersionHistory files={files} fileKey="notes.txt" />;
};

export default Example;
