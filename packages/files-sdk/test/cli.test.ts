import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCopy,
  runDelete,
  runDownload,
  runExists,
  runHead,
  runList,
  runUpload,
} from "../src/cli/commands.js";
import {
  fileBodyStream,
  parseJson,
  parseKeyValuePairs,
  parseRange,
  walkDir,
  writeBodyToDir,
} from "../src/cli/io.js";
import { loadFiles } from "../src/cli/loader.js";
import { buildProgram } from "../src/cli/program.js";
import { PROVIDER_NAMES, PROVIDERS } from "../src/cli/registry.js";
import type { StoredFile } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";

const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- sequentially draining a stream reader
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
};

// Minimal StoredFile whose only meaningful members for writeBodyToDir are
// `key` and `stream()`. The rest satisfy the type.
const fakeStoredFile = (key: string, body: string): StoredFile =>
  ({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob([body])),
    key,
    name: key,
    size: body.length,
    stream: () => new Response(body).body as ReadableStream<Uint8Array>,
    text: () => Promise.resolve(body),
    type: "text/plain",
  }) as StoredFile;

describe("cli/io", () => {
  test("parseKeyValuePairs splits k=v", () => {
    expect(parseKeyValuePairs(["a=1", "b=two"])).toEqual({ a: "1", b: "two" });
  });

  test("parseKeyValuePairs preserves '=' inside values", () => {
    expect(parseKeyValuePairs(["token=abc=def"])).toEqual({
      token: "abc=def",
    });
  });

  test("parseKeyValuePairs throws on missing =", () => {
    expect(() => parseKeyValuePairs(["bad"])).toThrow(FilesError);
  });

  test("parseKeyValuePairs returns undefined for empty input", () => {
    expect(parseKeyValuePairs()).toBeUndefined();
    expect(parseKeyValuePairs([])).toBeUndefined();
  });

  test("parseJson round-trips valid JSON", () => {
    expect(parseJson<{ region: string }>('{"region":"us-east-1"}')).toEqual({
      region: "us-east-1",
    });
  });

  test("parseJson returns undefined for empty input", () => {
    expect(parseJson()).toBeUndefined();
    expect(parseJson("")).toBeUndefined();
  });

  test("parseJson throws FilesError on malformed JSON", () => {
    expect(() => parseJson("{bad")).toThrow(FilesError);
    // The default attribution names --config-json…
    expect(() => parseJson("{bad")).toThrow(/--config-json/u);
    // …and callers parsing other flags name theirs (transfer/sync `--to`
    // would otherwise blame a flag the user never passed).
    expect(() => parseJson("{bad", "--to")).toThrow(/--to/u);
  });

  test("parseRange parses start-end and start- forms", () => {
    expect(parseRange("0-99")).toEqual({ end: 99, start: 0 });
    expect(parseRange("100-")).toEqual({ start: 100 });
  });

  test("parseRange returns undefined for empty input", () => {
    expect(parseRange()).toBeUndefined();
    expect(parseRange("")).toBeUndefined();
  });

  test("parseRange throws FilesError on a malformed range", () => {
    expect(() => parseRange("abc")).toThrow(FilesError);
    expect(() => parseRange("-100")).toThrow(FilesError);
  });
});

describe("cli/io filesystem helpers", () => {
  const tmp: string[] = [];
  const mkroot = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), "files-sdk-io-"));
    tmp.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(
      tmp.splice(0).map((d) => rm(d, { force: true, recursive: true }))
    );
  });

  test("fileBodyStream streams a file's bytes lazily", async () => {
    const dir = await mkroot();
    const file = path.join(dir, "body.txt");
    await writeFile(file, "lazy bytes");
    expect(await collect(fileBodyStream(file))).toBe("lazy bytes");
  });

  test("fileBodyStream closes cleanly on an empty file", async () => {
    const dir = await mkroot();
    const file = path.join(dir, "empty.txt");
    await writeFile(file, "");
    expect(await collect(fileBodyStream(file))).toBe("");
  });

  test("fileBodyStream cancel tears down the underlying reader", async () => {
    const dir = await mkroot();
    const file = path.join(dir, "cancel.txt");
    await writeFile(file, "abcdef");
    const stream = fileBodyStream(file);
    const reader = stream.getReader();
    // The first read opens the underlying file (reader is now defined);
    // cancelling then exercises the stream's cancel path.
    await reader.read();
    await reader.cancel();
  });

  test("walkDir returns sorted, posix-keyed regular files only", async () => {
    const dir = await mkroot();
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "b.txt"), "b");
    await writeFile(path.join(dir, "a.txt"), "a");
    await writeFile(path.join(dir, "sub", "c.txt"), "c");
    const walked = await walkDir(dir);
    expect(walked.map((f) => f.key)).toEqual(["a.txt", "b.txt", "sub/c.txt"]);
  });

  test("writeBodyToDir writes under the dir, creating subdirs", async () => {
    const dir = await mkroot();
    const dest = await writeBodyToDir(fakeStoredFile("x/y/z.txt", "deep"), dir);
    expect(dest).toBe(path.join(dir, "x/y/z.txt"));
    expect(await readFile(dest, "utf-8")).toBe("deep");
  });

  test("writeBodyToDir refuses keys that escape the directory", async () => {
    const dir = await mkroot();
    await expect(
      writeBodyToDir(fakeStoredFile("../escape.txt", "no"), dir)
    ).rejects.toThrow(FilesError);
  });
});

