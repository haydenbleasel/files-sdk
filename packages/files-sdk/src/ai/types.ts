import type { Tool } from "ai";

/**
 * Common options accepted by every write-tool factory.
 */
export interface ToolOptions {
  needsApproval?: boolean;
}

/**
 * Per-tool overrides for customizing AI SDK `tool()` properties without
 * changing the underlying implementation. Core properties (`execute`,
 * `inputSchema`, `outputSchema`) are intentionally excluded — those drive
 * the tool's behavior and contract and shouldn't be patched at this layer.
 */
export type ToolOverrides = Partial<
  Pick<
    Tool,
    | "description"
    | "needsApproval"
    | "onInputAvailable"
    | "onInputDelta"
    | "onInputStart"
    | "providerOptions"
    | "strict"
    | "title"
    | "toModelOutput"
  >
>;
