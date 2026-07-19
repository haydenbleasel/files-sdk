import type { Line } from "../shared/code";
import { CodeScene, codeSceneDuration } from "./code-scene";

const LINES: Line[] = [
  [
    ["import ", "kw"],
    ["* ", "kw"],
    ["as ", "kw"],
    ["DocumentPicker "],
    ["from ", "kw"],
    ['"expo-document-picker"', "str"],
    [";"],
  ],
  [
    ["import ", "kw"],
    ["{ useFiles } "],
    ["from ", "kw"],
    ['"files-sdk/react"', "str"],
    [";"],
  ],
  [],
  [["const ", "kw"], ["files = "], ["useFiles", "fn"], ["({"]],
  [
    ["  "],
    ["endpoint", "at"],
    [": "],
    ['"https://app.example.com/api/files"', "str"],
    [","],
  ],
  [["});"]],
  [],
  [["const ", "kw"], ["pick = "], ["async ", "kw"], ["() => {"]],
  [
    ["  "],
    ["const ", "kw"],
    ["{ assets } = "],
    ["await ", "kw"],
    ["DocumentPicker"],
    ["."],
    ["getDocumentAsync", "at"],
    ["();"],
  ],
  [
    ["  "],
    ["const ", "kw"],
    ["{ uri, name, mimeType } = assets["],
    ["0", "tg"],
    ["];"],
  ],
  [],
  [["  "], ["// the picker asset is the upload body — no Blob juggling", "cm"]],
  [
    ["  "],
    ["await ", "kw"],
    ["files"],
    ["."],
    ["upload", "at"],
    ["({ uri, name, "],
    ["type", "at"],
    [": mimeType });"],
  ],
  [["};"]],
];

export const NATIVE_SCENE_DURATION = codeSceneDuration(LINES);

export const NativeScene: React.FC = () => (
  <CodeScene
    duration={NATIVE_SCENE_DURATION}
    eyebrow="Client · react native"
    filename="upload.tsx"
    lines={LINES}
    title="Uploads from Expo, out of the box."
  />
);
