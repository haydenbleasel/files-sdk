import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import { Easing, interpolate } from "remotion";

const { fontFamily: geist } = loadGeist();
const { fontFamily: geistMono } = loadGeistMono();

const TOTAL_MB = 210;
const PARTS = 14;

// Beats within the action phase: upload → pause → (persist token) → resume → done.
const PAUSE_AT = 34;
const RESUME_AT = 76;
const COMPLETE_AT = 120;
const SETTLE = 20;
const PAUSE_FRAC = 0.45;

/** Frames the panel takes for the whole pause-and-resume story. */
export const RESUMABLE_ACTION_FRAMES = COMPLETE_AT + SETTLE;

const ease = (
  frame: number,
  from: number,
  to: number,
  a: number,
  b: number
): number =>
  interpolate(frame, [from, to], [a, b], {
    easing: Easing.bezier(0.33, 1, 0.68, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const fractionAt = (frame: number): number => {
  if (frame <= PAUSE_AT) {
    return ease(frame, 0, PAUSE_AT, 0, PAUSE_FRAC);
  }
  if (frame <= RESUME_AT) {
    return PAUSE_FRAC;
  }
  return ease(frame, RESUME_AT, COMPLETE_AT, PAUSE_FRAC, 1);
};

type Phase = "uploading" | "paused" | "resuming" | "done";

const barColorAt = (phase: Phase): string => {
  if (phase === "done") {
    return "#059669";
  }
  if (phase === "paused") {
    return "#C79A6B";
  }
  return "#D97706";
};

const phaseAt = (frame: number): Phase => {
  if (frame >= COMPLETE_AT) {
    return "done";
  }
  if (frame >= RESUME_AT) {
    return "resuming";
  }
  if (frame >= PAUSE_AT) {
    return "paused";
  }
  return "uploading";
};

const STATUS_LABEL: Record<Phase, string> = {
  done: "Complete",
  paused: "Paused",
  resuming: "Resuming…",
  uploading: "Uploading…",
};

const Pointer: React.FC<{ x: number; y: number; opacity: number }> = ({
  x,
  y,
  opacity,
}) => (
  <svg
    height="26"
    style={{ left: x, opacity, position: "absolute", top: y, zIndex: 5 }}
    viewBox="0 0 24 24"
    width="26"
  >
    <title>Cursor</title>
    <path
      d="M5 3 L5 19 L9.2 15 L12 21 L14.6 19.9 L11.7 14 L17 14 Z"
      fill="#1F2937"
      stroke="#FFFFFF"
      strokeWidth="1.2"
    />
  </svg>
);

const ControlButton: React.FC<{
  label: string;
  glyph: React.ReactNode;
  active: boolean;
  press: number;
}> = ({ label, glyph, active, press }) => (
  <div
    style={{
      alignItems: "center",
      background: active ? "#FEF3E2" : "#F3F1EA",
      border: active
        ? "1px solid rgba(217,119,6,0.45)"
        : "1px solid rgba(0,0,0,0.08)",
      borderRadius: 10,
      color: active ? "#B45309" : "#6B7280",
      display: "flex",
      fontFamily: geist,
      fontSize: 15,
      fontWeight: 600,
      gap: 8,
      justifyContent: "center",
      letterSpacing: -0.2,
      padding: "10px 18px",
      transform: `scale(${press})`,
      width: 188,
    }}
  >
    {glyph}
    {label}
  </div>
);

const PauseGlyph: React.FC<{ color: string }> = ({ color }) => (
  <span style={{ display: "flex", gap: 3 }}>
    <span style={{ background: color, height: 13, width: 4 }} />
    <span style={{ background: color, height: 13, width: 4 }} />
  </span>
);

const PlayGlyph: React.FC<{ color: string }> = ({ color }) => (
  <span
    style={{
      borderBottom: "6px solid transparent",
      borderLeft: `11px solid ${color}`,
      borderTop: "6px solid transparent",
      height: 0,
      width: 0,
    }}
  />
);

interface PillColors {
  bg: string;
  color: string;
}

const pillColorsAt = (phase: Phase): PillColors => {
  if (phase === "done") {
    return { bg: "rgba(5,150,105,0.12)", color: "#059669" };
  }
  if (phase === "paused") {
    return { bg: "rgba(120,100,90,0.12)", color: "#92776B" };
  }
  return { bg: "rgba(217,119,6,0.12)", color: "#B45309" };
};

const StatusPill: React.FC<{ phase: Phase }> = ({ phase }) => {
  const { color, bg } = pillColorsAt(phase);
  return (
    <span
      style={{
        alignItems: "center",
        background: bg,
        borderRadius: 999,
        color,
        display: "flex",
        fontFamily: geistMono,
        fontSize: 13,
        gap: 7,
        padding: "4px 11px",
      }}
    >
      <span
        style={{ background: color, borderRadius: 999, height: 6, width: 6 }}
      />
      {STATUS_LABEL[phase]}
    </span>
  );
};

export const ResumablePanel: React.FC<{ frame: number }> = ({ frame }) => {
  const frac = fractionAt(frame);
  const phase = phaseAt(frame);
  const pct = Math.round(frac * 100);
  const loadedMb = Math.round(frac * TOTAL_MB);
  const donePart = Math.round(frac * PARTS);
  const done = phase === "done";

  // The token is written to localStorage the moment we pause, and stays.
  const tokenIn = interpolate(frame, [PAUSE_AT + 2, PAUSE_AT + 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Pointer dips onto Pause near PAUSE_AT, then onto Resume near RESUME_AT.
  const pauseClick = interpolate(
    frame,
    [PAUSE_AT - 4, PAUSE_AT, PAUSE_AT + 3],
    [1, 0.94, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const resumeClick = interpolate(
    frame,
    [RESUME_AT - 4, RESUME_AT, RESUME_AT + 3],
    [1, 0.94, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  // Cursor rests on Pause through the pause click, then slides over to Resume
  // and settles before the resume click. Tip lands on the active button face.
  const pointerX = interpolate(
    frame,
    [PAUSE_AT + 22, RESUME_AT - 10],
    [160, 360],
    {
      easing: Easing.bezier(0.33, 1, 0.68, 1),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }
  );
  const pointerY = 168;
  const pointerOpacity = done
    ? interpolate(frame, [COMPLETE_AT - 8, COMPLETE_AT], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : interpolate(frame, [0, 6], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });

  const barColor = barColorAt(phase);

  return (
    <div
      style={{
        background: "#FFFFFF",
        borderRadius: 14,
        boxShadow:
          "0 18px 48px rgba(60, 40, 20, 0.18), 0 1px 0 rgba(255,255,255,0.6) inset",
        fontFamily: geist,
        overflow: "hidden",
        position: "relative",
        width: 540,
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "#FAFAF7",
          borderBottom: "1px solid rgba(0,0,0,0.05)",
          display: "flex",
          height: 58,
          justifyContent: "space-between",
          padding: "0 20px",
        }}
      >
        <span
          style={{
            color: "#1F2937",
            fontFamily: geistMono,
            fontSize: 16,
            letterSpacing: -0.1,
          }}
        >
          ↑ backups/db.tar
        </span>
        <StatusPill phase={phase} />
      </div>

      <div style={{ padding: "22px 24px 8px" }}>
        <div
          style={{
            alignItems: "baseline",
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <span
            style={{
              color: "#1F2937",
              fontFamily: geistMono,
              fontSize: 26,
              fontWeight: 500,
              letterSpacing: -0.5,
            }}
          >
            {pct}%
          </span>
          <span
            style={{ color: "#9CA3AF", fontFamily: geistMono, fontSize: 14 }}
          >
            {loadedMb} / {TOTAL_MB} MB · part {donePart}/{PARTS}
          </span>
        </div>
        <div
          style={{
            background: "#EFEDE6",
            borderRadius: 999,
            height: 8,
            overflow: "hidden",
            width: "100%",
          }}
        >
          <div
            style={{
              background: barColor,
              borderRadius: 999,
              height: "100%",
              width: `${frac * 100}%`,
            }}
          />
        </div>
      </div>

      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 12,
          justifyContent: "center",
          padding: "16px 24px 8px",
        }}
      >
        <ControlButton
          active={phase === "uploading" || phase === "resuming"}
          glyph={
            <PauseGlyph
              color={
                phase === "uploading" || phase === "resuming"
                  ? "#B45309"
                  : "#9CA3AF"
              }
            />
          }
          label="control.pause()"
          press={pauseClick}
        />
        <ControlButton
          active={phase === "paused"}
          glyph={
            <PlayGlyph color={phase === "paused" ? "#B45309" : "#9CA3AF"} />
          }
          label="control.resume()"
          press={resumeClick}
        />
      </div>

      <div
        style={{
          borderTop: "1px solid rgba(0,0,0,0.05)",
          marginTop: 8,
          opacity: tokenIn,
          padding: "14px 24px 16px",
        }}
      >
        <div
          style={{
            color: "#9CA3AF",
            fontFamily: geistMono,
            fontSize: 12,
            letterSpacing: -0.1,
            marginBottom: 6,
          }}
        >
          localStorage ← control.toJSON()
        </div>
        <div
          style={{
            color: "#B45309",
            fontFamily: geistMono,
            fontSize: 13,
            letterSpacing: -0.1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {'{ "uploadId": "2~k9f3aR…", "parts": 6 }'} — resume in any process
        </div>
      </div>

      {!done && <Pointer opacity={pointerOpacity} x={pointerX} y={pointerY} />}
    </div>
  );
};
