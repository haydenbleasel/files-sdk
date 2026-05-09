"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

const sections = [
  { id: "why", label: "Why" },
  { id: "installation", label: "Installation" },
  { id: "quick-start", label: "Quick start" },
  { id: "adapters", label: "Adapters" },
  { id: "api-reference", label: "API reference" },
  { id: "the-storedfile-type", label: "The StoredFile type" },
  { id: "errors", label: "Errors" },
  { id: "escape-hatch", label: "Escape hatch" },
  { id: "compatibility-matrix", label: "Compatibility matrix" },
];

export const TableOfContents = () => {
  const [activeId, setActiveId] = useState<string>(sections[0].id);

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

    for (const { id } of sections) {
      const el = document.querySelector(`#${id}`);
      if (el) {
        observer.observe(el);
      }
    }

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <nav aria-label="On this page">
      <ul className="flex list-none flex-col gap-0 pl-0">
        {sections.map(({ id, label }) => (
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
          </li>
        ))}
      </ul>
    </nav>
  );
};
