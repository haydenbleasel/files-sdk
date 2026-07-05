"use client";

import { demoFiles } from "@/lib/demo-files";
import { CapabilitiesBadges } from "@/registry/files-sdk/capabilities-badges/capabilities-badges";

const Example = () => {
  const files = demoFiles;

  return <CapabilitiesBadges files={files} />;
};

export default Example;
