"use client";

import type { SearchMatch, StoredFile } from "files-sdk";
import type { UseFilesResult } from "files-sdk/react";
import { FileIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface FileSearchProps {
  /** A `useFiles()` instance — matches are streamed through `search()`. */
  files: UseFilesResult;
  /** Limit the search to keys under this prefix. */
  prefix?: string;
  /** Match mode shown first. Default `"substring"`. */
  defaultMatch?: SearchMatch;
  /** Cap on results collected per search. Default `100`. */
  maxResults?: number;
  /** Called when a result row is clicked. */
  onSelect?: (file: StoredFile) => void;
  className?: string;
}

const MATCH_MODES: SearchMatch[] = ["substring", "glob", "regex", "exact"];

const formatBytes = (bytes: number): string => {
  if (bytes === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

/**
 * A search box for a `useFiles()` instance. Streams `search()` results into a
 * list and lets you switch match mode (substring, glob, regex, exact) and toggle
 * case sensitivity. The previous search is aborted when a new one starts.
 */
export const FileSearch = ({
  files,
  prefix,
  defaultMatch = "substring",
  maxResults = 100,
  onSelect,
  className,
}: FileSearchProps) => {
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState<SearchMatch>(defaultMatch);
  const [caseInsensitive, setCaseInsensitive] = useState(true);
  const [results, setResults] = useState<StoredFile[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const filesRef = useRef(files);
  filesRef.current = files;
  // A per-search controller so a new query cancels the in-flight generator.
  const controllerRef = useRef<AbortController>(null);
  const caseId = useId();

  const run = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!query.trim()) {
        return;
      }
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setIsSearching(true);
      setHasSearched(true);
      setResults([]);
      try {
        const found: StoredFile[] = [];
        for await (const file of filesRef.current.search(query, {
          caseInsensitive,
          match,
          maxResults,
          prefix,
          signal: controller.signal,
        })) {
          found.push(file);
        }
        if (!controller.signal.aborted) {
          setResults(found);
        }
      } catch {
        // The hook mirrors the error to `files.error`; an invalid regex lands here.
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
      }
    },
    [query, match, caseInsensitive, maxResults, prefix]
  );

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <form className="flex flex-col gap-2" onSubmit={run}>
        <div className="flex gap-2">
          <Input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search keys…"
            value={query}
          />
          <Button disabled={isSearching || !query.trim()} type="submit">
            {isSearching ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <SearchIcon />
            )}
            Search
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {MATCH_MODES.map((mode) => (
            <Button
              key={mode}
              onClick={() => setMatch(mode)}
              size="xs"
              type="button"
              variant={mode === match ? "secondary" : "ghost"}
            >
              {mode}
            </Button>
          ))}
          <label
            className="ml-auto flex items-center gap-1.5 text-muted-foreground text-xs"
            htmlFor={caseId}
          >
            <input
              aria-label="Case-insensitive"
              checked={caseInsensitive}
              className="size-3.5 accent-primary"
              id={caseId}
              onChange={(event) => setCaseInsensitive(event.target.checked)}
              type="checkbox"
            />
            Case-insensitive
          </label>
        </div>
      </form>

      {hasSearched && !isSearching && (
        <p className="text-muted-foreground text-xs">
          {results.length} {results.length === 1 ? "match" : "matches"}
        </p>
      )}

      <ul className="flex flex-col gap-1">
        {results.map((file) => (
          <li key={file.key}>
            <button
              className="flex w-full items-center gap-3 rounded-lg border border-border p-2 text-left transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
              disabled={!onSelect}
              onClick={() => onSelect?.(file)}
              type="button"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                <FileIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sm">
                  {file.key}
                </span>
                <span className="block text-muted-foreground text-xs">
                  {formatBytes(file.size)} · {file.type || "unknown"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
