import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

import { useTypewriter } from "./typewriter";

const { fontFamily: geist } = loadGeist();
const { fontFamily: geistMono } = loadGeistMono();

const COMMAND = "npm i files-sdk@1.4.0";

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <div
    style={{
      background: color,
      borderRadius: 6,
      height: 12,
      width: 12,
    }}
  />
);

export const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();

  const reveal = interpolate(frame, [0, 18], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateRight: "clamp",
  });
  const lift = interpolate(frame, [0, 18], [12, 0], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateRight: "clamp",
  });

  const exit = interpolate(frame, [78, 90], [1, 0], {
    easing: Easing.bezier(0.4, 0, 1, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exitLift = interpolate(frame, [78, 90], [0, -16], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const badgeReveal = interpolate(frame, [30, 50], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const badgeLift = interpolate(frame, [30, 50], [8, 0], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const typed = useTypewriter(COMMAND, 18, 16);
  const finishedTyping = typed.length >= COMMAND.length;
  const cursorOn = Math.floor(frame / 15) % 2 === 0;

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        opacity: reveal * exit,
        transform: `translateY(${lift + exitLift}px)`,
      }}
    >
      <div
        style={{
          backdropFilter: "blur(8px)",
          background: "rgba(251, 249, 244, 0.96)",
          borderRadius: 18,
          boxShadow:
            "0 30px 80px rgba(60, 40, 20, 0.25), 0 1px 0 rgba(255, 255, 255, 0.6) inset",
          fontFamily: geist,
          padding: "20px 24px 28px",
          width: 920,
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 8,
            marginBottom: 20,
          }}
        >
          <Dot color="#E8B6A8" />
          <Dot color="#EBD8A1" />
          <Dot color="#B8D4B0" />
        </div>
        <div
          style={{
            alignItems: "baseline",
            color: "#1F2937",
            display: "flex",
            fontFamily: geistMono,
            fontSize: 30,
            gap: 14,
            letterSpacing: -0.2,
          }}
        >
          <span style={{ color: "#059669" }}>$</span>
          <span>
            {typed}
            {!finishedTyping && cursorOn && (
              <span
                style={{
                  background: "#1F2937",
                  display: "inline-block",
                  height: 28,
                  marginLeft: 2,
                  transform: "translateY(4px)",
                  width: 12,
                }}
              />
            )}
          </span>
        </div>
      </div>
      <div
        style={{
          alignItems: "center",
          color: "rgba(255, 255, 255, 0.9)",
          display: "flex",
          fontFamily: geist,
          fontSize: 22,
          gap: 14,
          letterSpacing: -0.2,
          marginTop: 28,
          opacity: badgeReveal,
          textShadow: "0 1px 12px rgba(20, 12, 6, 0.40)",
          transform: `translateY(${badgeLift}px)`,
        }}
      >
        <span
          style={{
            background: "rgba(217, 119, 6, 0.18)",
            border: "1px solid rgba(217, 119, 6, 0.35)",
            borderRadius: 999,
            color: "#FDE68A",
            fontFamily: geistMono,
            fontSize: 16,
            letterSpacing: 0.4,
            padding: "5px 12px",
            textTransform: "uppercase",
          }}
        >
          v1.4
        </span>
        <span>9 new adapters · a CLI · agent skill file</span>
      </div>
    </AbsoluteFill>
  );
};
