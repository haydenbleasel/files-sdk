import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import * as realMcp from "../src/cli/mcp.js";
import { buildProgram } from "../src/cli/program.js";

// The mcp subcommand pulls its module in via a dynamic import inside its action
// handler — that's load-bearing because @modelcontextprotocol/sdk is optional
// and the real server attaches to stdin. Rather than `mock.module` the whole
// module (a process-wide override that leaks into other test files and can't be
// reliably reverted — it previously broke cli-mcp's startMcpServer test), we
// inject a stub loader into buildProgram. The stub spreads the real module so
// only `startMcpServer` is replaced, keeping the loader's type honest.
let mcpStartCalls = 0;
const mcpStartArgs: unknown[] = [];
const loadStubMcp = (): Promise<typeof realMcp> =>
  Promise.resolve({
    ...realMcp,
    startMcpServer: (opts: unknown) => {
      mcpStartCalls += 1;
      mcpStartArgs.push(opts);
      return Promise.resolve();
    },
  });

// Integration tests for program.ts — they drive `parseAsync` end-to-end against
// the fs adapter so the wrap()/resolveOpts/action-builder paths get exercised.
// commands.ts logic itself is unit-tested elsewhere; here we only care that the
// CLI plumbing (argv → opts → action) is wired correctly.

type WriteFn = typeof process.stdout.write;
type ExitFn = typeof process.exit;

interface Capture {
  stdout: string[];
  stderr: string[];
  exits: number[];
  restore: () => void;
}

const toStr = (chunk: unknown): string =>
  typeof chunk === "string"
    ? chunk
    : Buffer.from(chunk as Uint8Array).toString("utf-8");

const capture = (): Capture => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const origOut = process.stdout.write.bind(process.stdout) as WriteFn;
  const origErr = process.stderr.write.bind(process.stderr) as WriteFn;
  const origExit = process.exit.bind(process) as ExitFn;
  const origExitCode = process.exitCode;
  (process.stdout as { write: WriteFn }).write = ((chunk: unknown) => {
    stdout.push(toStr(chunk));
    return true;
  }) as WriteFn;
  (process.stderr as { write: WriteFn }).write = ((chunk: unknown) => {
    stderr.push(toStr(chunk));
    return true;
  }) as WriteFn;
  (process as { exit: ExitFn }).exit = ((code?: number): never => {
    exits.push(code ?? 0);
    throw new Error(`__exit:${code ?? 0}`);
  }) as ExitFn;
  return {
    exits,
    restore() {
      (process.stdout as { write: WriteFn }).write = origOut;
      (process.stderr as { write: WriteFn }).write = origErr;
      (process as { exit: ExitFn }).exit = origExit;
      // Commands may signal failure via process.exitCode; reset it or a
      // test's failure code would leak into the runner's own exit status.
      // Bun ignores assigning `undefined` here, so reset to 0 explicitly.
      process.exitCode = origExitCode ?? 0;
    },
    stderr,
    stdout,
  };
};

const lastJson = (chunks: string[]): Record<string, unknown> => {
  const lines = chunks.join("").trim().split("\n");
  return JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>;
};

const tmpDirs: string[] = [];
let root: string;
let cap: Capture;

const run = (...argv: string[]): Promise<unknown> =>
  buildProgram(loadStubMcp).parseAsync(["bun", "files", ...argv]);

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-cli-prog-"));
  tmpDirs.push(root);
  cap = capture();
});

afterEach(async () => {
  cap.restore();
  await Promise.all(
    tmpDirs.splice(0).map((d) => fsp.rm(d, { force: true, recursive: true }))
  );
});

