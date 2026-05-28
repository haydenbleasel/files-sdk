"use client";

import { Download, List, Trash2, Upload } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { PANEL_CLASS } from "./panel";
import { interpolate, useSceneFrame } from "./use-scene-frame";

type Status = "ok" | "pending";

interface Call {
  Icon: LucideIcon;
  arg: string;
  detail: string;
  status: Status;
  tool: string;
}

// The model works the prompt by calling the generated file tools in turn, shown
// as a chain-of-thought trace. Reads run straight through; the gated write
// (deleteFile) settles on "awaiting approval" — the requireApproval contract,
// made visible.
const CALLS: Call[] = [
  {
    Icon: List,
    arg: "invoices/",
    detail: "24 files",
    status: "ok",
    tool: "listFiles",
  },
  {
    Icon: Download,
    arg: "invoices/mar.pdf",
    detail: "182 KB",
    status: "ok",
    tool: "downloadFile",
  },
  {
    Icon: Upload,
    arg: "archive/mar.pdf",
    detail: "done",
    status: "ok",
    tool: "uploadFile",
  },
  {
    Icon: Trash2,
    arg: "invoices/mar.pdf",
    detail: "awaiting approval",
    status: "pending",
    tool: "deleteFile",
  },
];

// The user bubble fades in, then a beat later the reasoning trace unfolds.
const PROMPT_IN = 10;
const START = 22;
const STEP = 18;
const TOTAL = START + CALLS.length * STEP;

const Step = ({
  call,
  appearAt,
  frame,
  last,
}: {
  call: Call;
  appearAt: number;
  frame: number;
  last: boolean;
}) => {
  const opacity = interpolate(frame, [appearAt, appearAt + 10], [0, 1]);
  const lift = interpolate(frame, [appearAt, appearAt + 10], [6, 0]);
  const pending = call.status === "pending";

  return (
    <div
      className="flex gap-3"
      style={{ opacity, transform: `translateY(${lift}px)` }}
    >
      {/* rail: a node capping the line, which grows down to the next step */}
      <div className="flex flex-col items-center">
        <span className="z-10 flex size-5 shrink-0 items-center justify-center rounded-full bg-card">
          <call.Icon
            className={cn(
              "size-3 text-muted-foreground",
              pending && "animate-pulse"
            )}
          />
        </span>
        {!last && <span className="w-px flex-1 bg-border" />}
      </div>
      <div className={cn("min-w-0", last ? "pb-0" : "pb-5")}>
        <div className="truncate font-mono text-sm text-foreground">
          {call.tool}
          <span className="text-muted-foreground">{`("${call.arg}")`}</span>
        </div>
        <div
          className={cn(
            "mt-0.5 font-mono text-xs",
            pending
              ? "text-amber-600 dark:text-amber-500"
              : "text-muted-foreground"
          )}
        >
          {call.detail}
        </div>
      </div>
    </div>
  );
};

export const AiTools = () => {
  const { frame, ref } = useSceneFrame(TOTAL);
  const promptOpacity = interpolate(frame, [0, PROMPT_IN], [0, 1]);
  const promptLift = interpolate(frame, [0, PROMPT_IN], [6, 0]);

  return (
    <div className={PANEL_CLASS} ref={ref}>
      <div
        className="flex justify-end px-5 pt-5 pb-4"
        style={{
          opacity: promptOpacity,
          transform: `translateY(${promptLift}px)`,
        }}
      >
        <p className="max-w-[80%] text-pretty rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          Archive last month's invoices to /archive.
        </p>
      </div>
      <div className="px-5 pb-5">
        {CALLS.map((call, i) => (
          <Step
            appearAt={START + i * STEP}
            call={call}
            frame={frame}
            key={call.tool}
            last={i === CALLS.length - 1}
          />
        ))}
      </div>
    </div>
  );
};
