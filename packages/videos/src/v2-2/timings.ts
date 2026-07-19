import { NATIVE_SCENE_DURATION } from "./native-scene";
import { NESTJS_SCENE_DURATION } from "./nestjs-scene";
import { R2_FETCH_SCENE_DURATION } from "./r2-fetch-scene";

export const FPS = 30;

const INTRO_DURATION = 110;
const OUTRO_DURATION = 75;

const INTRO_FROM = 0;
const NESTJS_FROM = INTRO_FROM + INTRO_DURATION;
const R2_FETCH_FROM = NESTJS_FROM + NESTJS_SCENE_DURATION;
const NATIVE_FROM = R2_FETCH_FROM + R2_FETCH_SCENE_DURATION;
const OUTRO_FROM = NATIVE_FROM + NATIVE_SCENE_DURATION;

export const TIMING = {
  intro: { duration: INTRO_DURATION, from: INTRO_FROM },
  native: { duration: NATIVE_SCENE_DURATION, from: NATIVE_FROM },
  nestjs: { duration: NESTJS_SCENE_DURATION, from: NESTJS_FROM },
  outro: { duration: OUTRO_DURATION, from: OUTRO_FROM },
  r2Fetch: { duration: R2_FETCH_SCENE_DURATION, from: R2_FETCH_FROM },
} as const;

export const TOTAL_DURATION = OUTRO_FROM + OUTRO_DURATION;
