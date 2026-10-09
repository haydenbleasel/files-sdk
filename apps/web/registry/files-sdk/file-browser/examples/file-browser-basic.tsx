"use client";

import { useState } from "react";

import { demoFiles } from "@/lib/demo-files";
import { FileBrowser } from "@/registry/files-sdk/file-browser/file-browser";

const Example = () => {
  const files = demoFiles;
  const [folder, setFolder] = useState("");
  const [selected, setSelected] = useState<string>();

  return (
    <div className="flex w-full max-w-md flex-col gap-3">
      <FileBrowser
        files={files}
        initialPrefix="documents/"
        onNavigate={setFolder}
        onSelect={(file) => setSelected(file.key)}
      />
      <p className="text-muted-foreground text-xs">
        Open folder: {folder || "(root)"}
        {selected && ` · Selected: ${selected}`}
      </p>
    </div>
  );
};

export default Example;
