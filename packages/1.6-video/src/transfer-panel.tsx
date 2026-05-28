import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import { Easing, interpolate } from "remotion";

const { fontFamily: geist } = loadGeist();
const { fontFamily: geistMono } = loadGeistMono();

const TOTAL_FILES = 318;
const CLICK_AT = 18;
const TRANSFER_START = 26;
const TRANSFER_END = 102;
const SETTLE = 18;

/** Frames the panel takes: pointer travel → click → transfer → settle. */
export const TRANSFER_ACTION_FRAMES = TRANSFER_END + SETTLE;

const FILES = [
  "hero.jpg",
  "promo.mp4",
  "db.tar.gz",
  "invoice.pdf",
  "avatar.png",
  "export.csv",
  "logo.svg",
  "data.json",
];

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

const DriveIcon: React.FC<{ size?: number }> = ({ size = 22 }) => (
  <svg height={(size * 78) / 87.3} viewBox="0 0 87.3 78" width={size}>
    <title>Google Drive</title>
    <path
      d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
      fill="#0066da"
    />
    <path
      d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z"
      fill="#00ac47"
    />
    <path
      d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
      fill="#ea4335"
    />
    <path
      d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
      fill="#00832d"
    />
    <path
      d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
      fill="#2684fc"
    />
    <path
      d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
      fill="#ffba00"
    />
  </svg>
);

const Pointer: React.FC<{ x: number; y: number; opacity: number }> = ({
  x,
  y,
  opacity,
}) => (
  <svg
    height="26"
    style={{ left: x, opacity, position: "absolute", top: y }}
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

const ProviderChip: React.FC<{
  label: string;
  icon: React.ReactNode;
  mono?: boolean;
}> = ({ label, icon, mono }) => (
  <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
    {icon}
    <span
      style={{
        color: "#4B5563",
        fontFamily: mono ? geistMono : geist,
        fontSize: 14,
        letterSpacing: -0.1,
      }}
    >
      {label}
    </span>
  </div>
);

const Button: React.FC<{ scale: number }> = ({ scale }) => (
  <div
    style={{
      alignItems: "center",
      background: "#F3F1EA",
      border: "1px solid rgba(0,0,0,0.08)",
      borderRadius: 12,
      boxShadow: "0 2px 6px rgba(60, 40, 20, 0.10)",
      color: "#1F2937",
      display: "flex",
      fontFamily: geist,
      fontSize: 17,
      fontWeight: 600,
      gap: 10,
      letterSpacing: -0.2,
      padding: "14px 22px",
      transform: `scale(${scale})`,
    }}
  >
    <DriveIcon size={20} />
    Back up to Google Drive
  </div>
);

const TransferProgress: React.FC<{ frame: number }> = ({ frame }) => {
  const progress = ease(frame, TRANSFER_START, TRANSFER_END, 0, 1);
  const count = Math.round(progress * TOTAL_FILES);
  const fileIndex = Math.min(
    FILES.length - 1,
    Math.floor(progress * FILES.length)
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        width: "100%",
      }}
    >
      <div
        style={{
          alignItems: "baseline",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            color: "#1F2937",
            fontFamily: geist,
            fontSize: 16,
            fontWeight: 500,
          }}
        >
          Transferring…
        </span>
        <span style={{ color: "#B45309", fontFamily: geistMono, fontSize: 15 }}>
          {count} / {TOTAL_FILES}
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
            background: "#D97706",
            borderRadius: 999,
            height: "100%",
            width: `${progress * 100}%`,
          }}
        />
      </div>
      <span
        style={{
          color: "#9CA3AF",
          fontFamily: geistMono,
          fontSize: 13,
          letterSpacing: -0.1,
        }}
      >
        ↑ uploads/{FILES[fileIndex]}
      </span>
    </div>
  );
};

const TransferDone: React.FC<{ frame: number }> = ({ frame }) => {
  const pop = ease(frame, TRANSFER_END, TRANSFER_END + 12, 0.8, 1);
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        transform: `scale(${pop})`,
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "rgba(5,150,105,0.12)",
          borderRadius: 999,
          color: "#059669",
          display: "flex",
          fontSize: 28,
          height: 52,
          justifyContent: "center",
          width: 52,
        }}
      >
        ✓
      </div>
      <span
        style={{
          color: "#1F2937",
          fontFamily: geist,
          fontSize: 17,
          fontWeight: 500,
        }}
      >
        {TOTAL_FILES} files backed up to Drive
      </span>
    </div>
  );
};

export const TransferPanel: React.FC<{ frame: number }> = ({ frame }) => {
  const pointerT = ease(frame, 2, CLICK_AT, 0, 1);
  const pointerX = 430 - 168 * pointerT;
  const pointerY = 252 - 96 * pointerT;
  const pointerOpacity =
    interpolate(frame, [0, 4], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) *
    interpolate(frame, [CLICK_AT + 2, CLICK_AT + 11], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  const buttonScale = interpolate(
    frame,
    [CLICK_AT - 4, CLICK_AT, CLICK_AT + 3],
    [1, 0.95, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const clicked = frame >= CLICK_AT;
  const done = frame >= TRANSFER_END;

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
          gap: 14,
          height: 58,
          justifyContent: "center",
          padding: "0 20px",
        }}
      >
        <ProviderChip
          icon={
            <div
              style={{
                background: "#F59E0B",
                borderRadius: 5,
                height: 18,
                width: 18,
              }}
            />
          }
          label="prod-uploads"
          mono
        />
        <span style={{ color: "#9CA3AF", fontSize: 18 }}>→</span>
        <ProviderChip icon={<DriveIcon size={20} />} label="Google Drive" />
      </div>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          height: 200,
          justifyContent: "center",
          padding: "0 28px",
        }}
      >
        {(() => {
          if (done) {
            return <TransferDone frame={frame} />;
          }
          if (clicked) {
            return <TransferProgress frame={frame} />;
          }
          return <Button scale={buttonScale} />;
        })()}
      </div>
      <Pointer opacity={pointerOpacity} x={pointerX} y={pointerY} />
    </div>
  );
};
