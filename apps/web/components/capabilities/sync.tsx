"use client";

import { cn } from "@/lib/utils";

import { PANEL_CLASS } from "./panel";
import { EASE_PROGRESS, interpolate, useSceneFrame } from "./use-scene-frame";

type Outcome = "uploaded" | "skipped" | "deleted";

interface Row {
  name: string;
  outcome: Outcome;
  settle: number;
}

// Each key resolves to one of sync's three outcomes at a staggered frame —
// uploaded (new or changed), skipped (already identical), or pruned (gone from
// the source). Mirrors the { uploaded, skipped, deleted } result shape.
const ROWS: Row[] = [
  { name: "reports/q1.pdf", outcome: "uploaded", settle: 16 },
  { name: "img/logo.png", outcome: "skipped", settle: 28 },
  { name: "img/hero.jpg", outcome: "skipped", settle: 40 },
  { name: "data/2026.csv", outcome: "uploaded", settle: 54 },
  { name: "tmp/legacy.zip", outcome: "deleted", settle: 68 },
];

const SETTLE_LAST = Math.max(...ROWS.map((row) => row.settle));
const TOTAL = SETTLE_LAST + 14;

const OUTCOME: Record<Outcome, { dot: string; label: string; pill: string }> = {
  deleted: {
    dot: "bg-red-500",
    label: "pruned",
    pill: "bg-red-500/10 text-red-600 dark:text-red-500",
  },
  skipped: {
    dot: "bg-muted-foreground/40",
    label: "unchanged",
    pill: "bg-muted text-muted-foreground",
  },
  uploaded: {
    dot: "bg-emerald-500",
    label: "uploaded",
    pill: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-500",
  },
};

const Pill = ({ outcome }: { outcome: Outcome }) => {
  const style = OUTCOME[outcome];
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px]",
        style.pill
      )}
    >
      <span className={cn("size-1.5 rounded-full", style.dot)} />
      {style.label}
    </span>
  );
};

const Scanning = () => (
  <span className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
    <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/50" />
    comparing…
  </span>
);

const SyncRow = ({ frame, row }: { frame: number; row: Row }) => {
  const settled = frame >= row.settle;
  const pruned = settled && row.outcome === "deleted";

  return (
    <div className="flex items-center justify-between px-5 py-2.5">
      <span
        className={cn(
          "font-mono text-sm transition-colors",
          pruned ? "text-muted-foreground line-through" : "text-foreground"
        )}
      >
        {row.name}
      </span>
      {settled ? <Pill outcome={row.outcome} /> : <Scanning />}
    </div>
  );
};

export const Sync = () => {
  const { frame, ref } = useSceneFrame(TOTAL);
  const progress = interpolate(frame, [0, SETTLE_LAST], [0, 1], EASE_PROGRESS);
  const done = frame >= SETTLE_LAST;

  return (
    <div className={PANEL_CLASS} ref={ref}>
      <div className="flex items-center justify-between px-5 pt-4 font-mono text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          Syncing
          <img
            alt="S3"
            className="size-4 rounded-[3px]"
            src="/adapters/s3.svg"
          />
          <span className="text-foreground">S3</span>
          to
          <img
            alt="R2"
            className="size-4 rounded-[3px]"
            src="/adapters/r2.svg"
          />
          <span className="text-foreground">R2</span>
        </span>
        <span
          className={cn(
            done
              ? "text-emerald-600 dark:text-emerald-500"
              : "text-muted-foreground"
          )}
        >
          {done ? "✓ in sync" : "mirroring…"}
        </span>
      </div>

      <div className="px-5 pt-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              done ? "bg-emerald-500" : "bg-foreground"
            )}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      <div className="py-2">
        {ROWS.map((row) => (
          <SyncRow frame={frame} key={row.name} row={row} />
        ))}
      </div>
    </div>
  );
};
