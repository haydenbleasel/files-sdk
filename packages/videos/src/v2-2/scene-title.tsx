import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";

const { fontFamily: geist } = loadGeist();

/** The eyebrow + headline shared by every feature scene. */
export const SceneTitle: React.FC<{ title: string; eyebrow?: string }> = ({
  title,
  eyebrow = "New in 2.2",
}) => (
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
      {eyebrow}
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
      {title}
    </div>
  </div>
);
