"use client";

import { cn } from "@/lib/utils";

import { PANEL_CLASS } from "./panel";
import { EASE_PROGRESS, interpolate, useSceneFrame } from "./use-scene-frame";

interface Row {
  name: string;
  size: string;
  start: number;
  end: number;
}

// Each file fills at its own rate and settles at a different time — the visual
// payoff of per-key onProgress. `start`/`end` are frames within the scene.
const ROWS: Row[] = [
  { end: 26, name: "logo.png", size: "240 KB", start: 3 },
  { end: 34, name: "hero.jpg", size: "4.2 MB", start: 0 },
  { end: 92, name: "promo.mp4", size: "128 MB", start: 6 },
  { end: 108, name: "db.tar", size: "210 MB", start: 10 },
];

const TOTAL = Math.max(...ROWS.map((row) => row.end));

const FileBar = ({ row, frame }: { row: Row; frame: number }) => {
  const frac = interpolate(frame, [row.start, row.end], [0, 1], EASE_PROGRESS);
  const done = frac >= 1;

  return (
    <div className="flex flex-col gap-2 px-5 py-2.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-sm text-foreground">{row.name}</span>
        <span className="flex items-baseline gap-3 font-mono text-xs text-muted-foreground">
          <span>{row.size}</span>
          <span
            className={cn(
              "min-w-[2.5rem] text-right",
              done
                ? "text-emerald-600 dark:text-emerald-500"
                : "text-muted-foreground"
            )}
          >
            {done ? "done" : `${Math.round(frac * 100)}%`}
          </span>
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            done ? "bg-emerald-500" : "bg-foreground"
          )}
          style={{ width: `${frac * 100}%` }}
        />
      </div>
    </div>
  );
};

export const UploadProgress = () => {
  const { frame, ref } = useSceneFrame(TOTAL);

  return (
    <div className={PANEL_CLASS} ref={ref}>
      <div className="py-2">
        {ROWS.map((row) => (
          <FileBar frame={frame} key={row.name} row={row} />
        ))}
      </div>
    </div>
  );
};
