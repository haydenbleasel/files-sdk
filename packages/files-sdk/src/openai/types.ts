/**
 * Per-tool overrides for `createResponsesFileTools`. `name`, `parameters`, and
 * `type` are intentionally not overridable — the contract that drives tool
 * behavior should not be patched at this layer.
 */
export interface ResponsesToolOverrides {
  description?: string;
  strict?: boolean;
}

/**
 * Per-tool overrides for `createAgentsFileTools`. `name`, `parameters`,
 * `execute`, and `strict` are intentionally not overridable — the contract
 * that drives tool behavior should not be patched at this layer.
 */
export interface AgentsToolOverrides {
  description?: string;
  needsApproval?: boolean;
}
