"use client";

import { Check, Search as SearchIcon } from "lucide-react";

import { PANEL_CLASS } from "./panel";
import { EASE_OUT, interpolate, useSceneFrame } from "./use-scene-frame";

// A glob types into the search bar, then the matches stream in underneath, one
// per beat. `**` spans folders, so results come from nested prefixes.
const PATTERN = "invoices/**/*.pdf";

interface Result {
  key: string;
  size: string;
}

const RESULTS: Result[] = [
  { key: "invoices/2024/q1.pdf", size: "184 KB" },
  { key: "invoices/2024/q2.pdf", size: "176 KB" },
  { key: "invoices/2023/q4.pdf", size: "201 KB" },
  { key: "invoices/2023/q3.pdf", size: "192 KB" },
];

const TYPE_END = 30;
// A short beat after the query is typed, results stream in top-to-bottom.
const RESULTS_START = 42;
const ROW_STEP = 10;
const APPEAR = 12;
const appearAt = (index: number) => RESULTS_START + index * ROW_STEP;
const TOTAL = appearAt(RESULTS.length - 1) + APPEAR + 8;

const Cursor = () => (
  <span className="bg-foreground ml-px inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse" />
);

const Row = ({
  result,
  index,
  frame,
}: {
  result: Result;
  index: number;
  frame: number;
}) => {
  const at = appearAt(index);
  const opacity = interpolate(frame, [at, at + APPEAR], [0, 1]);
  const lift = interpolate(frame, [at, at + APPEAR], [10, 0], EASE_OUT);
  // A brief emerald wash as each match lands, fading out over 18 frames.
  const flash = frame < at ? 0 : interpolate(frame, [at, at + 18], [0.12, 0]);

  return (
    <div
      className="px-3"
      style={{ opacity, transform: `translateY(${lift}px)` }}
    >
      <div
        className="flex items-center justify-between rounded-md px-2.5 py-2"
        style={
          flash > 0
            ? { backgroundColor: `rgba(16, 185, 129, ${flash})` }
            : undefined
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
          <span className="text-foreground truncate font-mono text-sm">
            {result.key}
          </span>
        </span>
        <span className="text-muted-foreground shrink-0 pl-3 font-mono text-xs">
          {result.size}
        </span>
      </div>
    </div>
  );
};

export const Search = () => {
  const { frame, ref } = useSceneFrame(TOTAL);

  const typed = Math.round(
    interpolate(frame, [0, TYPE_END], [0, PATTERN.length])
  );
  const typing = frame < TYPE_END;

  // Tick the count up as each match lands; fade the badge in with the results.
  const found = RESULTS.filter(
    (_, i) => frame >= appearAt(i) + APPEAR / 2
  ).length;
  const badge = interpolate(frame, [RESULTS_START, RESULTS_START + 8], [0, 1]);

  return (
    <div className={PANEL_CLASS} ref={ref}>
      <div className="border-border bg-sidebar flex h-12 items-center gap-2 border-b px-5">
        <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-foreground flex-1 truncate font-mono text-xs">
          {PATTERN.slice(0, typed)}
          {typing && <Cursor />}
        </span>
        <span
          className="shrink-0 font-mono text-[11px] text-emerald-600 tabular-nums dark:text-emerald-500"
          style={{ opacity: badge }}
        >
          {found} {found === 1 ? "match" : "matches"}
        </span>
      </div>
      <div className="space-y-0.5 py-2">
        {RESULTS.map((result, index) => (
          <Row frame={frame} index={index} key={result.key} result={result} />
        ))}
      </div>
    </div>
  );
};
