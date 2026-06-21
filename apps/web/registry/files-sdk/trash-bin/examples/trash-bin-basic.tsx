"use client";

import { useFiles } from "files-sdk/react";

import { TrashBin } from "@/registry/files-sdk/trash-bin/trash-bin";

const Example = () => {
  // A demo gateway whose `Files` instance is wrapped with the `softDelete()`
  // plugin and seeded with a few soft-deleted files.
  const files = useFiles({ endpoint: "/api/files-trash" });

  return <TrashBin files={files} />;
};

export default Example;
