import type { Line } from "../shared/code";
import { CodeScene, codeSceneDuration } from "./code-scene";

const LINES: Line[] = [
  [
    ["import ", "kw"],
    ["{ Module } "],
    ["from ", "kw"],
    ['"@nestjs/common"', "str"],
    [";"],
  ],
  [
    ["import ", "kw"],
    ["{ createFiles } "],
    ["from ", "kw"],
    ['"files-sdk"', "str"],
    [";"],
  ],
  [
    ["import ", "kw"],
    ["{ FilesModule } "],
    ["from ", "kw"],
    ['"files-sdk/nestjs"', "str"],
    [";"],
  ],
  [
    ["import ", "kw"],
    ["{ s3 } "],
    ["from ", "kw"],
    ['"files-sdk/s3"', "str"],
    [";"],
  ],
  [],
  [["@Module", "tg"], ["({"]],
  [["  "], ["imports", "at"], [": ["]],
  [["    "], ["FilesModule", "tg"], ["."], ["forRoot", "at"], ["({"]],
  [
    ["      "],
    ["files", "at"],
    [": "],
    ["createFiles", "fn"],
    ["({ "],
    ["adapter", "at"],
    [": "],
    ["s3", "at"],
    ["({ "],
    ["bucket", "at"],
    [": "],
    ['"uploads"', "str"],
    [" }) }),"],
  ],
  [
    ["      "],
    ["path", "at"],
    [": "],
    ['"/api/files"', "str"],
    [", "],
    ["// gateway mounted for you", "cm"],
  ],
  [["    }),"]],
  [["  ],"]],
  [["})"]],
  [["export ", "kw"], ["class ", "kw"], ["AppModule", "tg"], [" {}"]],
  [],
  [["// same instance anywhere via @InjectFiles()", "cm"]],
];

export const NESTJS_SCENE_DURATION = codeSceneDuration(LINES);

export const NestjsScene: React.FC = () => (
  <CodeScene
    duration={NESTJS_SCENE_DURATION}
    eyebrow="New integration · nestjs"
    filename="app.module.ts"
    lines={LINES}
    title="First-class NestJS support."
  />
);
