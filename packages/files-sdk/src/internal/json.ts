// The value space of `JSON.parse` / `Response#json()`. Boundary code (the
// gateway's request validators, provider REST error bodies, the CLI's stdin
// parsing) narrows a decoded payload to one of these instead of carrying a
// `Record<string, unknown>` around, so the concrete value contract is stated
// once at the boundary and every downstream read is a checked field read.

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

export type JsonArray = JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/** A decoded JSON object — non-null, not an array. */
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A decoded JSON array. */
export const isJsonArray = (value: unknown): value is JsonArray =>
  Array.isArray(value);
