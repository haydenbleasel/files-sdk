import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

import { totalChars } from "./code";
import type { Line } from "./code";
import { CodeWindow } from "./code-window";

const { fontFamily: geist } = loadGeist();
const { fontFamily: geistMono } = loadGeistMono();

const FPS = 30;
const CHARS_PER_SEC = 52;
const ENTER = 18;
const EXIT = 16;
const BULLET_START = 70;
const BULLET_STAGGER = 10;

const LINES: Line[] = [
  [
    ["$ ", "kw"],
    ["npx skills add"],
    [" "],
    ["github.com/haydenbleasel/files-sdk", "str"],
  ],
  [
    ["✓ added skill: ", "ok"],
    ["files-sdk", "fn"],
  ],
  [["  ~/.claude/skills/files-sdk/SKILL.md", "cm"]],
];

const TOTAL = totalChars(LINES);
const TYPE_FRAMES = Math.ceil((TOTAL / CHARS_PER_SEC) * FPS);
const DWELL = 70;
export const SKILL_SCENE_DURATION = ENTER + TYPE_FRAMES + DWELL + EXIT;

const BULLETS = [
  "Picks the right adapter for the host",
  "Wires env vars, types, and AI-SDK tools",
  "Source of truth, not training-data memory",
];

const Bullet: React.FC<{
  text: string;
  index: number;
  frame: number;
}> = ({ text, index, frame }) => {
  const start = BULLET_START + index * BULLET_STAGGER;
  const opacity = interpolate(frame, [start, start + 14], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const lift = interpolate(frame, [start, start + 14], [10, 0], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        alignItems: "center",
        color: "rgba(255, 255, 255, 0.92)",
        display: "flex",
        fontFamily: geist,
        fontSize: 22,
        gap: 14,
        letterSpacing: -0.2,
        opacity,
        textShadow: "0 1px 12px rgba(20, 12, 6, 0.40)",
        transform: `translateY(${lift}px)`,
      }}
    >
      <span
        style={{
          background: "rgba(253, 230, 138, 0.18)",
          border: "1px solid rgba(253, 230, 138, 0.35)",
          borderRadius: 999,
          color: "#FDE68A",
          fontFamily: geistMono,
          fontSize: 13,
          height: 26,
          letterSpacing: 0.2,
          lineHeight: "24px",
          padding: "0 10px",
        }}
      >
        ✦
      </span>
      <span>{text}</span>
    </div>
  );
};

export const SkillScene: React.FC = () => {
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
    [SKILL_SCENE_DURATION - EXIT, SKILL_SCENE_DURATION - 2],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const exitLift = interpolate(
    frame,
    [SKILL_SCENE_DURATION - EXIT, SKILL_SCENE_DURATION - 2],
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
          A Claude skill, one install away.
        </div>
      </div>
      <CodeWindow
        lines={LINES}
        budget={budget}
        filename="Terminal"
        showActiveLine={false}
        width={1100}
      />
      <div
        style={{
          alignItems: "flex-start",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginTop: 6,
        }}
      >
        {BULLETS.map((text, i) => (
          <Bullet key={text} text={text} index={i} frame={frame} />
        ))}
      </div>
    </AbsoluteFill>
  );
};
