"use client";

import { demoFiles } from "@/lib/demo-files";
import { TrashBin } from "@/registry/files-sdk/trash-bin/trash-bin";

const Example = () => {
  // The docs preview has no gateway: `demoFiles` is a static stand-in for
  // `useFiles()` whose `trashed()` returns a canned list and whose restore and
  // purge only log. In an app, pass `useFiles()` against a gateway whose
  // `Files` instance uses the `softDelete()` plugin.
  const files = demoFiles;

  return <TrashBin files={files} />;
};

export default Example;
