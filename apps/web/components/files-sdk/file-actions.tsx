// Registry components must import each other by their install-target path
// (`@/components/files-sdk/...`) so the shadcn CLI can rewrite the specifier
// to the consumer's aliases on install. This shim makes that path resolve to
// the registry source inside this app too.
export {
  FileActions,
  type FileActionsProps,
} from "@/registry/files-sdk/file-actions/file-actions";
