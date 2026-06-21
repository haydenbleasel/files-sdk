import { PAGE_CODE, ROUTE_CODE } from "./code";

export const FPS = 30;

// Editor scene tuning. Typing speed + the holds/transitions between tabs.
export const EDITOR = {
  charsPerSec: 58,
  dwell: 36,
  exit: 18,
  previewDuration: 210,
  typeDelay: 14,
  xfade: 16,
} as const;

const typeFramesFor = (code: string): number =>
  Math.ceil((code.length / EDITOR.charsPerSec) * FPS);

const PAGE_TYPE_FRAMES = typeFramesFor(PAGE_CODE);
const ROUTE_TYPE_FRAMES = typeFramesFor(ROUTE_CODE);

const PAGE_FROM = 0;
const PAGE_TYPE_START = PAGE_FROM + EDITOR.typeDelay;
const ROUTE_FROM = PAGE_TYPE_START + PAGE_TYPE_FRAMES + EDITOR.dwell;
const ROUTE_TYPE_START = ROUTE_FROM + EDITOR.typeDelay;
const PREVIEW_FROM = ROUTE_TYPE_START + ROUTE_TYPE_FRAMES + EDITOR.dwell;
const PREVIEW_END = PREVIEW_FROM + EDITOR.previewDuration;
const EDITOR_DURATION = PREVIEW_END + EDITOR.exit;

// Local-frame markers inside the editor scene (frame 0 = editor enters).
export const EDITOR_SCHEDULE = {
  duration: EDITOR_DURATION,
  pageFrom: PAGE_FROM,
  pageTypeFrames: PAGE_TYPE_FRAMES,
  pageTypeStart: PAGE_TYPE_START,
  previewEnd: PREVIEW_END,
  previewFrom: PREVIEW_FROM,
  routeFrom: ROUTE_FROM,
  routeTypeFrames: ROUTE_TYPE_FRAMES,
  routeTypeStart: ROUTE_TYPE_START,
} as const;

const INTRO_DURATION = 110;
const OUTRO_DURATION = 75;

const INTRO_FROM = 0;
const EDITOR_FROM = INTRO_FROM + INTRO_DURATION;
const OUTRO_FROM = EDITOR_FROM + EDITOR_DURATION;

export const TIMING = {
  editor: { duration: EDITOR_DURATION, from: EDITOR_FROM },
  intro: { duration: INTRO_DURATION, from: INTRO_FROM },
  outro: { duration: OUTRO_DURATION, from: OUTRO_FROM },
} as const;

export const TOTAL_DURATION = OUTRO_FROM + OUTRO_DURATION;
