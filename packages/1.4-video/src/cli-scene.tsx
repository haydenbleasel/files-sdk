import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

import { totalChars } from "./code";
import type { Line } from "./code";
import { CodeWindow } from "./code-window";

const { fontFamily: geist } = loadGeist();

const FPS = 30;
const CHARS_PER_SEC = 48;
const ENTER = 18;
const EXIT = 16;

const LINES: Line[] = [
  [
    ["$ ", "kw"],
    ["files upload"],
    [" ./hero.jpg avatars/hero.jpg "],
    ["\\", "br"],
  ],
  [["    --provider "], ["s3 ", "str"], ["--bucket "], ["assets", "str"]],
  [['{ "key": "avatars/hero.jpg", "size": 12453, "etag": "9f0…" }', "cm"]],
  [],
  [["$ ", "kw"], ["files url"], [" avatars/hero.jpg "], ["\\", "br"]],
  [
    ["    --provider "],
    ["r2 ", "str"],
    ["--bucket "],
    ["assets ", "str"],
    ["--expires-in "],
    ["300", "str"],
  ],
  [['{ "url": "https://…/avatars/hero.jpg?…" }', "cm"]],
  [],
  [
    ["$ ", "kw"],
    ["files mcp"],
    [" --provider "],
    ["s3 ", "str"],
    ["--bucket "],
    ["assets", "str"],
  ],
  [["[mcp] stdio server ready — 9 tools exposed", "ok"]],
];

const TOTAL = totalChars(LINES);
const TYPE_FRAMES = Math.ceil((TOTAL / CHARS_PER_SEC) * FPS);
const DWELL = 40;
export const CLI_SCENE_DURATION = ENTER + TYPE_FRAMES + DWELL + EXIT;

export const CliScene: React.FC = () => {
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
    [CLI_SCENE_DURATION - EXIT, CLI_SCENE_DURATION - 2],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const exitLift = interpolate(
    frame,
    [CLI_SCENE_DURATION - EXIT, CLI_SCENE_DURATION - 2],
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
          New in 1.4
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
          One CLI. Every provider.
        </div>
      </div>
      <CodeWindow
        lines={LINES}
        budget={budget}
        filename="Terminal — files"
        showActiveLine={false}
      />
    </AbsoluteFill>
  );
};
