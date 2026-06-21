import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { sliceTokens, TOKEN_COLOR } from "../shared/highlight";
import { useTypewriter } from "../shared/typewriter";
import {
  HOOK_LINE,
  PAGE_CODE,
  ROUTE_CODE,
  SHADCN_FIRST_LINE,
  SHADCN_LINES,
  TAB_FILES,
} from "./code";
import { Preview } from "./preview";
import { EDITOR, EDITOR_SCHEDULE, FPS } from "./timings";

const { fontFamily: geist } = loadGeist();
const { fontFamily: geistMono } = loadGeistMono();

const WIDTH = 1360;
const BODY_HEIGHT = 720;
const FONT_SIZE = 20;
const LINE_H = 32;

const CLAMP = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;

const SHADCN_TOAST = "npx shadcn add dropzone file-list upload-progress";

const PAGE_LINES = PAGE_CODE.split("\n");
const ROUTE_LINES = ROUTE_CODE.split("\n");

// Per-line start offsets in the flattened source (line length + trailing \n).
const lineStarts = (lines: string[]): number[] => {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
};

const PAGE_STARTS = lineStarts(PAGE_LINES);
const ROUTE_STARTS = lineStarts(ROUTE_LINES);

// Frame at which typing reaches the first shadcn JSX line (drives the toast).
const SHADCN_TOAST_START =
  EDITOR_SCHEDULE.pageTypeStart +
  Math.ceil(((PAGE_STARTS[SHADCN_FIRST_LINE] ?? 0) / EDITOR.charsPerSec) * FPS);

const budgetAt = (frame: number, start: number, total: number): number =>
  Math.max(
    0,
    Math.min(total, Math.floor(((frame - start) / FPS) * EDITOR.charsPerSec))
  );

const revealedLine = (budget: number, starts: number[]): number => {
  let active = 0;
  for (let i = 0; i < starts.length; i += 1) {
    if (budget > (starts[i] ?? 0)) {
      active = i;
    }
  }
  return active;
};

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <div style={{ background: color, borderRadius: 6, height: 12, width: 12 }} />
);

const Caret: React.FC<{ on: boolean }> = ({ on }) => (
  <span
    style={{
      background: "#1F2937",
      display: "inline-block",
      height: 24,
      marginLeft: 2,
      opacity: on ? 1 : 0,
      transform: "translateY(2px)",
      width: 9,
    }}
  />
);

const Tab: React.FC<{ label: string; active: boolean }> = ({
  label,
  active,
}) => (
  <div
    style={{
      alignItems: "center",
      alignSelf: "stretch",
      background: active ? "rgba(255, 255, 255, 0.55)" : "transparent",
      borderBottom: active ? "2px solid #059669" : "2px solid transparent",
      color: active ? "#1F2937" : "#9CA3AF",
      display: "flex",
      fontFamily: geist,
      fontSize: 15,
      fontWeight: active ? 500 : 400,
      letterSpacing: -0.1,
      padding: "0 20px",
    }}
  >
    {label}
  </div>
);

