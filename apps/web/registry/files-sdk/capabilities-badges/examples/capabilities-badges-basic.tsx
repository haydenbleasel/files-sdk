"use client";

import { useFiles } from "files-sdk/react";

import { CapabilitiesBadges } from "@/registry/files-sdk/capabilities-badges/capabilities-badges";

const Example = () => {
  const files = useFiles({ endpoint: "/api/files" });

  return <CapabilitiesBadges files={files} />;
};

export default Example;
