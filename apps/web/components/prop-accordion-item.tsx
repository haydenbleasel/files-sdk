import type { ReactNode } from "react";

import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";

export type PropStatus = "required" | "optional";

interface PropAccordionItemProps {
  value: string;
  name: ReactNode;
  status?: PropStatus;
  /**
   * When true (default), the trigger renders `name` in a monospace span -
   * appropriate for prop/option identifiers. Set false for non-identifier
   * triggers like "Limitations" or "Storage layout".
   */
  monospace?: boolean;
  children: ReactNode;
}

export const PropAccordionItem = ({
  value,
  name,
  status,
  monospace = true,
  children,
}: PropAccordionItemProps) => (
  <AccordionItem className="border-dotted" value={value}>
    <AccordionTrigger>
      {/* `flex-1` here absorbs the trigger's free space so the badge sits
          next to the chevron on the right. `mr-auto` doesn't work because
          the chevron also has `ml-auto` (set by AccordionTrigger), and
          competing auto margins split the free space - leaving the badge
          stranded in the middle. */}
      {monospace ? (
        <span className="flex-1 font-mono text-sm">{name}</span>
      ) : (
        <span className="flex-1">{name}</span>
      )}
      {status && <Badge variant="secondary">{status}</Badge>}
    </AccordionTrigger>
    <AccordionContent>{children}</AccordionContent>
  </AccordionItem>
);
