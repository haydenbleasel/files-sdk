import { readFile } from "node:fs/promises";
import path from "node:path";

import { ImageResponse } from "next/og";

export const OG_SIZE = { height: 630, width: 1200 };
export const OG_CONTENT_TYPE = "image/png";

// Geist (Satori reads woff/ttf/otf, not woff2). Read from disk rather than
// fetched — these images are statically prerendered at build (Node), and
// fetching a bundler asset URL isn't supported during prerender. The promise is
// memoized so a full build doesn't re-read the files per image.
const fontPath = (file: string) =>
  path.join(process.cwd(), "lib/og-fonts", file);
let fontsPromise: Promise<Buffer[]> | undefined;
const getFonts = () => {
  fontsPromise ??= Promise.all([
    readFile(fontPath("Geist-Regular.woff")),
    readFile(fontPath("Geist-Medium.woff")),
    readFile(fontPath("GeistMono-Regular.woff")),
  ]);
  return fontsPromise;
};

// Tailwind neutral scale resolved from the homepage's oklch theme tokens:
// FOREGROUND = --foreground, MUTED = --muted-foreground, FAINT = that at 60%,
// BORDER = --border.
const FOREGROUND = "#0a0a0a";
const MUTED = "#737373";
const FAINT = "#a3a3a3";
const BORDER = "#e5e5e5";

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

interface OgImageOptions {
  title: string;
  description?: string;
}

// Shared card behind every OG image — matches the homepage aesthetic. The
// docs route and the root opengraph-image both call this with their own copy.
export const renderOgImage = async ({ title, description }: OgImageOptions) => {
  const [geist, geistMedium, geistMono] = await getFonts();

  return new ImageResponse(
    <div
      style={{
        backgroundColor: "#fafafa",
        color: FOREGROUND,
        display: "flex",
        flexDirection: "column",
        fontFamily: "Geist",
        height: "100%",
        justifyContent: "space-between",
        padding: "72px",
        width: "100%",
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 14 }}>
        <svg
          aria-hidden="true"
          fill="none"
          height={36}
          viewBox="0 0 28 32"
          width={31}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M25.8461 7.38456V24.6153C25.8461 24.9417 25.7164 25.2548 25.4856 25.4856C25.2548 25.7164 24.9418 25.8461 24.6153 25.8461H20.923V12.3076L14.7692 6.15379H6.15381V2.46148C6.15381 2.13506 6.28348 1.82201 6.51429 1.5912C6.74511 1.36038 7.05816 1.23071 7.38458 1.23071H19.6923L25.8461 7.38456Z"
            fill={FOREGROUND}
            opacity="0.2"
          />
          <path
            d="M26.7169 6.51385L20.5631 0.36C20.4487 0.245743 20.3129 0.155141 20.1635 0.093371C20.0141 0.031601 19.854 -0.000126752 19.6923 3.80552e-07H7.38462C6.73177 3.80552e-07 6.10567 0.25934 5.64405 0.720968C5.18242 1.1826 4.92308 1.8087 4.92308 2.46154V4.92308H2.46154C1.8087 4.92308 1.1826 5.18242 0.720968 5.64405C0.25934 6.10567 0 6.73178 0 7.38462V29.5385C0 30.1913 0.25934 30.8174 0.720968 31.279C1.1826 31.7407 1.8087 32 2.46154 32H19.6923C20.3451 32 20.9713 31.7407 21.4329 31.279C21.8945 30.8174 22.1538 30.1913 22.1538 29.5385V27.0769H24.6154C25.2682 27.0769 25.8943 26.8176 26.356 26.356C26.8176 25.8943 27.0769 25.2682 27.0769 24.6154V7.38462C27.0771 7.22294 27.0453 7.06283 26.9836 6.91342C26.9218 6.76401 26.8312 6.62823 26.7169 6.51385ZM19.6923 29.5385H2.46154V7.38462H14.26L19.6923 12.8169V25.8215C19.6923 25.8308 19.6923 25.8385 19.6923 25.8462C19.6923 25.8538 19.6923 25.8615 19.6923 25.8708V29.5385ZM24.6154 24.6154H22.1538V12.3077C22.154 12.146 22.1222 11.9859 22.0605 11.8365C21.9987 11.6871 21.9081 11.5513 21.7938 11.4369L15.64 5.28308C15.5256 5.16882 15.3898 5.07822 15.2404 5.01645C15.091 4.95468 14.9309 4.92295 14.7692 4.92308H7.38462V2.46154H19.1831L24.6154 7.89385V24.6154ZM16 19.6923C16 20.0187 15.8703 20.3318 15.6395 20.5626C15.4087 20.7934 15.0957 20.9231 14.7692 20.9231H7.38462C7.0582 20.9231 6.74514 20.7934 6.51433 20.5626C6.28352 20.3318 6.15385 20.0187 6.15385 19.6923C6.15385 19.3659 6.28352 19.0528 6.51433 18.822C6.74514 18.5912 7.0582 18.4615 7.38462 18.4615H14.7692C15.0957 18.4615 15.4087 18.5912 15.6395 18.822C15.8703 19.0528 16 19.3659 16 19.6923ZM16 24.6154C16 24.9418 15.8703 25.2549 15.6395 25.4857C15.4087 25.7165 15.0957 25.8462 14.7692 25.8462H7.38462C7.0582 25.8462 6.74514 25.7165 6.51433 25.4857C6.28352 25.2549 6.15385 24.9418 6.15385 24.6154C6.15385 24.289 6.28352 23.9759 6.51433 23.7451C6.74514 23.5143 7.0582 23.3846 7.38462 23.3846H14.7692C15.0957 23.3846 15.4087 23.5143 15.6395 23.7451C15.8703 23.9759 16 24.289 16 24.6154Z"
            fill={FOREGROUND}
          />
        </svg>
        <div
          style={{ fontSize: 30, fontWeight: 500, letterSpacing: "-0.01em" }}
        >
          Files SDK
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            fontSize: 76,
            fontWeight: 500,
            letterSpacing: "-0.03em",
            lineHeight: 1.05,
            maxWidth: 1010,
          }}
        >
          {truncate(title, 64)}
        </div>
        {description ? (
          <div
            style={{
              color: MUTED,
              fontSize: 29,
              lineHeight: 1.4,
              marginTop: 28,
              maxWidth: 900,
            }}
          >
            {truncate(description, 150)}
          </div>
        ) : null}
      </div>

      <div
        style={{
          alignItems: "center",
          borderTop: `1px solid ${BORDER}`,
          color: MUTED,
          display: "flex",
          fontFamily: "Geist Mono",
          fontSize: 21,
          justifyContent: "space-between",
          paddingTop: 28,
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 11 }}>
          <svg
            aria-hidden="true"
            fill={MUTED}
            height={23}
            viewBox="0 0 24 24"
            width={23}
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
          </svg>
          <span>haydenbleasel/files-sdk</span>
        </div>
        <div style={{ alignItems: "center", display: "flex", gap: 9 }}>
          <span style={{ color: FAINT }}>$</span>
          <span>npm install files-sdk</span>
        </div>
      </div>
    </div>,
    {
      ...OG_SIZE,
      fonts: [
        { data: geist, name: "Geist", style: "normal", weight: 400 },
        { data: geistMedium, name: "Geist", style: "normal", weight: 500 },
        { data: geistMono, name: "Geist Mono", style: "normal", weight: 400 },
      ],
    }
  );
};
