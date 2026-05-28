"use client";

import { PANEL_CLASS } from "./panel";
import { interpolate, useSceneFrame } from "./use-scene-frame";

// The command types out, then the JSON result streams in line by line —
// `--json` output is one object per line — and the prompt returns.
const COMMAND = "files --provider s3 list --prefix reports/";

const OUTPUT = [
  '{"key":"reports/q1.pdf","size":184320}',
  '{"key":"reports/q2.pdf","size":201618}',
  '{"key":"reports/q3.pdf","size":176244}',
];

const TYPE_END = 30;
const OUTPUT_START = 40;
const OUTPUT_STEP = 12;
const PROMPT_AT = OUTPUT_START + OUTPUT.length * OUTPUT_STEP;
const TOTAL = PROMPT_AT + 6;

const Cursor = () => (
  <span className="ml-px inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-foreground" />
);

export const Cli = () => {
  const { frame, ref } = useSceneFrame(TOTAL);
  const typed = Math.round(
    interpolate(frame, [0, TYPE_END], [0, COMMAND.length])
  );
  const typing = frame < TYPE_END;

  return (
    <div className={PANEL_CLASS} ref={ref}>
      <div className="space-y-1.5 px-5 py-4 font-mono text-xs leading-relaxed">
        <div className="text-foreground">
          <span className="text-muted-foreground">$ </span>
          {COMMAND.slice(0, typed)}
          {typing && <Cursor />}
        </div>
        {OUTPUT.map((line, i) => {
          const appearAt = OUTPUT_START + i * OUTPUT_STEP;
          return (
            <div
              className="text-muted-foreground"
              key={line}
              style={{
                opacity: interpolate(frame, [appearAt, appearAt + 8], [0, 1]),
              }}
            >
              {line}
            </div>
          );
        })}
        <div
          className="text-foreground"
          style={{
            opacity: interpolate(frame, [PROMPT_AT, PROMPT_AT + 4], [0, 1]),
          }}
        >
          <span className="text-muted-foreground">$ </span>
          {!typing && <Cursor />}
        </div>
      </div>
    </div>
  );
};
