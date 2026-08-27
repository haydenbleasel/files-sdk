import { toJSONSchema } from "zod";
import type { ZodType } from "zod";

type JsonSchema = Record<string, unknown>;

/**
 * Convert a Zod schema to a JSON Schema object suitable for OpenAI's
 * function-tool `parameters` field. Strips `$schema` (the OpenAI API ignores
 * dialect declarations and including it just bloats every tool definition).
 *
 * Requires Zod 4 — Zod 3 does not expose `toJSONSchema`. The `files-sdk/openai`
 * subpath inherits this requirement.
 */
export const toOpenAIJsonSchema = (schema: ZodType): JsonSchema => {
  const json = toJSONSchema(schema) as JsonSchema;
  // oxlint-disable-next-line sonarjs/no-unused-vars -- destructure-omit strips $schema from the JSON Schema before returning
  const { $schema: _ignored, ...rest } = json;
  return rest;
};

const isObjectSchema = (node: JsonSchema): boolean =>
  node.type === "object" &&
  typeof node.properties === "object" &&
  node.properties !== null;

// A free-form map (`z.record(...)`): an object with no fixed `properties`
// whose `additionalProperties` is itself a schema. Strict mode requires
// `additionalProperties: false` on every object, so these can't be expressed.
const isOpenRecord = (node: JsonSchema): boolean =>
  node.type === "object" &&
  node.properties === undefined &&
  typeof node.additionalProperties === "object" &&
  node.additionalProperties !== null;

// Strict mode has no notion of an optional property: every key must be
// listed in `required`, and "absent" is modelled as an explicit `null`.
const nullable = (node: JsonSchema): JsonSchema => {
  const { description, ...rest } = node;
  return {
    ...(description !== undefined && { description }),
    anyOf: [rest, { type: "null" }],
  };
};

const strictify = (node: JsonSchema): JsonSchema => {
  if (!isObjectSchema(node)) {
    return node;
  }
  const required = new Set(
    Array.isArray(node.required) ? (node.required as string[]) : []
  );
  const properties: Record<string, JsonSchema> = {};
  for (const [name, raw] of Object.entries(
    node.properties as Record<string, JsonSchema>
  )) {
    if (isOpenRecord(raw)) {
      continue;
    }
    const inner = strictify(raw);
    properties[name] = required.has(name) ? inner : nullable(inner);
  }
  return {
    ...node,
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
};

/**
 * Like {@link toOpenAIJsonSchema}, but shaped for OpenAI's strict mode
 * (`strict: true` on a function tool / Structured Outputs). Strict mode
 * rejects the plain conversion with a 400 because it requires every property
 * to be listed in `required` and `additionalProperties: false` on every
 * object. This variant:
 *
 * - lists every property in `required`, wrapping the optional ones as
 *   `anyOf: [<schema>, { type: "null" }]` so the model passes `null` instead
 *   of omitting them;
 * - sets `additionalProperties: false` on every object;
 * - drops free-form map properties (`z.record(...)`, e.g. `uploadFile`'s
 *   `metadata`), which strict mode cannot represent.
 *
 * Pair with {@link stripNullArgs} before validating the model's arguments so
 * a `null` for an optional field reads as "absent".
 */
export const toOpenAIStrictJsonSchema = (schema: ZodType): JsonSchema =>
  strictify(toOpenAIJsonSchema(schema));

/**
 * Map top-level `null` argument values to "absent" so arguments produced
 * under a strict schema (where optional fields are nullable, never omitted)
 * validate against the underlying Zod schema's `.optional()` fields.
 */
export const stripNullArgs = (args: unknown): unknown => {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return args;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== null) {
      out[key] = value;
    }
  }
  return out;
};
