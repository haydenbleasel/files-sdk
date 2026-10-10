/**
 * Per-tool overrides for `createResponsesFileTools`. `name`, `parameters`, and
 * `type` are intentionally not overridable — the contract that drives tool
 * behavior should not be patched at this layer.
 */
export interface ResponsesToolOverrides {
  description?: string;
  /**
   * Emit the tool with OpenAI strict mode enabled. The `parameters` schema
   * is reshaped to what strict mode accepts: every property is listed in
   * `required` (optional ones become nullable, and `execute` treats `null`
   * as "absent"), and free-form maps are dropped — so `uploadFile` loses its
   * `metadata` field under strict mode.
   */
  strict?: boolean;
}

/**
 * Per-tool overrides for `createAgentsFileTools`, also accepted by each
 * single-tool factory (`agentsDeleteFile(files, { needsApproval: false })`).
 * The tool is built with them, so the Agents SDK receives `needsApproval` in
 * the shape its runner calls. `name`, `parameters`, `execute`, and `strict`
 * are intentionally not overridable — the contract that drives tool behavior
 * should not be patched at this layer.
 */
export interface AgentsToolOverrides {
  description?: string;
  /** Whether a call waits for approval. Defaults to `true` for write tools, `false` for reads. */
  needsApproval?: boolean;
}
