import { ADAPTERS_SCENE_DURATION } from "./adapters-scene";
import { EXISTS_SCENE_DURATION } from "./exists-scene";
import { FILE_HANDLE_SCENE_DURATION } from "./file-handle-scene";

export const FPS = 30;

const INTRO_DURATION = 90;
const OUTRO_DURATION = 75;

const INTRO_FROM = 0;
const ADAPTERS_FROM = INTRO_FROM + INTRO_DURATION;
const EXISTS_FROM = ADAPTERS_FROM + ADAPTERS_SCENE_DURATION;
const FILE_HANDLE_FROM = EXISTS_FROM + EXISTS_SCENE_DURATION;
const OUTRO_FROM = FILE_HANDLE_FROM + FILE_HANDLE_SCENE_DURATION;

export const TIMING = {
  adapters: { duration: ADAPTERS_SCENE_DURATION, from: ADAPTERS_FROM },
  exists: { duration: EXISTS_SCENE_DURATION, from: EXISTS_FROM },
  fileHandle: {
    duration: FILE_HANDLE_SCENE_DURATION,
    from: FILE_HANDLE_FROM,
  },
  intro: { duration: INTRO_DURATION, from: INTRO_FROM },
  outro: { duration: OUTRO_DURATION, from: OUTRO_FROM },
} as const;

export const TOTAL_DURATION = OUTRO_FROM + OUTRO_DURATION;
