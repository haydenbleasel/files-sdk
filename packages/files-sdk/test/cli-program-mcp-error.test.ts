import { describe, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { buildProgram } from "../src/cli/program.js";

// Isolated file: mocks the mcp module's *first* import to throw at module
// evaluation. Bun's mock.module factory only runs once per file, and a
// throwing factory is the only way to drive program.ts's
// "@modelcontextprotocol/sdk is missing" branch — so the success-path mock
// (which lives in cli-program.test.ts) can't share a file with this one.
// program.ts pulls mcp.ts in via a dynamic import inside the action, so the
// mock just needs to be installed before parseAsync — not before the static
// import above.
const MCP_MODULE_PATH = fileURLToPath(
  new URL("../src/cli/mcp.ts", import.meta.url)
);

mock.module(MCP_MODULE_PATH, () => {
  throw Object.assign(new Error("Cannot find module"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
});

type WriteFn = typeof process.stderr.write;
type ExitFn = typeof process.exit;

describe("cli/program mcp action — missing optional dep", () => {
  test("ERR_MODULE_NOT_FOUND is rewrapped with a helpful Provider message", async () => {
    const stderr: string[] = [];
    const exits: number[] = [];
    const origErr = process.stderr.write.bind(process.stderr) as WriteFn;
    const origExit = process.exit.bind(process) as ExitFn;
    (process.stderr as { write: WriteFn }).write = ((chunk: unknown) => {
      stderr.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString("utf-8")
      );
      return true;
    }) as WriteFn;
    (process as { exit: ExitFn }).exit = ((code?: number): never => {
      exits.push(code ?? 0);
      throw new Error(`__exit:${code ?? 0}`);
    }) as ExitFn;
    try {
      await expect(
        buildProgram().parseAsync([
          "bun",
          "files",
          "--provider",
          "fs",
          "--root",
          "/tmp",
          "mcp",
        ])
      ).rejects.toThrow("__exit:2");
    } finally {
      (process.stderr as { write: WriteFn }).write = origErr;
      (process as { exit: ExitFn }).exit = origExit;
    }
    expect(exits).toEqual([2]);
    const payload = JSON.parse(stderr.join("")) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe("Provider");
    expect(payload.error.message).toContain("@modelcontextprotocol/sdk");
  });
});