describe("cli/registry", () => {
  test("PROVIDER_NAMES is sorted and non-empty", () => {
    expect(PROVIDER_NAMES.length).toBeGreaterThan(0);
    const sorted = [...PROVIDER_NAMES].toSorted();
    expect(PROVIDER_NAMES).toEqual(sorted);
  });

  test("every PROVIDER entry exposes a load() function", () => {
    for (const name of PROVIDER_NAMES) {
      const entry = PROVIDERS[name];
      expect(entry).toBeDefined();
      expect(typeof entry?.load).toBe("function");
      expect(Array.isArray(entry?.required)).toBe(true);
    }
  });

  test("PROVIDER_NAMES covers s3, r2, fs, gcs, azure", () => {
    for (const required of ["s3", "r2", "fs", "gcs", "azure"]) {
      expect(PROVIDER_NAMES).toContain(required);
    }
  });
});

describe("cli/program", () => {
  test("buildProgram registers the expected commands", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name()).toSorted();
    expect(names).toEqual([
      "capabilities",
      "copy",
      "delete",
      "download",
      "exists",
      "head",
      "list",
      "mcp",
      "move",
      "search",
      "sign-upload",
      "sync",
      "transfer",
      "upload",
      "url",
    ]);
  });

  test("global flags include the documented set", () => {
    const program = buildProgram();
    const longs = program.options.map((o) => o.long);
    for (const flag of [
      "--provider",
      "--config-json",
      "--key-prefix",
      "--timeout",
      "--retries",
      "--bucket",
      "--region",
      "--endpoint",
      "--access-key-id",
      "--secret-access-key",
      "--token",
      "--access",
      "--no-json",
      "--pretty",
      "--verbose",
      "--dry-run",
    ]) {
      expect(longs).toContain(flag);
    }
  });

  test("--no-json maps to json=false; --pretty/--verbose/--dry-run default off", () => {
    // Parsing the options requires a subcommand to satisfy commander; use one
    // that's safe under exitOverride and a missing provider — `--dry-run` on
    // `list` would still want a provider, so we just inspect parseOptions
    // (which doesn't dispatch any action).
    const program = buildProgram();
    const parsed = program.parseOptions([
      "--no-json",
      "--pretty",
      "--verbose",
      "--dry-run",
    ]);
    // parseOptions sets values on the program; check via opts()
    const opts = program.opts() as {
      json: boolean;
      pretty: boolean;
      verbose: boolean;
      dryRun: boolean;
    };
    expect(opts.json).toBe(false);
    expect(opts.pretty).toBe(true);
    expect(opts.verbose).toBe(true);
    expect(opts.dryRun).toBe(true);
    expect(parsed.unknown).toEqual([]);
  });

  // commander's Option public type omits the `conflictsWith` runtime field —
  // narrow via a structural cast so the test still asserts the wiring.
  interface WithConflicts {
    conflictsWith: readonly string[];
  }

  test("upload's --file declares conflict with --stdin (and vice versa)", () => {
    const program = buildProgram();
    const upload = program.commands.find((c) => c.name() === "upload");
    expect(upload).toBeDefined();
    const fileOpt = upload?.options.find((o) => o.long === "--file");
    const stdinOpt = upload?.options.find((o) => o.long === "--stdin");
    expect((fileOpt as unknown as WithConflicts).conflictsWith).toContain(
      "stdin"
    );
    expect((stdinOpt as unknown as WithConflicts).conflictsWith).toContain(
      "file"
    );
  });

  test("download's --out declares conflict with --stdout (and vice versa)", () => {
    const program = buildProgram();
    const download = program.commands.find((c) => c.name() === "download");
    expect(download).toBeDefined();
    const outOpt = download?.options.find((o) => o.long === "--out");
    const stdoutOpt = download?.options.find((o) => o.long === "--stdout");
    expect((outOpt as unknown as WithConflicts).conflictsWith).toContain(
      "stdout"
    );
    expect((stdoutOpt as unknown as WithConflicts).conflictsWith).toContain(
      "out"
    );
  });

  test("version is reported via .version() and matches semver", () => {
    const program = buildProgram();
    // commander stores the configured version on the program; we just check
    // that it's a semver-looking string (the actual value is sourced from
    // package.json at build time).
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});

