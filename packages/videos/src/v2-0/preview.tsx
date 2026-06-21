import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import { Easing, interpolate } from "remotion";

const { fontFamily: geist } = loadGeist();
const { fontFamily: geistMono } = loadGeistMono();

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

// Choreography markers, in the preview's local frame (0 = preview tab opens).
const ROWS_AT = 12;
const SELECT_AT = 58;
const UPLOAD_AT = 108;
const UPLOAD_FILL_START = UPLOAD_AT + 10;
const UPLOAD_DONE = 172;
const NEW_ROW_AT = 182;

const fade = (frame: number, at: number, dur = 14): number =>
  interpolate(frame, [at, at + dur], [0, 1], {
    easing: EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

const rise = (frame: number, at: number, dist = 10, dur = 14): number =>
  interpolate(frame, [at, at + dur], [dist, 0], {
    easing: EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

type Kind = "image" | "pdf";

interface FileEntry {
  name: string;
  size: string;
  type: string;
  kind: Kind;
  tone: string;
}

const FILES: FileEntry[] = [
  {
    kind: "image",
    name: "hero.jpg",
    size: "4.2 MB",
    tone: "#F59E0B",
    type: "image/jpeg",
  },
  {
    kind: "image",
    name: "profile.png",
    size: "1.8 MB",
    tone: "#10B981",
    type: "image/png",
  },
  {
    kind: "image",
    name: "banner.webp",
    size: "240 KB",
    tone: "#6366F1",
    type: "image/webp",
  },
  {
    kind: "pdf",
    name: "notes.pdf",
    size: "92 KB",
    tone: "#94A3B8",
    type: "application/pdf",
  },
];

const NEW_FILE: FileEntry = {
  kind: "image",
  name: "sunset.jpg",
  size: "2.6 MB",
  tone: "#EC4899",
  type: "image/jpeg",
};

const FOLDERS = ["invoices", "reports"];

const SELECTED = "hero.jpg";

const CAPABILITIES = [
  "Folder listing",
  "Signed URLs · 7d",
  "Range reads",
  "Multipart",
];

const Thumb: React.FC<{ kind: Kind; tone: string; size?: number }> = ({
  kind,
  tone,
  size = 34,
}) => (
  <div
    style={{
      alignItems: "center",
      background:
        kind === "pdf"
          ? "#F3F1EA"
          : `linear-gradient(135deg, ${tone}33, ${tone}14)`,
      borderRadius: 7,
      color: kind === "pdf" ? "#9CA3AF" : tone,
      display: "flex",
      flexShrink: 0,
      fontFamily: geistMono,
      fontSize: 10,
      fontWeight: 600,
      height: size,
      justifyContent: "center",
      letterSpacing: 0.2,
      width: size,
    }}
  >
    {kind === "pdf" ? "PDF" : "IMG"}
  </div>
);

const Badge: React.FC<{ label: string; opacity: number; shift: number }> = ({
  label,
  opacity,
  shift,
}) => (
  <div
    style={{
      alignItems: "center",
      background: "#F0F6F2",
      border: "1px solid rgba(5, 150, 105, 0.18)",
      borderRadius: 999,
      color: "#047857",
      display: "flex",
      fontFamily: geist,
      fontSize: 14,
      fontWeight: 500,
      gap: 6,
      letterSpacing: -0.1,
      opacity,
      padding: "6px 13px",
      transform: `translateY(${shift}px)`,
    }}
  >
    <span style={{ fontSize: 13 }}>✓</span>
    {label}
  </div>
);

const Toolbar: React.FC = () => (
  <div
    style={{
      alignItems: "center",
      background: "#FAFAF7",
      borderBottom: "1px solid rgba(0,0,0,0.05)",
      display: "flex",
      flexShrink: 0,
      gap: 8,
      height: 56,
      padding: "0 18px",
    }}
  >
    {["‹", "›", "↻"].map((glyph) => (
      <div
        key={glyph}
        style={{
          alignItems: "center",
          color: "#B6BCC4",
          display: "flex",
          fontSize: 22,
          height: 28,
          justifyContent: "center",
          lineHeight: 1,
          width: 28,
        }}
      >
        {glyph}
      </div>
    ))}
    <div
      style={{
        alignItems: "center",
        background: "#EFEDE6",
        borderRadius: 9,
        color: "#6B7280",
        display: "flex",
        flex: 1,
        fontFamily: geistMono,
        fontSize: 14,
        gap: 8,
        height: 32,
        letterSpacing: -0.1,
        marginLeft: 6,
        padding: "0 13px",
      }}
    >
      <span style={{ color: "#10B981", fontSize: 11 }}>●</span>
      files.example.com/photos
    </div>
  </div>
);

const FolderRow: React.FC<{ name: string; opacity: number; shift: number }> = ({
  name,
  opacity,
  shift,
}) => (
  <div
    style={{
      alignItems: "center",
      borderRadius: 9,
      display: "flex",
      gap: 12,
      opacity,
      padding: "7px 10px",
      transform: `translateY(${shift}px)`,
    }}
  >
    <div
      style={{
        alignItems: "center",
        background: "#FBF4E2",
        borderRadius: 7,
        color: "#D9A441",
        display: "flex",
        fontSize: 17,
        height: 34,
        justifyContent: "center",
        width: 34,
      }}
    >
      ▸
    </div>
    <div
      style={{
        color: "#1F2937",
        flex: 1,
        fontFamily: geist,
        fontSize: 16,
        fontWeight: 500,
        letterSpacing: -0.1,
      }}
    >
      {name}
    </div>
    <span style={{ color: "#C4C9D0", fontSize: 18 }}>›</span>
  </div>
);

const FileRow: React.FC<{
  file: FileEntry;
  opacity: number;
  shift: number;
  selected: boolean;
}> = ({ file, opacity, shift, selected }) => (
  <div
    style={{
      alignItems: "center",
      background: selected ? "rgba(5, 150, 105, 0.08)" : "transparent",
      borderRadius: 9,
      boxShadow: selected ? "inset 0 0 0 1px rgba(5,150,105,0.22)" : "none",
      display: "flex",
      gap: 12,
      opacity,
      padding: "7px 10px",
      transform: `translateY(${shift}px)`,
    }}
  >
    <Thumb kind={file.kind} tone={file.tone} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          color: "#1F2937",
          fontFamily: geistMono,
          fontSize: 15,
          letterSpacing: -0.1,
        }}
      >
        {file.name}
      </div>
    </div>
    <div
      style={{
        color: "#9CA3AF",
        fontFamily: geistMono,
        fontSize: 12,
        textAlign: "right",
      }}
    >
      {file.size}
    </div>
  </div>
);

const Breadcrumb: React.FC = () => (
  <div
    style={{
      alignItems: "center",
      color: "#9CA3AF",
      display: "flex",
      fontFamily: geist,
      fontSize: 15,
      gap: 8,
      marginBottom: 6,
      padding: "0 4px",
    }}
  >
    <span style={{ fontSize: 16 }}>⌂</span>
    <span>/</span>
    <span style={{ color: "#1F2937", fontWeight: 500 }}>photos</span>
  </div>
);

const PreviewPanel: React.FC<{ frame: number }> = ({ frame }) => {
  const opacity = fade(frame, SELECT_AT, 16);
  const shift = interpolate(frame, [SELECT_AT, SELECT_AT + 16], [16, 0], {
    easing: EASE,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        border: "1px solid rgba(0,0,0,0.07)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        opacity,
        overflow: "hidden",
        transform: `translateX(${shift}px)`,
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "linear-gradient(135deg, #F59E0B33, #F59E0B10)",
          color: "#B4791B",
          display: "flex",
          fontFamily: geistMono,
          fontSize: 13,
          height: 196,
          justifyContent: "center",
          letterSpacing: 0.4,
        }}
      >
        hero.jpg
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "14px 16px",
        }}
      >
        <div
          style={{
            color: "#1F2937",
            fontFamily: geistMono,
            fontSize: 14,
            letterSpacing: -0.1,
          }}
        >
          photos/hero.jpg
        </div>
        <div
          style={{
            color: "#9CA3AF",
            fontFamily: geistMono,
            fontSize: 12,
          }}
        >
          4.2 MB · image/jpeg · etag a1b2c3
        </div>
      </div>
    </div>
  );
};

