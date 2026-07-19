---
"files-sdk": patch
---

Fix the `file-actions` and `share-dialog` registry components on Base UI-based shadcn projects. Their triggers were composed with Radix-style `asChild`, which Base UI ignores — nesting a `Button` inside the trigger's own `<button>` and causing a nested-button hydration error. The triggers are now styled directly with `buttonVariants()`, which renders identically on both the Radix and Base UI flavors. The `children` prop on both components now supplies custom trigger content (rendered inside the trigger button) rather than a replacement element.
