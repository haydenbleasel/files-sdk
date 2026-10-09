// Which notification format an adapter's bucket speaks, and the parser for it.
// Parsers live here rather than in the adapters, so an adapter bundle never
// grows by a parser it doesn't use.

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

/** Adapter `name` → the notification format its provider is verified to send. */
const ADAPTER_FORMATS = new Map<string, EventFormat>([
  ["appwrite", "appwrite"],
  ["azure", "azure"],
  ["backblaze-b2", "b2"],
  ["box", "box"],
  ["bun-s3", "s3"],
  ["cloudinary", "cloudinary"],
  ["firebase-storage", "gcs"],
  ["gcs", "gcs"],
  ["memory", "memory"],
  ["minio", "s3"],
  ["minio-fetch", "s3"],
  ["rustfs", "s3"],
  ["rustfs-fetch", "s3"],
  ["s3", "s3"],
  ["s3-fetch", "s3"],
  ["supabase", "supabase"],
  ["tigris", "tigris"],
  ["wasabi", "s3"],
]);

/**
 * The format an adapter's notifications arrive in, from its `name`, or
 * `undefined` when it has none `files-sdk/events` can read. Only adapters whose
 * provider is verified to send that format are listed; an S3-compatible
 * wrapper not listed here may send S3-shaped events, but until that's verified
 * it needs an explicit `events({ format: "s3" })`.
 */
export const formatForAdapter = (name: string): EventFormat | undefined =>
  ADAPTER_FORMATS.get(name) ??
  // r2() reports its engine in the name: r2-http, r2-http-fetch, r2-binding, …
  (name === "r2" || name.startsWith("r2-") ? "r2" : undefined);

export const parserFor = (format: EventFormat): EventParser => PARSERS[format];

export type {
  Delivery,
  EventFormat,
  EventParser,
  ParseContext,
  RawEvent,
} from "./types.js";
