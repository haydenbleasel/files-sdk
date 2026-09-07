import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import { Easing, interpolate } from "remotion";

const { fontFamily: geist } = loadGeist();
const { fontFamily: geistMono } = loadGeistMono();

const STEP = 15;

interface AuditRecord {
  time: string;
  actor: string;
  verb: string;
  target: string;
  ms: number;
}

const RECORDS: AuditRecord[] = [
  {
    actor: "alice",
    ms: 142,
    target: "report.pdf",
    time: "09:24:01",
    verb: "upload",
  },
  { actor: "alice", ms: 38, target: "a → b", time: "09:24:02", verb: "move" },
  { actor: "bob", ms: 12, target: "old.log", time: "09:24:04", verb: "delete" },
  {
    actor: "bob",
    ms: 88,
    target: "photo.jpg",
    time: "09:24:05",
    verb: "upload",
  },
];

const LAST = (RECORDS.length - 1) * STEP;
/** AuditRecords stream into the awaited sink one by one. */
export const AUDIT_ACTION_FRAMES = LAST + 44;

const VERB_COLOR = new Map<string, string>([
  ["copy", "#7C3AED"],
  ["delete", "#B91C1C"],
  ["move", "#2563EB"],
  ["upload", "#047857"],
]);

const Row: React.FC<{ record: AuditRecord; frame: number; index: number }> = ({
  record,
  frame,
  index,
}) => {
  const at = index * STEP;
  const reveal = interpolate(frame, [at, at + 11], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const accent = VERB_COLOR.get(record.verb) ?? "#6B7280";

  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        gap: 12,
        height: 42,
        opacity: reveal,
        padding: "0 22px",
        transform: `translateX(${(1 - reveal) * 10}px)`,
      }}
    >
      <span style={{ color: "#B8AF9F", fontFamily: geistMono, fontSize: 12 }}>
        {record.time}
      </span>
      <span
        style={{
          color: "#1F2937",
          fontFamily: geistMono,
          fontSize: 13,
          width: 46,
        }}
      >
        {record.actor}
      </span>
      <span style={{ flexShrink: 0, width: 72 }}>
        <span
          style={{
            background: `${accent}18`,
            borderRadius: 999,
            color: accent,
            display: "inline-block",
            fontFamily: geistMono,
            fontSize: 11,
            letterSpacing: 0.2,
            padding: "3px 10px",
          }}
        >
          {record.verb}
        </span>
      </span>
      <span
        style={{
          color: "#6B7280",
          flex: 1,
          fontFamily: geistMono,
          fontSize: 13,
          letterSpacing: -0.2,
        }}
      >
        {record.target}
      </span>
      <span style={{ color: "#9CA3AF", fontFamily: geistMono, fontSize: 12 }}>
        {record.ms}ms
      </span>
      <span style={{ color: "#047857", fontSize: 13 }}>✓</span>
    </div>
  );
};

export const AuditPanel: React.FC<{ frame: number }> = ({ frame }) => {
  const written = RECORDS.filter((_, i) => frame >= i * STEP + 11).length;
  const pulse = 0.5 + 0.5 * Math.sin(frame / 4);

  return (
    <div
      style={{
        background: "#FFFFFF",
        borderRadius: 14,
        boxShadow:
          "0 18px 48px rgba(60, 40, 20, 0.18), 0 1px 0 rgba(255,255,255,0.6) inset",
        fontFamily: geist,
        overflow: "hidden",
        width: 560,
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
          padding: "0 22px",
        }}
      >
        <span
          style={{
            color: "#1F2937",
            fontFamily: geistMono,
            fontSize: 16,
            letterSpacing: -0.2,
          }}
        >
          audit log
        </span>
        <span
          style={{
            alignItems: "center",
            color: "#475569",
            display: "flex",
            fontFamily: geistMono,
            fontSize: 13,
            gap: 7,
          }}
        >
          <span
            style={{
              background: "#475569",
              borderRadius: 999,
              height: 6,
              opacity: pulse,
              width: 6,
            }}
          />
          writing
        </span>
      </div>

      <div style={{ padding: "8px 0" }}>
        {RECORDS.map((record, i) => (
          <Row frame={frame} index={i} key={record.time} record={record} />
        ))}
      </div>

      <div
        style={{
          alignItems: "center",
          borderTop: "1px solid rgba(0,0,0,0.05)",
          color: "#6B7280",
          display: "flex",
          fontFamily: geistMono,
          fontSize: 13,
          gap: 8,
          justifyContent: "space-between",
          letterSpacing: -0.1,
          padding: "13px 22px",
        }}
      >
        <span>{written} records · awaited sink</span>
        <span style={{ color: "#9CA3AF" }}>fail-closed</span>
      </div>
    </div>
  );
};
