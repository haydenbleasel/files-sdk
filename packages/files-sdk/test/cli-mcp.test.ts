import { describe, expect, test } from "bun:test";

import {
  assertMcpDownloadFitsCap,
  DEFAULT_MCP_DOWNLOAD_MAX_BYTES,
  MAX_MCP_DOWNLOAD_BYTES,
  mcpDownloadSize,
  resolveMcpDownloadCap,
} from "../src/cli/mcp.js";
import { FilesError } from "../src/index.js";

describe("cli/mcp download guards", () => {
  test("download cap defaults to the MCP hard ceiling", () => {
    expect(resolveMcpDownloadCap()).toBe(DEFAULT_MCP_DOWNLOAD_MAX_BYTES);
    expect(MAX_MCP_DOWNLOAD_BYTES).toBe(DEFAULT_MCP_DOWNLOAD_MAX_BYTES);
  });

  test("download cap cannot be raised above the hard ceiling", () => {
    expect(() => resolveMcpDownloadCap(MAX_MCP_DOWNLOAD_BYTES + 1)).toThrow(
      FilesError
    );
  });

  test("range size is computed before body transfer", () => {
    expect(mcpDownloadSize(100, { end: 19, start: 10 })).toBe(10);
    expect(mcpDownloadSize(100, { start: 10 })).toBe(90);
    expect(mcpDownloadSize(100, { end: 200, start: 90 })).toBe(10);
    expect(mcpDownloadSize(100, { start: 120 })).toBe(0);
  });

  test("oversized effective body is rejected", () => {
    expect(() => assertMcpDownloadFitsCap("big.bin", 11, 10)).toThrow(
      /maxBytes=10/u
    );
  });
});
