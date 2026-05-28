"use client";

import { cn } from "@/lib/utils";

import { PANEL_CLASS } from "./panel";
import { EASE_PROGRESS, interpolate, useSceneFrame } from "./use-scene-frame";

const N_PARTS = 12;
const CONCURRENCY = 4;
const ASSEMBLE = 22;

// Per-part upload time in frames — varied so parts finish out of order.
const PART_DURATIONS = [30, 34, 28, 38, 26, 36, 32, 40, 28, 34, 30, 26];

interface Schedule {
  starts: number[];
  ends: number[];
  uploadEnd: number;
}

// Walk the parts through CONCURRENCY slots: each part starts when a slot frees,
// so only CONCURRENCY upload at once — the bounded-parallelism story.
const buildSchedule = (): Schedule => {
  const slotFree = Array.from({ length: CONCURRENCY }, () => 0);
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < N_PARTS; i += 1) {
    let slot = 0;
    for (let k = 1; k < CONCURRENCY; k += 1) {
      if (slotFree[k] < slotFree[slot]) {
        slot = k;
      }
    }
    const start = slotFree[slot];
    const end = start + PART_DURATIONS[i];
    starts.push(start);
    ends.push(end);
    slotFree[slot] = end;
  }
  return { ends, starts, uploadEnd: Math.max(...ends) };
};

const SCHEDULE = buildSchedule();
const TOTAL = SCHEDULE.uploadEnd + ASSEMBLE;

type PartStatus = "queued" | "uploading" | "done";

const partFraction = (index: number, frame: number): number =>
  interpolate(frame, [SCHEDULE.starts[index], SCHEDULE.ends[index]], [0, 1]);

const partStatus = (index: number, frame: number): PartStatus => {
  if (frame >= SCHEDULE.ends[index]) {
    return "done";
  }
  if (frame >= SCHEDULE.starts[index]) {
    return "uploading";
  }
  return "queued";
};

const TILE_STYLE: Record<PartStatus, string> = {
  done: "bg-emerald-500/10 border-emerald-500/30",
  queued: "bg-muted border-transparent",
  uploading: "bg-card border-foreground/40",
};

const LABEL_STYLE: Record<PartStatus, string> = {
  done: "text-emerald-600 dark:text-emerald-500",
  queued: "text-muted-foreground",
  uploading: "text-foreground",
};

const PartTile = ({ index, frame }: { index: number; frame: number }) => {
  const status = partStatus(index, frame);
  const fraction = partFraction(index, frame);

  return (
    <div
      className={cn(
        "flex h-12 flex-col justify-between rounded-md border p-2",
        TILE_STYLE[status]
      )}
    >
      <div className="flex items-center justify-between">
        <span className={cn("font-mono text-[11px]", LABEL_STYLE[status])}>
          Part {index + 1}
        </span>
        {status === "done" && (
          <span className="text-[11px] text-emerald-600 dark:text-emerald-500">
            ✓
          </span>
        )}
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className={cn(
            "h-full rounded-full",
            status === "done" ? "bg-emerald-500" : "bg-foreground"
          )}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
    </div>
  );
};

const Footer = ({ frame, doneCount }: { frame: number; doneCount: number }) => {
  const overall = interpolate(
    frame,
    [0, SCHEDULE.uploadEnd],
    [0, 1],
    EASE_PROGRESS
  );
  const uploaded = frame >= SCHEDULE.uploadEnd;
  const complete = frame >= SCHEDULE.uploadEnd + 10;

  let label = `${doneCount} / ${N_PARTS} parts`;
  if (complete) {
    label = "✓ Upload complete";
  } else if (uploaded) {
    label = "Assembling…";
  }

  return (
    <div className="flex h-14 items-center gap-4 border-t border-border px-5">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            complete ? "bg-emerald-500" : "bg-foreground"
          )}
          style={{ width: `${overall * 100}%` }}
        />
      </div>
      <span
        className={cn(
          "min-w-[7.5rem] text-right font-mono text-xs",
          complete
            ? "text-emerald-600 dark:text-emerald-500"
            : "text-muted-foreground"
        )}
      >
        {label}
      </span>
    </div>
  );
};

export const Multipart = () => {
  const { frame, ref } = useSceneFrame(TOTAL);
  const doneCount = SCHEDULE.starts.filter(
    (_, i) => partStatus(i, frame) === "done"
  ).length;

  return (
    <div className={PANEL_CLASS} ref={ref}>
      <div className="grid grid-cols-4 gap-2 p-5">
        {SCHEDULE.starts.map((_, i) => (
          <PartTile frame={frame} index={i} key={i} />
        ))}
      </div>
      <Footer doneCount={doneCount} frame={frame} />
    </div>
  );
};
