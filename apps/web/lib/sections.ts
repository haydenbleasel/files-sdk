import type { TocSection } from "@/components/table-of-contents";

export const HOME_SECTIONS: TocSection[] = [
  { id: "why", label: "Why" },
  { id: "installation", label: "Installation" },
  { id: "quick-start", label: "Quick start" },
  { id: "compatibility-matrix", label: "Compatibility matrix" },
];

export const AI_SECTIONS: TocSection[] = [
  { id: "openai-tools", label: "OpenAI" },
  { id: "ai-sdk-tools", label: "Vercel AI SDK" },
  { id: "claude-tools", label: "Claude Agent SDK" },
];

export const CLI_SECTIONS: TocSection[] = [
  { id: "cli-install", label: "Install" },
  { id: "cli-providers", label: "Pick a provider" },
  { id: "cli-commands", label: "Commands" },
  { id: "cli-output", label: "JSON output & exit codes" },
  { id: "cli-streaming", label: "Streaming & dry-run" },
  { id: "cli-mcp", label: "MCP server" },
  { id: "cli-agents", label: "Wiring agents" },
];

export const API_SECTIONS: TocSection[] = [
  {
    children: [
      { id: "files-upload", label: "upload" },
      { id: "files-download", label: "download" },
      { id: "files-head", label: "head" },
      { id: "files-exists", label: "exists" },
      { id: "files-delete", label: "delete" },
      { id: "files-copy", label: "copy" },
      { id: "files-list", label: "list" },
      { id: "files-url", label: "url" },
      { id: "files-signed-upload-url", label: "signedUploadUrl" },
      { id: "files-file", label: "file" },
    ],
    id: "functions",
    label: "Functions",
  },
  { id: "the-storedfile-type", label: "The StoredFile type" },
  { id: "errors", label: "Errors" },
  { id: "escape-hatch", label: "Escape hatch" },
];

export const flattenSections = (
  sections: TocSection[]
): { id: string; label: string }[] =>
  sections.flatMap(({ id, label, children }) => [
    { id, label },
    ...(children ?? []),
  ]);
