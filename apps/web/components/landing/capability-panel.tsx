"use client";

import { AiTools } from "@/components/capabilities/ai-tools";
import { ByteRange } from "@/components/capabilities/byte-range";
import { Cli } from "@/components/capabilities/cli";
import { LifecycleHooks } from "@/components/capabilities/lifecycle-hooks";
import { Methods } from "@/components/capabilities/methods";
import { Multipart } from "@/components/capabilities/multipart";
import { Search } from "@/components/capabilities/search";
import { Sync } from "@/components/capabilities/sync";
import { UploadProgress } from "@/components/capabilities/upload-progress";

const PANELS: Record<string, () => React.JSX.Element> = {
  "ai-tools": AiTools,
  "byte-range": ByteRange,
  cli: Cli,
  "lifecycle-hooks": LifecycleHooks,
  methods: Methods,
  multipart: Multipart,
  search: Search,
  sync: Sync,
  "upload-progress": UploadProgress,
};

// A single hydrated island that picks the right animated panel by key. Astro
// can only hydrate a statically-imported component, so the per-capability
// selection has to happen inside one island rather than via a dynamic
// `<Panel client:visible />` in the .astro file.
export default function CapabilityPanel({ panel }: { panel: string }) {
  const Panel = PANELS[panel];
  return Panel ? <Panel /> : null;
}