// End-to-end exercise of the CLI command layer against the fs adapter.
// This catches wiring bugs between program.ts → commands.ts → loader.ts →
// registry.ts that the unit-only tests above can't see.
describe("cli/commands (fs integration)", () => {
  let root: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;

  const out = { json: true, pretty: false, verbose: false } as const;

  const captureStdout = (): string => stdoutChunks.join("");
  const captureStderr = (): string => stderrChunks.join("");

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "files-sdk-cli-"));
    stdoutChunks = [];
    stderrChunks = [];
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    await rm(root, { force: true, recursive: true });
  });

  const common = () => ({
    ...out,
    dryRun: false,
    global: { provider: "fs", root },
  });

  test("upload writes the file under root", async () => {
    const src = path.join(root, "src.txt");
    await Bun.write(src, "hello");
    await runUpload({
      ...common(),
      contentType: "text/plain",
      file: src,
      key: "greetings/hi.txt",
    });
    const written = await readFile(
      path.join(root, "greetings/hi.txt"),
      "utf-8"
    );
    expect(written).toBe("hello");
    const payload = JSON.parse(captureStdout()) as { key: string };
    expect(payload.key).toBe("greetings/hi.txt");
  });

  test("download streams the body to a destination file", async () => {
    const src = path.join(root, "src.txt");
    await Bun.write(src, "world");
    await runUpload({ ...common(), file: src, key: "out/body.txt" });
    stdoutChunks.length = 0;

    const dest = path.join(root, "downloaded.txt");
    await runDownload({ ...common(), keys: ["out/body.txt"], out: dest });
    expect(await readFile(dest, "utf-8")).toBe("world");
  });

  test("head returns metadata for an uploaded key", async () => {
    const src = path.join(root, "src.bin");
    await Bun.write(src, "abcd");
    await runUpload({ ...common(), file: src, key: "meta.bin" });
    stdoutChunks.length = 0;

    await runHead({ ...common(), keys: ["meta.bin"] });
    const meta = JSON.parse(captureStdout()) as { key: string; size: number };
    expect(meta.key).toBe("meta.bin");
    expect(meta.size).toBe(4);
  });

  test("exists prints true when the key is present", async () => {
    const src = path.join(root, "src.txt");
    await Bun.write(src, "x");
    await runUpload({ ...common(), file: src, key: "present.txt" });
    stdoutChunks.length = 0;

    await runExists({ ...common(), keys: ["present.txt"] });
    const payload = JSON.parse(captureStdout()) as { exists: boolean };
    expect(payload.exists).toBe(true);
  });

  test("copy duplicates the body server-side", async () => {
    const src = path.join(root, "src.txt");
    await Bun.write(src, "copied");
    await runUpload({ ...common(), file: src, key: "from.txt" });
    stdoutChunks.length = 0;

    await runCopy({ ...common(), from: "from.txt", to: "to.txt" });
    expect(await readFile(path.join(root, "to.txt"), "utf-8")).toBe("copied");
  });

  test("delete removes the key", async () => {
    const src = path.join(root, "src.txt");
    await Bun.write(src, "doomed");
    await runUpload({ ...common(), file: src, key: "kill.txt" });
    stdoutChunks.length = 0;

    await runDelete({ ...common(), keys: ["kill.txt"] });
    const { files } = await loadFiles({ provider: "fs", root });
    expect(await files.exists("kill.txt")).toBe(false);
  });

  test("list returns uploaded keys under a prefix", async () => {
    const src = path.join(root, "src.txt");
    await Bun.write(src, "x");
    await runUpload({ ...common(), file: src, key: "logs/a.txt" });
    await runUpload({ ...common(), file: src, key: "logs/b.txt" });
    await runUpload({ ...common(), file: src, key: "other/c.txt" });
    stdoutChunks.length = 0;

    await runList({ ...common(), prefix: "logs/" });
    const result = JSON.parse(captureStdout()) as {
      items: { key: string }[];
    };
    const keys = result.items.map((i) => i.key).toSorted();
    expect(keys).toEqual(["logs/a.txt", "logs/b.txt"]);
  });

  test("dry-run skips network calls and emits intent", async () => {
    await runUpload({
      ...common(),
      dryRun: true,
      file: "/does/not/exist.txt",
      key: "skipped.txt",
    });
    const payload = JSON.parse(captureStdout()) as {
      action: string;
      dryRun: boolean;
      provider: string;
    };
    expect(payload).toMatchObject({
      action: "upload",
      dryRun: true,
      provider: "fs",
    });
    // No file should have been touched
    expect(captureStderr()).toBe("");
  });
});
