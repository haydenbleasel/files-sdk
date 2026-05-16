"use client";

import { ArrowRightIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";

import type { ReleaseSummary } from "@/lib/changelog";

interface UpdatesIndexProps {
  releases: ReleaseSummary[];
}

export const UpdatesIndex = ({ releases }: UpdatesIndexProps) => {
  const [query, setQuery] = useState("");
  const inputId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return releases;
    }
    return releases.filter(
      ({ version, searchText }) =>
        version.toLowerCase().includes(q) ||
        `v${version}`.toLowerCase().includes(q) ||
        searchText.includes(q)
    );
  }, [releases, query]);

  return (
    <section className="flex flex-col gap-6">
      <label className="sr-only" htmlFor={inputId}>
        Search releases
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
          placeholder={`Search ${releases.length} releases by version or content...`}
          type="search"
          value={query}
        />
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-md border border-dotted px-4 py-8 text-center text-sm text-muted-foreground">
          No releases match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <ul className="flex list-none flex-col gap-0 pl-0">
          {filtered.map(({ slug, version, itemCount, headline }) => (
            <li className="border-b border-dotted last:border-b-0" key={slug}>
              <Link
                className="group flex items-start gap-4 py-4 transition-colors hover:text-foreground"
                href={`/updates/${slug}`}
              >
                <div className="flex flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-foreground">
                      v{version}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {itemCount} {itemCount === 1 ? "change" : "changes"}
                    </span>
                  </div>
                  {headline ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground leading-relaxed">
                      {headline}
                    </p>
                  ) : null}
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
