"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

export interface TocSection {
  id: string;
  label: string;
  children?: { id: string; label: string }[];
}

interface TableOfContentsProps {
  sections: TocSection[];
}

export const TableOfContents = ({ sections }: TableOfContentsProps) => {
  const [activeId, setActiveId] = useState<string>(sections[0]?.id ?? "");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .toSorted(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top
          );
        if (visible[0]) {
          setActiveId(visible[0].target.id);
        }
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 0 }
    );

    const ids = sections.flatMap(({ id, children }) => [
      id,
      ...(children?.map((child) => child.id) ?? []),
    ]);

    for (const id of ids) {
      const el = document.querySelector(`#${id}`);
      if (el) {
        observer.observe(el);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, [sections]);

  const activeParentId = sections.find(
    ({ id, children }) =>
      id === activeId || children?.some((child) => child.id === activeId)
  )?.id;

  return (
    <nav aria-label="On this page">
      <ul className="flex list-none flex-col gap-0 pl-0">
        {sections.map(({ id, label, children }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={cn(
                "block -ml-px border-l py-1 pl-4 text-xs leading-relaxed transition-colors",
                activeId === id
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </a>
            {children && activeParentId === id ? (
              <ul className="flex list-none flex-col gap-0 pl-0">
                {children.map((child) => (
                  <li key={child.id}>
                    <a
                      href={`#${child.id}`}
                      className={cn(
                        "block -ml-px border-l py-1 pl-8 text-xs leading-relaxed transition-colors",
                        activeId === child.id
                          ? "border-foreground text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {child.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </nav>
  );
};
