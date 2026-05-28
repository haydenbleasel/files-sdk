"use client";

import { cn } from "@/lib/utils";

import { PANEL_CLASS } from "./panel";
import { EASE_OUT, interpolate, useSceneFrame } from "./use-scene-frame";

type Verb = "copy" | "delete" | "list" | "move" | "upload";

interface Op {
  call: string;
  verb: Verb;
}

// One call per step; the store on the right reacts to each — a row appears on
// upload and copy, a key is rewritten on move, a row is struck on delete, and
// the prefix match lights up on list.
const OPS: Op[] = [
  { call: '("report.pdf", body)', verb: "upload" },
  { call: '("report.pdf", "backup/report.pdf")', verb: "copy" },
  { call: '("tmp/hero.jpg", "img/hero.jpg")', verb: "move" },
  { call: '("db.tar")', verb: "delete" },
  { call: '({ prefix: "img/" })', verb: "list" },
];

interface Slot {
  createdBy?: number;
  deletedBy?: number;
  key: string;
  matchBy?: number;
  renameTo?: string;
  renamedBy?: number;
  size: string;
}

const SLOTS: Slot[] = [
  { deletedBy: 3, key: "db.tar", size: "210 MB" },
  {
    key: "tmp/hero.jpg",
    matchBy: 4,
    renameTo: "img/hero.jpg",
    renamedBy: 2,
    size: "4.2 MB",
  },
  { createdBy: 0, key: "report.pdf", size: "184 KB" },
  { createdBy: 1, key: "backup/report.pdf", size: "184 KB" },
];

const START = 8;
// Within each step the command types out (TYPE frames), pauses, then the store
// reacts REACT_DELAY frames in — the gap is what reads as cause → effect.
const TYPE = 30;
const REACT_DELAY = 38;
const STEP = 56;
const TOTAL = START + OPS.length * STEP;

const PREFIX = "files.";

const VERB_STYLE: Record<Verb, string> = {
  copy: "text-sky-600 dark:text-sky-400",
  delete: "text-destructive",
  list: "text-violet-600 dark:text-violet-400",
  move: "text-amber-600 dark:text-amber-500",
  upload: "text-emerald-600 dark:text-emerald-500",
};

// `-500` RGB per verb, used as the translucent flash a row gets the moment its
// op lands — emerald on upload, sky on copy, amber on move.
const VERB_GLOW: Record<Verb, string> = {
  copy: "14, 165, 233",
  delete: "239, 68, 68",
  list: "139, 92, 246",
  move: "245, 158, 11",
  upload: "16, 185, 129",
};

// When op `i` is issued vs. when the store reacts to it.
const opFrame = (i: number) => START + i * STEP;
const reactFrame = (i: number) => opFrame(i) + REACT_DELAY;

const Cursor = () => (
  <span className="ml-px inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-foreground" />
);

const Row = ({ slot, frame }: { slot: Slot; frame: number }) => {
  const born = slot.createdBy === undefined ? 0 : reactFrame(slot.createdBy);
  const opacity = interpolate(frame, [born, born + 12], [0, 1]);
  const lift = interpolate(frame, [born, born + 12], [10, 0], EASE_OUT);

  const renamed =
    slot.renamedBy !== undefined && frame >= reactFrame(slot.renamedBy);
  const key = renamed && slot.renameTo ? slot.renameTo : slot.key;
  const deleted =
    slot.deletedBy !== undefined && frame >= reactFrame(slot.deletedBy);
  const matched =
    slot.matchBy !== undefined && frame >= reactFrame(slot.matchBy);

  // Colored flash the moment an op touches the row — its creation (upload/copy),
  // rename (move), or deletion (delete) — fading out over 22 frames. Gated on the
  // op having fired so the clamped interpolate doesn't pin it to 0.16 beforehand.
  const glowBy = slot.renamedBy ?? slot.createdBy ?? slot.deletedBy;
  const glow =
    glowBy === undefined || frame < reactFrame(glowBy)
      ? 0
      : interpolate(
          frame,
          [reactFrame(glowBy), reactFrame(glowBy) + 22],
          [0.16, 0]
        );
  const glowColor = glowBy === undefined ? "" : VERB_GLOW[OPS[glowBy].verb];

  return (
    <div
      className="px-3"
      style={{ opacity, transform: `translateY(${lift}px)` }}
    >
      <div
        className={cn(
          "flex items-center justify-between rounded-md px-2.5 py-2 transition-colors",
          matched && "bg-violet-500/10"
        )}
        style={
          glow > 0
            ? { backgroundColor: `rgba(${glowColor}, ${glow})` }
            : undefined
        }
      >
        <span
          className={cn(
            "truncate font-mono text-sm",
            deleted ? "text-muted-foreground line-through" : "text-foreground"
          )}
        >
          {key}
        </span>
        <span className="shrink-0 pl-3 font-mono text-xs text-muted-foreground">
          {deleted ? "deleted" : slot.size}
        </span>
      </div>
    </div>
  );
};

export const Methods = () => {
  const { frame, ref } = useSceneFrame(TOTAL);

  const active = Math.min(
    OPS.length - 1,
    Math.max(0, Math.floor((frame - START) / STEP))
  );
  const op = OPS[active];

  // Each command is cleared and typed out fresh from the moment its op fires —
  // resetting `typed` to 0 at the step boundary is what wipes the previous line.
  const full = PREFIX + op.verb + op.call;
  const local = frame - opFrame(active);
  const typed = Math.round(interpolate(local, [0, TYPE], [0, full.length]));
  const verbShown = op.verb.slice(0, Math.max(0, typed - PREFIX.length));
  const callShown = op.call.slice(
    0,
    Math.max(0, typed - PREFIX.length - op.verb.length)
  );

  return (
    <div className={PANEL_CLASS} ref={ref}>
      <div className="flex h-12 items-center border-b border-border bg-sidebar px-5">
        <span className="truncate font-mono text-xs text-muted-foreground">
          {PREFIX.slice(0, typed)}
          <span className={VERB_STYLE[op.verb]}>{verbShown}</span>
          {callShown}
          <Cursor />
        </span>
      </div>
      <div className="space-y-0.5 py-2">
        {SLOTS.map((slot) => (
          <Row frame={frame} key={slot.key} slot={slot} />
        ))}
      </div>
    </div>
  );
};