const CodePane: React.FC<{
  lines: string[];
  starts: number[];
  budget: number;
  highlight: Set<number>;
  showCaret: boolean;
}> = ({ lines, starts, budget, highlight, showCaret }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const active = revealedLine(budget, starts);
  const cursorOn = Math.floor((frame / fps) * 2) % 2 === 0;

  return (
    <div
      style={{
        color: "#374151",
        fontFamily: geistMono,
        fontSize: FONT_SIZE,
        fontVariantLigatures: "none",
        lineHeight: `${LINE_H}px`,
        padding: "24px 30px",
      }}
    >
      {lines.map((line, i) => {
        const lineBudget = Math.max(
          0,
          Math.min(line.length, budget - (starts[i] ?? 0))
        );
        const tokens = sliceTokens(line, lineBudget);
        return (
          <div
            key={i}
            style={{
              alignItems: "center",
              background: highlight.has(i)
                ? "rgba(217, 119, 6, 0.10)"
                : "transparent",
              borderRadius: 6,
              display: "flex",
              height: LINE_H,
              margin: "0 -10px",
              padding: "0 10px",
              whiteSpace: "pre",
            }}
          >
            <span
              style={{
                color: "#C0C5CC",
                flexShrink: 0,
                marginRight: 22,
                textAlign: "right",
                width: 30,
              }}
            >
              {i + 1}
            </span>
            <span>
              {tokens.map((tok, j) => (
                <span key={j} style={{ color: TOKEN_COLOR[tok.type] }}>
                  {tok.text}
                </span>
              ))}
              {showCaret && i === active && <Caret on={cursorOn} />}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const ShadcnToast: React.FC<{ opacity: number }> = ({ opacity }) => {
  const typed = useTypewriter(SHADCN_TOAST, SHADCN_TOAST_START, 42);
  const finished = typed.length >= SHADCN_TOAST.length;
  const frame = useCurrentFrame();
  const cursorOn = Math.floor(frame / 15) % 2 === 0;
  return (
    <div
      style={{
        alignItems: "center",
        background: "rgba(31, 41, 55, 0.93)",
        borderRadius: 9,
        boxShadow: "0 12px 30px rgba(40, 26, 12, 0.28)",
        color: "#F3F4F6",
        display: "flex",
        fontFamily: geistMono,
        fontSize: 14,
        gap: 8,
        letterSpacing: -0.1,
        opacity,
        padding: "9px 14px",
        position: "absolute",
        right: 26,
        top: 20,
      }}
    >
      <span style={{ color: "#34D399" }}>$</span>
      <span>
        {typed}
        {!finished && cursorOn && (
          <span
            style={{
              background: "#F3F4F6",
              display: "inline-block",
              height: 16,
              marginLeft: 2,
              transform: "translateY(2px)",
              width: 7,
            }}
          />
        )}
      </span>
    </div>
  );
};

export const TabbedEditor: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const { pageTypeStart, routeFrom, routeTypeStart, previewFrom, previewEnd } =
    EDITOR_SCHEDULE;

  // Window enter (spring) + exit (fade/lift before the outro).
  const enter = spring({
    config: { damping: 200, mass: 0.7 },
    durationInFrames: 30,
    fps,
    frame,
  });
  const enterOpacity = interpolate(enter, [0, 1], [0, 1]);
  const enterY = interpolate(enter, [0, 1], [28, 0]);
  const enterScale = interpolate(enter, [0, 1], [0.98, 1]);
  const exitOpacity = interpolate(
    frame,
    [previewEnd, previewEnd + EDITOR.exit],
    [1, 0],
    CLAMP
  );
  const exitY = interpolate(
    frame,
    [previewEnd, previewEnd + EDITOR.exit],
    [0, -14],
    CLAMP
  );

  let activeTab = 0;
  if (frame >= routeFrom) {
    activeTab = 1;
  }
  if (frame >= previewFrom) {
    activeTab = 2;
  }

  const pageBudget = budgetAt(frame, pageTypeStart, PAGE_CODE.length);
  const routeBudget = budgetAt(frame, routeTypeStart, ROUTE_CODE.length);
  const pageLine = revealedLine(pageBudget, PAGE_STARTS);

  // Body cross-fade envelopes.
  const pageOpacity = interpolate(
    frame,
    [routeFrom - EDITOR.xfade, routeFrom],
    [1, 0],
    CLAMP
  );
  const routeOpacity =
    interpolate(frame, [routeFrom, routeFrom + EDITOR.xfade], [0, 1], CLAMP) *
    interpolate(
      frame,
      [previewFrom - EDITOR.xfade, previewFrom],
      [1, 0],
      CLAMP
    );
  const previewOpacity = interpolate(
    frame,
    [previewFrom, previewFrom + EDITOR.xfade],
    [0, 1],
    CLAMP
  );

  // Page highlight: hook line during the hook beat, shadcn lines once reached.
  const pageHighlight = new Set<number>();
  if (pageLine >= HOOK_LINE && pageLine < SHADCN_FIRST_LINE) {
    pageHighlight.add(HOOK_LINE);
  }
  if (pageLine >= SHADCN_FIRST_LINE) {
    for (const l of SHADCN_LINES) {
      if (pageLine >= l) {
        pageHighlight.add(l);
      }
    }
  }

  const toastOpacity =
    Math.min(
      interpolate(
        frame,
        [SHADCN_TOAST_START, SHADCN_TOAST_START + 10],
        [0, 1],
        CLAMP
      ),
      interpolate(frame, [routeFrom - 14, routeFrom], [1, 0], CLAMP)
    ) * (activeTab === 0 ? 1 : 0);

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          opacity: enterOpacity * exitOpacity,
          transform: `translateY(${enterY + exitY}px) scale(${enterScale})`,
          width: WIDTH,
        }}
      >
        <div
          style={{
            background: "#FBF9F4",
            borderRadius: 16,
            boxShadow:
              "0 40px 90px rgba(60, 40, 20, 0.28), 0 1px 0 rgba(255, 255, 255, 0.6) inset",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "rgba(245, 242, 233, 0.7)",
              borderBottom: "1px solid rgba(0, 0, 0, 0.04)",
              display: "flex",
              height: 50,
            }}
          >
            <div style={{ display: "flex", gap: 10, padding: "0 18px" }}>
              <Dot color="#E8B6A8" />
              <Dot color="#EBD8A1" />
              <Dot color="#B8D4B0" />
            </div>
            <div style={{ alignSelf: "stretch", display: "flex" }}>
              {TAB_FILES.map((label, i) => (
                <Tab active={i === activeTab} key={label} label={label} />
              ))}
            </div>
          </div>
          <div style={{ height: BODY_HEIGHT, position: "relative" }}>
            {pageOpacity > 0 && (
              <div
                style={{ inset: 0, opacity: pageOpacity, position: "absolute" }}
              >
                <CodePane
                  budget={pageBudget}
                  highlight={pageHighlight}
                  lines={PAGE_LINES}
                  showCaret={activeTab === 0}
                  starts={PAGE_STARTS}
                />
                {toastOpacity > 0 && <ShadcnToast opacity={toastOpacity} />}
              </div>
            )}
            {routeOpacity > 0 && (
              <div
                style={{
                  inset: 0,
                  opacity: routeOpacity,
                  position: "absolute",
                }}
              >
                <CodePane
                  budget={routeBudget}
                  highlight={new Set<number>()}
                  lines={ROUTE_LINES}
                  showCaret={activeTab === 1}
                  starts={ROUTE_STARTS}
                />
              </div>
            )}
            {previewOpacity > 0 && (
              <div
                style={{
                  inset: 0,
                  opacity: previewOpacity,
                  position: "absolute",
                }}
              >
                <Preview
                  frame={frame - previewFrom}
                  height={BODY_HEIGHT}
                  width={WIDTH}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
