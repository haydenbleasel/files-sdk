"use client";

import { useState } from "react";

import { demoFiles } from "@/lib/demo-files";
import { FileBrowser } from "@/registry/files-sdk/file-browser/file-browser";

const Example = () => {
  const files = demoFiles;
  const [selected, setSelected] = useState<string>();

  return (
    <div className="flex w-full max-w-md flex-col gap-3">
      <FileBrowser
        files={files}
        initialPrefix="documents/"
        onSelect={(file) => setSelected(file.key)}
      />
      {selected && (
        <p className="text-muted-foreground text-xs">Selected: {selected}</p>
      )}
    </div>
  );
};

export default Example;
