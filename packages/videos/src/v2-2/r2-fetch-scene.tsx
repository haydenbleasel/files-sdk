import type { Line } from "../shared/code";
import { CodeScene, codeSceneDuration } from "./code-scene";

const LINES: Line[] = [
  [
    ["import ", "kw"],
    ["{ Files } "],
    ["from ", "kw"],
    ['"files-sdk"', "str"],
    [";"],
  ],
  [
    ["import ", "kw"],
    ["{ r2 } "],
    ["from ", "kw"],
    ['"files-sdk/r2"', "str"],
    [";"],
  ],
  [],
  [["// SigV4-signed fetch — no @aws-sdk/* in your bundle", "cm"]],
  [["const ", "kw"], ["files = "], ["new ", "kw"], ["Files", "tg"], ["({"]],
  [["  "], ["adapter", "at"], [": "], ["r2", "at"], ["({"]],
  [["    "], ["accountId", "at"], [": env."], ["R2_ACCOUNT_ID", "tg"], [","]],
  [
    ["    "],
    ["accessKeyId", "at"],
    [": env."],
    ["R2_ACCESS_KEY_ID", "tg"],
    [","],
  ],
  [
    ["    "],
    ["secretAccessKey", "at"],
    [": env."],
    ["R2_SECRET_ACCESS_KEY", "tg"],
    [","],
  ],
  [["    "], ["bucket", "at"], [": "], ['"uploads"', "str"], [","]],
  [
    ["    "],
    ["client", "at"],
    [": "],
    ['"fetch"', "str"],
    [", "],
    ["// ~2.5 KB, Web Crypto only", "cm"],
  ],
  [["  }),"]],
  [["});"]],
  [],
  [
    ["await ", "kw"],
    ["files"],
    ["."],
    ["upload", "at"],
    ["("],
    ['"logo.svg"', "str"],
    [", file);"],
  ],
  [
    ["const ", "kw"],
    ["url = "],
    ["await ", "kw"],
    ["files"],
    ["."],
    ["url", "at"],
    ["("],
    ['"logo.svg"', "str"],
    [", { "],
    ["expiresIn", "at"],
    [": "],
    ["300", "tg"],
    [" });"],
  ],
];

export const R2_FETCH_SCENE_DURATION = codeSceneDuration(LINES);

export const R2FetchScene: React.FC = () => (
  <CodeScene
    duration={R2_FETCH_SCENE_DURATION}
    eyebrow='R2 · client: "fetch"'
    filename="storage.ts"
    lines={LINES}
    title="R2 without the AWS SDK."
  />
);
