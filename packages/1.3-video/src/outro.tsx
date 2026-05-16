import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";

const { fontFamily: geist } = loadGeist();

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const reveal = interpolate(frame, [0, 22], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateRight: "clamp",
  });
  const lift = interpolate(frame, [0, 22], [12, 0], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateRight: "clamp",
  });
  const taglineReveal = interpolate(frame, [10, 32], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        fontFamily: geist,
        justifyContent: "center",
        opacity: reveal,
        transform: `translateY(${lift}px)`,
      }}
    >
      <div
        style={{
          color: "#FFFFFF",
          fontSize: 110,
          fontWeight: 600,
          letterSpacing: -3,
          textShadow:
            "0 2px 24px rgba(20, 12, 6, 0.45), 0 1px 2px rgba(20, 12, 6, 0.30)",
        }}
      >
        files-sdk
      </div>
      <div
        style={{
          color: "rgba(255, 255, 255, 0.9)",
          fontSize: 26,
          letterSpacing: -0.4,
          marginTop: 22,
          opacity: taglineReveal,
          textShadow: "0 1px 12px rgba(20, 12, 6, 0.40)",
        }}
      >
        One API for every storage provider.
      </div>
    </AbsoluteFill>
  );
};
