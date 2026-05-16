import { AbsoluteFill, Img, staticFile } from "remotion";

export const Background: React.FC = () => (
  <AbsoluteFill style={{ background: "#1a1410", overflow: "hidden" }}>
    <Img
      src={staticFile("background.jpg")}
      style={{
        height: "100%",
        objectFit: "cover",
        width: "100%",
      }}
    />
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(120% 90% at 50% 50%, rgba(255, 245, 225, 0.18), transparent 70%)",
      }}
    />
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(140% 110% at 50% 110%, rgba(40, 25, 15, 0.40), transparent 65%)",
      }}
    />
    <AbsoluteFill
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.55 0 0 0 0 0.45 0 0 0 0 0.35 0 0 0 0.5 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/></svg>\")",
        mixBlendMode: "overlay",
        opacity: 0.18,
      }}
    />
  </AbsoluteFill>
);
