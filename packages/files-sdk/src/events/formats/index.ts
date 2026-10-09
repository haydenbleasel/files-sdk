// The parser for each notification format. An adapter declares which format
// its provider sends (`capabilities.events`); the parsers live here rather
// than in the adapters, so an adapter bundle never grows by a parser it
// doesn't use.

import { appwriteParser } from "./appwrite.js";
import { azureParser } from "./azure.js";
import { b2Parser } from "./b2.js";
import { boxParser } from "./box.js";
import { cloudinaryParser } from "./cloudinary.js";
import { gcsParser } from "./gcs.js";
import { memoryParser } from "./memory.js";
import { r2Parser } from "./r2.js";
import { s3Parser } from "./s3.js";
import { supabaseParser } from "./supabase.js";
import { tigrisParser } from "./tigris.js";
import type { EventFormat, EventParser } from "./types.js";

const PARSERS: Record<EventFormat, EventParser> = {
  appwrite: appwriteParser,
  azure: azureParser,
  b2: b2Parser,
  box: boxParser,
  cloudinary: cloudinaryParser,
  gcs: gcsParser,
  memory: memoryParser,
  r2: r2Parser,
  s3: s3Parser,
  supabase: supabaseParser,
  tigris: tigrisParser,
};

/** Every format, for option validation and the CLI. */
export const EVENT_FORMATS: readonly EventFormat[] = [
  "appwrite",
  "azure",
  "b2",
  "box",
  "cloudinary",
  "gcs",
  "memory",
  "r2",
  "s3",
  "supabase",
  "tigris",
];

export const isEventFormat = (value: string): value is EventFormat =>
  EVENT_FORMATS.some((format) => format === value);

export const parserFor = (format: EventFormat): EventParser => PARSERS[format];

export type {
  Delivery,
  EventFormat,
  EventParser,
  ParseContext,
  RawEvent,
} from "./types.js";
