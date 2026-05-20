import { ADAPTERS_SCENE_DURATION } from "./adapters-scene";
import { CLI_SCENE_DURATION } from "./cli-scene";
import { SKILL_SCENE_DURATION } from "./skill-scene";

export const FPS = 30;

const INTRO_DURATION = 90;
const OUTRO_DURATION = 75;

const INTRO_FROM = 0;
const ADAPTERS_FROM = INTRO_FROM + INTRO_DURATION;
const CLI_FROM = ADAPTERS_FROM + ADAPTERS_SCENE_DURATION;
const SKILL_FROM = CLI_FROM + CLI_SCENE_DURATION;
const OUTRO_FROM = SKILL_FROM + SKILL_SCENE_DURATION;

export const TIMING = {
  adapters: { duration: ADAPTERS_SCENE_DURATION, from: ADAPTERS_FROM },
  cli: { duration: CLI_SCENE_DURATION, from: CLI_FROM },
  intro: { duration: INTRO_DURATION, from: INTRO_FROM },
  outro: { duration: OUTRO_DURATION, from: OUTRO_FROM },
  skill: { duration: SKILL_SCENE_DURATION, from: SKILL_FROM },
} as const;

export const TOTAL_DURATION = OUTRO_FROM + OUTRO_DURATION;
