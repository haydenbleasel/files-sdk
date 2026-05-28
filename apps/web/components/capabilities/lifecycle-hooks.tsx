"use client";

import { cn } from "@/lib/utils";

import { PANEL_CLASS } from "./panel";
import { interpolate, useSceneFrame } from "./use-scene-frame";

type Kind = "ok" | "retry" | "error";

interface Event {
  type: string;
  hook: string;
  detail: string;
  kind: Kind;
}

// A constructor-level hook fires once per settled operation. The feed streams
// onAction / onRetry / onError as operations flow through, success or failure.
const EVENTS: Event[] = [
  { detail: "142ms", hook: "onAction", kind: "ok", type: "upload" },
  { detail: "88ms", hook: "onAction", kind: "ok", type: "download" },
  { detail: "attempt 1", hook: "onRetry", kind: "retry", type: "upload" },
  { detail: "206ms", hook: "onAction", kind: "ok", type: "upload" },
  { detail: "NotFound", hook: "onError", kind: "error", type: "delete" },
  { detail: "51ms", hook: "onAction", kind: "ok", type: "list" },
];

const STEP = 16;
const TOTAL = EVENTS.length * STEP;

const DOT_STYLE: Record<Kind, string> = {
  error: "bg-destructive",
  ok: "bg-emerald-500",
  retry: "bg-amber-500",
};

const HOOK_STYLE: Record<Kind, string> = {
  error: "text-destructive",
  ok: "text-emerald-600 dark:text-emerald-500",
  retry: "text-amber-600 dark:text-amber-500",
};

const EventRow = ({
  event,
  appearAt,
  frame,
}: {
  event: Event;
  appearAt: number;
  frame: number;
}) => {
  const opacity = interpolate(frame, [appearAt, appearAt + 10], [0, 1]);
  const lift = interpolate(frame, [appearAt, appearAt + 10], [8, 0]);

  return (
    <div
      className="flex items-center justify-between px-5 py-2.5"
      style={{ opacity, transform: `translateY(${lift}px)` }}
    >
      <span className="flex items-center gap-2.5">
        <span className={cn("size-1.5 rounded-full", DOT_STYLE[event.kind])} />
        <span className="font-mono text-sm text-foreground">
          files.{event.type}
        </span>
      </span>
      <span className="flex items-baseline gap-3 font-mono text-xs">
        <span className={HOOK_STYLE[event.kind]}>{event.hook}</span>
        <span className="min-w-[5rem] text-right text-muted-foreground">
          {event.detail}
        </span>
      </span>
    </div>
  );
};

export const LifecycleHooks = () => {
  const { frame, ref } = useSceneFrame(TOTAL);

  return (
    <div className={PANEL_CLASS} ref={ref}>
      <div className="py-1.5">
        {EVENTS.map((event, i) => (
          <EventRow
            appearAt={i * STEP}
            event={event}
            frame={frame}
            key={`${event.type}-${event.hook}-${i}`}
          />
        ))}
      </div>
    </div>
  );
};
