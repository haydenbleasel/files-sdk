"use client";

import { cn } from "@/lib/utils";

import { PANEL_CLASS } from "./panel";
import { EASE_SCRUB, interpolate, useSceneFrame } from "./use-scene-frame";

const TOTAL = 112;

// 48 MiB clip, read in 4 MiB ranged chunks
const TOTAL_BYTES = 50_331_648;
const CHUNK = 4_194_304;
const TOTAL_SECONDS = 135;
// playhead settles at 80% of the clip
const SCRUB_TO = 0.8;

const positionAt = (frame: number): number =>
  interpolate(frame, [0, TOTAL], [0, SCRUB_TO], EASE_SCRUB);

const chunkAt = (frame: number): number =>
  Math.floor((positionAt(frame) * TOTAL_BYTES) / CHUNK);

const fmtTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
};

const PlayGlyph = ({ playing }: { playing: boolean }) =>
  playing ? (
    <span className="flex gap-1">
      <span className="h-3.5 w-1 bg-foreground" />
      <span className="h-3.5 w-1 bg-foreground" />
    </span>
  ) : (
    <span className="size-0 border-y-[7px] border-l-[12px] border-y-transparent border-l-foreground" />
  );

export const ByteRange = () => {
  const { frame, ref } = useSceneFrame(TOTAL);
  const pos = positionAt(frame);
  const playing = frame > 0 && frame < TOTAL;

  const currentByte = Math.floor(pos * TOTAL_BYTES);
  const chunk = Math.floor(currentByte / CHUNK);
  const rangeStart = chunk * CHUNK;
  const rangeEnd = Math.min(rangeStart + CHUNK - 1, TOTAL_BYTES - 1);
  const buffered = Math.min(1, ((chunk + 1) * CHUNK) / TOTAL_BYTES);
  const justSeeked = chunkAt(frame) !== chunkAt(frame - 6);

  return (
    <div className={PANEL_CLASS} ref={ref}>
      <div
        className="relative flex h-44 items-center justify-center"
        style={{
          background:
            "radial-gradient(120% 120% at 30% 20%, #2c2c2c, #0a0a0a 70%)",
        }}
      >
        <span className="absolute top-4 left-4 font-mono text-xs text-white/50">
          video.mp4
        </span>
        <span
          className={cn(
            "flex size-14 items-center justify-center rounded-full bg-white/90",
            !playing && "pl-1"
          )}
        >
          <PlayGlyph playing={playing} />
        </span>
        <span className="absolute right-4 bottom-4 rounded bg-black/50 px-2 py-0.5 font-mono text-xs text-white/85">
          {fmtTime(TOTAL_SECONDS)}
        </span>
      </div>

      <div className="flex items-center gap-4 px-5 pt-4 pb-3">
        <PlayGlyph playing={playing} />
        <div className="relative h-1.5 flex-1 rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground/25"
            style={{ width: `${buffered * 100}%` }}
          />
          <div
            className="absolute top-0 h-full rounded-full bg-foreground"
            style={{ width: `${pos * 100}%` }}
          />
          <div
            className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-sm ring-2 ring-card"
            style={{ left: `${pos * 100}%` }}
          />
        </div>
        <span className="min-w-[5.5rem] text-right font-mono text-xs text-muted-foreground">
          {fmtTime(pos * TOTAL_SECONDS)} / {fmtTime(TOTAL_SECONDS)}
        </span>
      </div>

      <div className="flex h-12 items-center justify-between border-t border-border px-5">
        <span
          className={cn(
            "-mx-1.5 rounded px-1.5 py-0.5 font-mono text-xs text-foreground transition-colors",
            justSeeked ? "bg-foreground/10" : "bg-transparent"
          )}
        >
          bytes={rangeStart}-{rangeEnd}
        </span>
        <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-600 dark:text-emerald-500">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          206 Partial Content
        </span>
      </div>
    </div>
  );
};
