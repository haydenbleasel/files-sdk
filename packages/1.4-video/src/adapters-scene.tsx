import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

import { NEW_ADAPTERS } from "./adapters";
import type { AdapterEntry } from "./adapters";

const { fontFamily: geist } = loadGeist();
const { fontFamily: geistMono } = loadGeistMono();

const ROW_ONE_COUNT = 3;
const CHIP_WIDTH = 360;
const CHIP_GAP = 18;
const CHIP_DELAY = 7;
const FIRST_CHIP_AT = 16;
const EXIT_START = 127;
const EXIT_END = 147;

export const ADAPTERS_SCENE_DURATION = 147;

const AdapterChip: React.FC<{
  entry: AdapterEntry;
  appearFrame: number;
  currentFrame: number;
}> = ({ entry, appearFrame, currentFrame }) => {
  const opacity = interpolate(
    currentFrame,
    [appearFrame, appearFrame + 16],
    [0, 1],
    {
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }
  );
  const lift = interpolate(
    currentFrame,
    [appearFrame, appearFrame + 16],
    [14, 0],
    {
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }
  );
  const chipScale = interpolate(
    currentFrame,
    [appearFrame, appearFrame + 16],
    [0.92, 1],
    {
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }
  );

  return (
    <div
      style={{
        alignItems: "center",
        background: "#FBF9F4",
        borderRadius: 14,
        boxShadow:
          "0 18px 40px rgba(60, 40, 20, 0.22), 0 1px 0 rgba(255, 255, 255, 0.6) inset",
        display: "flex",
        gap: 14,
        height: 76,
        opacity,
        padding: "0 22px",
        transform: `translateY(${lift}px) scale(${chipScale})`,
        width: 360,
      }}
    >
      <div
        style={{
          background: entry.color,
          borderRadius: 10,
          boxShadow: `0 0 0 4px ${entry.color}22`,
          height: 14,
          width: 14,
        }}
      />
      <div
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          gap: 2,
          minWidth: 0,
        }}
      >
        <div
          style={{
            color: "#1F2937",
            fontFamily: geist,
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: -0.3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.label}
        </div>
        <div
          style={{
            color: "#9CA3AF",
            fontFamily: geistMono,
            fontSize: 13,
            letterSpacing: -0.1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.importPath}
        </div>
      </div>
    </div>
  );
};

export const AdaptersScene: React.FC = () => {
  const frame = useCurrentFrame();

  const headerReveal = interpolate(frame, [0, 18], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateRight: "clamp",
  });
  const headerLift = interpolate(frame, [0, 18], [10, 0], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateRight: "clamp",
  });

  const exitOpacity = interpolate(frame, [EXIT_START, EXIT_END], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exitLift = interpolate(frame, [EXIT_START, EXIT_END], [0, -14], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        opacity: exitOpacity,
        transform: `translateY(${exitLift}px)`,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flexDirection: "column",
          gap: 36,
          opacity: headerReveal,
          transform: `translateY(${headerLift}px)`,
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div
            style={{
              color: "#FDE68A",
              fontFamily: geistMono,
              fontSize: 16,
              letterSpacing: 0.6,
              textShadow: "0 1px 10px rgba(20, 12, 6, 0.40)",
              textTransform: "uppercase",
            }}
          >
            9 more adapters
          </div>
          <div
            style={{
              color: "#FFFFFF",
              fontFamily: geist,
              fontSize: 60,
              fontWeight: 600,
              letterSpacing: -1.6,
              textShadow:
                "0 2px 20px rgba(20, 12, 6, 0.45), 0 1px 2px rgba(20, 12, 6, 0.30)",
            }}
          >
            One API. Every provider.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: CHIP_GAP,
            justifyContent: "center",
            maxWidth:
              ROW_ONE_COUNT * CHIP_WIDTH + (ROW_ONE_COUNT - 1) * CHIP_GAP,
          }}
        >
          {NEW_ADAPTERS.map((entry, i) => {
            const appearFrame = FIRST_CHIP_AT + i * CHIP_DELAY;
            return (
              <AdapterChip
                key={entry.name}
                entry={entry}
                appearFrame={appearFrame}
                currentFrame={frame}
              />
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
