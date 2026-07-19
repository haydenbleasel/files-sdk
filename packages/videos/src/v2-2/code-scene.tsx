import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

import { totalChars } from "../shared/code";
import type { Line } from "../shared/code";
import { CodeWindow } from "../shared/code-window";
import { SceneTitle } from "./scene-title";

export const FPS = 30;
const CHARS_PER_SEC = 55;
const ENTER = 18;
const EXIT = 16;
const DEFAULT_DWELL = 50;

/**
 * Frames a single-feature scene takes: enter + type-out + dwell + exit. Each
 * code-only scene exports its own duration (computed from its lines) so the
 * timeline in `timings.ts` can lay scenes back-to-back.
 */
export const codeSceneDuration = (
  lines: Line[],
  dwell: number = DEFAULT_DWELL
): number => {
  const typeFrames = Math.ceil((totalChars(lines) / CHARS_PER_SEC) * FPS);
  return ENTER + typeFrames + dwell + EXIT;
};

/** Chars typed by a given local frame, used to drive a paired UI panel. */
export const typedBudget = (frame: number, lines: Line[]): number =>
  Math.min(
    totalChars(lines),
    Math.floor((Math.max(0, frame - ENTER) / FPS) * CHARS_PER_SEC)
  );

interface CodeSceneProps {
  lines: Line[];
  title: string;
  filename: string;
  duration: number;
  eyebrow?: string;
  highlightLines?: readonly number[];
  width?: number;
}

export const CodeScene: React.FC<CodeSceneProps> = ({
  lines,
  title,
  filename,
  duration,
  eyebrow,
  highlightLines,
  width = 1100,
}) => {
  const frame = useCurrentFrame();

  const enterOpacity = interpolate(frame, [0, ENTER], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const enterLift = interpolate(frame, [0, ENTER], [16, 0], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exitOpacity = interpolate(
    frame,
    [duration - EXIT, duration - 2],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const exitLift = interpolate(
    frame,
    [duration - EXIT, duration - 2],
    [0, -14],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }
  );

  const budget = typedBudget(frame, lines);

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        flexDirection: "column",
        gap: 28,
        justifyContent: "center",
        opacity: enterOpacity * exitOpacity,
        transform: `translateY(${enterLift + exitLift}px)`,
      }}
    >
      <SceneTitle eyebrow={eyebrow} title={title} />
      <CodeWindow
        budget={budget}
        filename={filename}
        highlightLines={highlightLines}
        lines={lines}
        showActiveLine={false}
        width={width}
      />
    </AbsoluteFill>
  );
};
