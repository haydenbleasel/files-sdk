"use client";

import { ArrowRightIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";

export interface AdaptersIndexEntry {
  slug: string;
  name: string;
  description: string;
}

interface AdaptersIndexProps {
  adapters: AdaptersIndexEntry[];
}

const normalize = (value: string) => value.toLowerCase().trim();

export const AdaptersIndex = ({ adapters }: AdaptersIndexProps) => {
  const [query, setQuery] = useState("");
  const inputId = useId();

  const filtered = useMemo(() => {
    const q = normalize(query);
    if (!q) {
      return adapters;
    }
    return adapters.filter(
      ({ name, slug, description }) =>
        normalize(name).includes(q) ||
        normalize(slug).includes(q) ||
        normalize(description).includes(q)
    );
  }, [adapters, query]);

  return (
    <section className="flex flex-col gap-6">
      <label htmlFor={inputId} className="sr-only">
        Search adapters
      </label>
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          autoComplete="off"
          className="w-full rounded-md border border-dotted bg-transparent py-2.5 pr-3 pl-9 text-sm placeholder:text-muted-foreground focus:outline-1 focus:outline-ring"
          id={inputId}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${adapters.length} adapters by name, slug, or keyword...`}
          type="search"
          value={query}
        />
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-md border border-dotted px-4 py-8 text-center text-sm text-muted-foreground">
          No adapters match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <ul className="flex list-none flex-col gap-0 pl-0">
          {filtered.map(({ slug, name, description }) => (
            <li className="border-dotted border-b last:border-b-0" key={slug}>
              <Link
                className="group flex items-start gap-4 py-4 transition-colors hover:text-foreground"
                href={`/adapters/${slug}`}
              >
                <div className="flex flex-1 flex-col gap-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {name}
                    </span>
                    <code className="text-xs text-muted-foreground">
                      files-sdk/{slug}
                    </code>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {description}
                  </p>
                </div>
                <ArrowRightIcon
                  aria-hidden
                  className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
