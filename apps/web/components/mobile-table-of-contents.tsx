import { ChevronDownIcon } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const sections = [
  { id: "why", label: "Why" },
  { id: "installation", label: "Installation" },
  { id: "quick-start", label: "Quick start" },
  { id: "adapters", label: "Adapters" },
  { id: "api-reference", label: "API reference" },
  { id: "the-storedfile-type", label: "The StoredFile type" },
  { id: "errors", label: "Errors" },
  { id: "escape-hatch", label: "Escape hatch" },
  { id: "ai-tools", label: "AI tools" },
  { id: "compatibility-matrix", label: "Compatibility matrix" },
];

export const MobileTableOfContents = () => (
  <Collapsible className="rounded-md border border-dotted lg:hidden">
    <CollapsibleTrigger className="group flex w-full cursor-pointer select-none items-center justify-between px-4 py-3 text-sm text-foreground">
      On this page
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-open:rotate-180" />
    </CollapsibleTrigger>
    <CollapsibleContent className="overflow-hidden data-open:animate-collapsible-down data-closed:animate-collapsible-up">
      <ul
        role="list"
        className="list-none! px-4! flex flex-col gap-1 border-t border-dotted py-3"
      >
        {sections.map(({ id, label }) => (
          <li className="text-sm" key={id}>
            <a
              className="block py-1 text-muted-foreground transition-colors hover:text-foreground"
              href={`#${id}`}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </CollapsibleContent>
  </Collapsible>
);
