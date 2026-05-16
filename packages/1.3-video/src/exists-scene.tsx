import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

import { totalChars } from "./code";
import type { Line } from "./code";
import { CodeWindow } from "./code-window";

const { fontFamily: geist } = loadGeist();

const FPS = 30;
const CHARS_PER_SEC = 42;
const ENTER = 18;
const EXIT = 16;

const LINES: Line[] = [
  [
    ["import", "kw"],
    [" { Files } "],
    ["from", "kw"],
    [" "],
    ["'files-sdk'", "str"],
  ],
  [
    ["import", "kw"],
    [" { s3 } "],
    ["from", "kw"],
    [" "],
    ["'files-sdk/s3'", "str"],
  ],
  [],
  [["const", "kw"], [" files = "], ["new", "kw"], [" Files({"]],
  [
    ["  adapter: "],
    ["s3", "fn"],
    ["({ bucket: "],
    ["'uploads'", "str"],
    [", region: "],
    ["'us-east-1'", "str"],
    [" })"],
  ],
  [["})"]],
  [],
  [
    ["const", "kw"],
    [" hero = "],
    ["await", "kw"],
    [" files."],
    ["exists", "fn"],
    ["("],
    ["'hero.jpg'", "str"],
    [")"],
  ],
  [
    ["// → ", "cm"],
    ["true", "ok"],
  ],
  [
    ["const", "kw"],
    [" ghost = "],
    ["await", "kw"],
    [" files."],
    ["exists", "fn"],
    ["("],
    ["'ghost.png'", "str"],
    [")"],
  ],
  [
    ["// → ", "cm"],
    ["false", "no"],
  ],
];

const TOTAL = totalChars(LINES);
const TYPE_FRAMES = Math.ceil((TOTAL / CHARS_PER_SEC) * FPS);
const DWELL = 30;
export const EXISTS_SCENE_DURATION = ENTER + TYPE_FRAMES + DWELL + EXIT;

export const ExistsScene: React.FC = () => {
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
    [EXISTS_SCENE_DURATION - EXIT, EXISTS_SCENE_DURATION - 2],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const exitLift = interpolate(
    frame,
    [EXISTS_SCENE_DURATION - EXIT, EXISTS_SCENE_DURATION - 2],
    [0, -14],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const typingFrame = Math.max(0, frame - ENTER);
  const budget = Math.min(
    TOTAL,
    Math.floor((typingFrame / FPS) * CHARS_PER_SEC)
  );

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
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div
          style={{
            color: "#FDE68A",
            fontFamily: geist,
            fontSize: 15,
            letterSpacing: 0.6,
            textShadow: "0 1px 10px rgba(20, 12, 6, 0.40)",
            textTransform: "uppercase",
          }}
        >
          New in 1.3
        </div>
        <div
          style={{
            color: "#FFFFFF",
            fontFamily: geist,
            fontSize: 44,
            fontWeight: 600,
            letterSpacing: -1.2,
            textShadow:
              "0 2px 20px rgba(20, 12, 6, 0.45), 0 1px 2px rgba(20, 12, 6, 0.30)",
          }}
        >
          files.exists()
        </div>
      </div>
      <CodeWindow
        lines={LINES}
        budget={budget}
        filename="src/check.ts"
        showActiveLine
      />
    </AbsoluteFill>
  );
};