describe("cli/program parseAsync (fs end-to-end)", () => {
  test("upload <key> --file ... --provider fs --root ...", async () => {
    const local = path.join(root, "in.txt");
    await fsp.writeFile(local, "payload");
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "upload",
      "remote/key.txt",
      "--file",
      local,
      "--content-type",
      "text/plain",
      "--cache-control",
      "no-cache",
      "--metadata",
      "x=1",
      "--metadata",
      "y=two"
    );
    expect(await fsp.readFile(path.join(root, "remote/key.txt"), "utf-8")).toBe(
      "payload"
    );
    const result = lastJson(cap.stdout);
    expect(result.key).toBe("remote/key.txt");
  });

  test("download <key> --out <path>", async () => {
    const local = path.join(root, "in.txt");
    await fsp.writeFile(local, "downloaded body");
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "upload",
      "src.txt",
      "--file",
      local
    );
    cap.stdout.length = 0;

    const dest = path.join(root, "got.bin");
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "download",
      "src.txt",
      "--out",
      dest
    );
    expect(await fsp.readFile(dest, "utf-8")).toBe("downloaded body");
  });

  test("list --prefix --limit (intArg coerces, dry-run echoes)", async () => {
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "--dry-run",
      "list",
      "--prefix",
      "p/",
      "--limit",
      "5",
      "--cursor",
      "abc",
      "--delimiter",
      "/"
    );
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "list",
      cursor: "abc",
      delimiter: "/",
      dryRun: true,
      limit: 5,
      prefix: "p/",
      provider: "fs",
    });
  });

  test("search <pattern> wires --prefix/--limit/--max-results/--case-insensitive", async () => {
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "--dry-run",
      "search",
      "docs/*.pdf",
      "--prefix",
      "docs/",
      "--limit",
      "3",
      "--max-results",
      "7",
      "--case-insensitive"
    );
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "search",
      caseInsensitive: true,
      dryRun: true,
      limit: 3,
      match: "glob",
      maxResults: 7,
      pattern: "docs/*.pdf",
      prefix: "docs/",
      provider: "fs",
    });
  });

  test("search --regex and --match resolve the match mode", async () => {
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "--dry-run",
      "search",
      "\\.pdf$",
      "--regex"
    );
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "search",
      match: "regex",
      pattern: "\\.pdf$",
    });

    cap.stdout.length = 0;
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "--dry-run",
      "search",
      "report",
      "--match",
      "substring"
    );
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "search",
      match: "substring",
      pattern: "report",
    });
  });

  test("head/exists/delete/copy/url dry-run go through their action builders", async () => {
    for (const argv of [
      ["head", "k"],
      ["exists", "k"],
      ["delete", "k"],
      ["copy", "a", "b"],
      ["url", "k", "--expires-in", "60"],
    ]) {
      cap.stdout.length = 0;
      // eslint-disable-next-line no-await-in-loop -- each run asserts against the shared stdout capture it just reset
      await run("--provider", "fs", "--root", root, "--dry-run", ...argv);
      expect(lastJson(cap.stdout).dryRun).toBe(true);
    }
  });

  test("capabilities goes through its action builder and prints the snapshot", async () => {
    // No dry-run path — it's pure introspection, so it runs against the fs
    // adapter and emits its capability snapshot.
    await run("--provider", "fs", "--root", root, "capabilities");
    expect(lastJson(cap.stdout)).toMatchObject({
      rangeRead: true,
      serverSideCopy: true,
      signedUrl: { supported: false },
    });
  });

  test("move <from> <to> renames the key through its action builder", async () => {
    const local = path.join(root, "in.txt");
    await fsp.writeFile(local, "moved body");
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "upload",
      "src/from.txt",
      "--file",
      local
    );
    cap.stdout.length = 0;

    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "move",
      "src/from.txt",
      "dst/to.txt"
    );
    expect(lastJson(cap.stdout)).toMatchObject({
      from: "src/from.txt",
      moved: true,
      to: "dst/to.txt",
    });
    expect(await fsp.readFile(path.join(root, "dst/to.txt"), "utf-8")).toBe(
      "moved body"
    );
    await expect(fsp.access(path.join(root, "src/from.txt"))).rejects.toThrow();
  });

  test("sign-upload --expires-in (intArg) + --max-size + --min-size", async () => {
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "--dry-run",
      "sign-upload",
      "key.bin",
      "--expires-in",
      "120",
      "--max-size",
      "1024",
      "--min-size",
      "1"
    );
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "sign-upload",
      expiresIn: 120,
      key: "key.bin",
      maxSize: 1024,
      minSize: 1,
    });
  });

  test("--config-json is parsed and merged with typed flags", async () => {
    // Combine: --bucket from a flag, plus extra fields from --config-json. We
    // dry-run against fs so the JSON parser path runs without touching s3.
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "--config-json",
      '{"unusedExtra":"ok"}',
      "--dry-run",
      "head",
      "key"
    );
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "head",
      dryRun: true,
      keys: ["key"],
      provider: "fs",
    });
  });

  test("missing provider routes through fail() with exit 2", async () => {
    const prev = process.env.FILES_SDK_PROVIDER;
    delete process.env.FILES_SDK_PROVIDER;
    try {
      await expect(run("head", "k")).rejects.toThrow("__exit:2");
      expect(cap.exits).toEqual([2]);
      const payload = JSON.parse(cap.stderr.join(""));
      expect(payload.error.code).toBe("Provider");
      expect(payload.error.message).toContain("--provider is required");
    } finally {
      if (prev !== undefined) {
        process.env.FILES_SDK_PROVIDER = prev;
      }
    }
  });

  test("invalid --config-json throws a Provider FilesError", async () => {
    // resolveOpts() parses --config-json *before* the wrap()'s try/catch,
    // so the error propagates straight out of parseAsync rather than going
    // through fail(). The shape still matches the rest of the SDK.
    await expect(
      run(
        "--provider",
        "fs",
        "--root",
        root,
        "--config-json",
        "{bad json",
        "head",
        "k"
      )
    ).rejects.toThrow("invalid JSON in --config-json");
  });

  test("--pretty + --no-json affect output shape", async () => {
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "--dry-run",
      "--pretty",
      "head",
      "k"
    );
    // Pretty JSON has at least one newline + 2-space indent
    expect(cap.stdout.join("")).toContain('"action": "head"');
  });

  test("intArg rejects non-numeric values from commander", async () => {
    // intArg() throws TypeError; commander wraps it as InvalidArgumentError and
    // routes through its parse-error path (process.exit(1) by default).
    await expect(
      run(
        "--provider",
        "fs",
        "--root",
        root,
        "--dry-run",
        "list",
        "--limit",
        "not-a-number"
      )
    ).rejects.toThrow(/expected an integer/u);
  });

  test("intArg rejects trailing garbage instead of truncating it", async () => {
    // `parseInt` would turn "5MB" into 5 — a 5-byte part size — silently.
    await expect(
      run(
        "--provider",
        "fs",
        "--root",
        root,
        "--dry-run",
        "list",
        "--limit",
        "5MB"
      )
    ).rejects.toThrow(/expected an integer/u);
    await expect(
      run(
        "--provider",
        "fs",
        "--root",
        root,
        "--dry-run",
        "list",
        "--limit",
        "1.9"
      )
    ).rejects.toThrow(/expected an integer/u);
  });

  test("mcp action invokes startMcpServer on the injected mcp module", async () => {
    const before = mcpStartCalls;
    await run("--provider", "fs", "--root", root, "mcp");
    expect(mcpStartCalls).toBe(before + 1);
    expect(mcpStartArgs.at(-1)).toMatchObject({ allowWrites: false });
  });

  test("mcp --allow-writes opts into mutation tools", async () => {
    await run("--provider", "fs", "--root", root, "mcp", "--allow-writes");
    expect(mcpStartArgs.at(-1)).toMatchObject({ allowWrites: true });
  });

  test("mcp --to binds an operator destination for transfer and sync", async () => {
    const destination = { provider: "fs", root };
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "mcp",
      "--allow-writes",
      "--to",
      JSON.stringify(destination)
    );
    expect(mcpStartArgs.at(-1)).toMatchObject({
      allowWrites: true,
      destination,
    });
  });

  test("mcp --to rejects non-object destination config", async () => {
    await expect(
      run("--provider", "fs", "--root", root, "mcp", "--to", "null")
    ).rejects.toThrow("__exit:2");
    const payload = JSON.parse(cap.stderr.join(""));
    expect(payload.error.message).toContain("--to must be a JSON object");
  });

  test("mcp load failure is rewrapped and routed through fail()", async () => {
    const notFound = Object.assign(new Error("nope"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    await expect(
      buildProgram(() => Promise.reject(notFound)).parseAsync([
        "bun",
        "files",
        "--provider",
        "fs",
        "--root",
        root,
        "mcp",
      ])
    ).rejects.toThrow("__exit:2");
    const payload = JSON.parse(cap.stderr.join(""));
    expect(payload.error.message).toContain("@modelcontextprotocol/sdk");
  });

  test("transfer routes through its action builder (dry-run)", async () => {
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "--dry-run",
      "transfer",
      "--to",
      JSON.stringify({ provider: "fs", root }),
      "--prefix",
      "p/",
      "--concurrency",
      "4",
      "--no-overwrite"
    );
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "transfer",
      dryRun: true,
      overwrite: false,
      prefix: "p/",
      to: "fs",
    });
  });

  test("sync routes its flags through the builder and mirrors with prune", async () => {
    const dest = await fsp.mkdtemp(
      path.join(os.tmpdir(), "files-sdk-syncdst-")
    );
    tmpDirs.push(dest);
    await fsp.mkdir(path.join(root, "data"), { recursive: true });
    await fsp.writeFile(path.join(root, "data/a.txt"), "alpha");
    await fsp.mkdir(path.join(dest, "data"), { recursive: true });
    await fsp.writeFile(path.join(dest, "data/stale.txt"), "gone");
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "sync",
      "--to",
      JSON.stringify({ provider: "fs", root: dest }),
      "--prefix",
      "data/",
      "--dest-prefix",
      "data/",
      "--prune",
      "--compare",
      "size",
      "--concurrency",
      "2",
      "--limit",
      "50"
    );
    expect(lastJson(cap.stdout)).toMatchObject({
      deleted: ["data/stale.txt"],
      uploaded: ["data/a.txt"],
    });
    expect(await fsp.exists(path.join(dest, "data/stale.txt"))).toBe(false);
    expect(await fsp.readFile(path.join(dest, "data/a.txt"), "utf-8")).toBe(
      "alpha"
    );
  });

  test("upload/download new flags route through their builders", async () => {
    const local = path.join(root, "in.txt");
    await fsp.writeFile(local, "payload");
    // --multipart + --part-size flow through the upload builder
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "--dry-run",
      "upload",
      "k",
      "--file",
      local,
      "--multipart",
      "--part-size",
      "1024"
    );
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "upload",
      multipart: { partSize: 1024 },
    });
    cap.stdout.length = 0;
    // download --range + many-key/--out-dir flow through the download builder
    await run(
      "--provider",
      "fs",
      "--root",
      root,
      "--dry-run",
      "download",
      "a",
      "b",
      "--out-dir",
      root
    );
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "download",
      keys: ["a", "b"],
    });
  });
});
