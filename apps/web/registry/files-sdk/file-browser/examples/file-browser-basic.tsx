"use client";

import { useState } from "react";

import { demoFiles } from "@/lib/demo-files";
import { FileBrowser } from "@/registry/files-sdk/file-browser/file-browser";

const Example = () => {
  const files = demoFiles;
  const [selected, setSelected] = useState<string>();

  return (
    <div className="flex flex-col gap-3">
      <FileBrowser files={files} onSelect={(file) => setSelected(file.key)} />
      {selected && (
        <p className="text-muted-foreground text-xs">Selected: {selected}</p>
      )}
    </div>
  );
};

export default Example;