const ActionsRow: React.FC<{ frame: number }> = ({ frame }) => {
  const opacity = fade(frame, SELECT_AT + 8, 16);
  return (
    <div style={{ display: "flex", gap: 10, opacity }}>
      <div
        style={{
          alignItems: "center",
          border: "1px solid rgba(0,0,0,0.12)",
          borderRadius: 9,
          color: "#6B7280",
          display: "flex",
          fontSize: 18,
          height: 38,
          justifyContent: "center",
          width: 44,
        }}
      >
        ⋯
      </div>
      <div
        style={{
          alignItems: "center",
          background: "#059669",
          borderRadius: 9,
          color: "#FFFFFF",
          display: "flex",
          flex: 1,
          fontFamily: geist,
          fontSize: 15,
          fontWeight: 500,
          gap: 8,
          height: 38,
          justifyContent: "center",
          letterSpacing: -0.1,
        }}
      >
        <span style={{ fontSize: 14 }}>↗</span>
        Share link
      </div>
    </div>
  );
};

const UploadOverlay: React.FC<{ frame: number }> = ({ frame }) => {
  const visible = frame >= UPLOAD_AT && frame < NEW_ROW_AT + 4;
  if (!visible) {
    return null;
  }
  const opacity = Math.min(
    fade(frame, UPLOAD_AT, 10),
    interpolate(frame, [NEW_ROW_AT - 6, NEW_ROW_AT + 4], [1, 0], {
      easing: EASE,
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const pct = Math.round(
    interpolate(frame, [UPLOAD_FILL_START, UPLOAD_DONE], [0, 100], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  );
  const done = pct >= 100;
  return (
    <div
      style={{
        background: "#FFFFFF",
        border: "1px solid rgba(0,0,0,0.08)",
        borderRadius: 12,
        bottom: 18,
        boxShadow: "0 18px 44px rgba(60, 40, 20, 0.16)",
        left: 22,
        opacity,
        padding: "13px 16px",
        position: "absolute",
        right: 22,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 12,
          marginBottom: 10,
        }}
      >
        <span style={{ color: done ? "#059669" : "#6B7280", fontSize: 15 }}>
          {done ? "✓" : "↑"}
        </span>
        <span
          style={{
            color: "#1F2937",
            fontFamily: geistMono,
            fontSize: 14,
            letterSpacing: -0.1,
          }}
        >
          sunset.jpg
        </span>
        <span
          style={{
            color: "#9CA3AF",
            fontFamily: geistMono,
            fontSize: 13,
            marginLeft: "auto",
          }}
        >
          {done ? "uploaded" : `uploading ${pct}%`}
        </span>
      </div>
      <div
        style={{
          background: "#EDEAE2",
          borderRadius: 999,
          height: 7,
          overflow: "hidden",
          width: "100%",
        }}
      >
        <div
          style={{
            background: "#059669",
            borderRadius: 999,
            height: "100%",
            width: `${pct}%`,
          }}
        />
      </div>
    </div>
  );
};

export const Preview: React.FC<{
  frame: number;
  width: number;
  height: number;
}> = ({ frame, width, height }) => {
  const newRowOpacity = fade(frame, NEW_ROW_AT, 14);
  const newRowShift = rise(frame, NEW_ROW_AT, 12, 14);
  const showNewRow = frame >= NEW_ROW_AT;

  return (
    <div
      style={{
        background: "#FFFFFF",
        display: "flex",
        flexDirection: "column",
        fontFamily: geist,
        height,
        overflow: "hidden",
        width,
      }}
    >
      <Toolbar />
      <div
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          gap: 14,
          padding: "16px 22px 20px",
          position: "relative",
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {CAPABILITIES.map((label, i) => (
            <Badge
              key={label}
              label={label}
              opacity={fade(frame, 4 + i * 5)}
              shift={rise(frame, 4 + i * 5, 6)}
            />
          ))}
        </div>
        <div style={{ display: "flex", flex: 1, gap: 20, minHeight: 0 }}>
          <div
            style={{
              border: "1px solid rgba(0,0,0,0.06)",
              borderRadius: 12,
              display: "flex",
              flex: 1.4,
              flexDirection: "column",
              padding: "14px 14px 10px",
            }}
          >
            <Breadcrumb />
            {showNewRow && (
              <FileRow
                file={NEW_FILE}
                opacity={newRowOpacity}
                selected={false}
                shift={newRowShift}
              />
            )}
            {FOLDERS.map((name, i) => (
              <FolderRow
                key={name}
                name={name}
                opacity={fade(frame, ROWS_AT + i * 5)}
                shift={rise(frame, ROWS_AT + i * 5)}
              />
            ))}
            {FILES.map((file, i) => (
              <FileRow
                file={file}
                key={file.name}
                opacity={fade(frame, ROWS_AT + (FOLDERS.length + i) * 5)}
                selected={file.name === SELECTED && frame >= SELECT_AT}
                shift={rise(frame, ROWS_AT + (FOLDERS.length + i) * 5)}
              />
            ))}
          </div>
          <div
            style={{
              display: "flex",
              flex: 1,
              flexDirection: "column",
              gap: 12,
            }}
          >
            <PreviewPanel frame={frame} />
            <ActionsRow frame={frame} />
          </div>
        </div>
        <UploadOverlay frame={frame} />
      </div>
    </div>
  );
};
