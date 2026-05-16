import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  runCopy,
  runDelete,
  runDownload,
  runExists,
  runHead,
  runList,
  runSignUpload,
  runUpload,
  runUrl,
} from "../src/cli/commands.js";
import type { CommonRunOpts } from "../src/cli/commands.js";
import { FilesError } from "../src/internal/errors.js";

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
const makeRoot = async (): Promise<string> => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-cli-cmd-"));
  tmpDirs.push(dir);
  return dir;
};

let root: string;
let cap: Capture;

const baseOpts = (overrides: Partial<CommonRunOpts> = {}): CommonRunOpts => ({
  dryRun: false,
  global: { provider: "fs", root },
  json: true,
  pretty: false,
  verbose: false,
  ...overrides,
});

beforeEach(async () => {
  root = await makeRoot();
  cap = capture();
});

afterEach(async () => {
  cap.restore();
  await Promise.all(
    tmpDirs.splice(0).map((d) => fsp.rm(d, { force: true, recursive: true }))
  );
});

describe("cli/commands dry-run", () => {
  test("upload prints {action, dryRun, provider, key, source}", async () => {
    await runUpload({
      ...baseOpts({ dryRun: true }),
      cacheControl: "no-cache",
      contentType: "text/plain",
      file: "./local.txt",
      key: "k",
      metadata: ["a=1", "b=two"],
    });
    expect(lastJson(cap.stdout)).toEqual({
      action: "upload",
      cacheControl: "no-cache",
      contentType: "text/plain",
      dryRun: true,
      key: "k",
      metadata: { a: "1", b: "two" },
      provider: "fs",
      source: "./local.txt",
    });
  });

  test("upload with --stdin reports source=<stdin>", async () => {
    await runUpload({
      ...baseOpts({ dryRun: true }),
      key: "k",
      stdin: true,
    });
    expect(lastJson(cap.stdout).source).toBe("<stdin>");
  });

  test("download dry-run prints dest=<stdout> when --stdout", async () => {
    await runDownload({
      ...baseOpts({ dryRun: true }),
      key: "k",
      stdout: true,
    });
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "download",
      dest: "<stdout>",
      dryRun: true,
      key: "k",
      provider: "fs",
    });
  });

  test("head / exists / delete dry-runs name the action", async () => {
    await runHead({ ...baseOpts({ dryRun: true }), key: "k" });
    expect(lastJson(cap.stdout).action).toBe("head");
    cap.stdout.length = 0;

    await runExists({ ...baseOpts({ dryRun: true }), key: "k" });
    expect(lastJson(cap.stdout).action).toBe("exists");
    cap.stdout.length = 0;

    await runDelete({ ...baseOpts({ dryRun: true }), key: "k" });
    expect(lastJson(cap.stdout).action).toBe("delete");
  });

  test("copy dry-run echoes from/to", async () => {
    await runCopy({
      ...baseOpts({ dryRun: true }),
      from: "a",
      to: "b",
    });
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "copy",
      from: "a",
      to: "b",
    });
  });

  test("list dry-run echoes prefix/cursor/limit", async () => {
    await runList({
      ...baseOpts({ dryRun: true }),
      cursor: "c",
      limit: 10,
      prefix: "p/",
    });
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "list",
      cursor: "c",
      limit: 10,
      prefix: "p/",
    });
  });

  test("url dry-run echoes expiresIn and disposition", async () => {
    await runUrl({
      ...baseOpts({ dryRun: true }),
      expiresIn: 60,
      key: "k",
      responseContentDisposition: "attachment",
    });
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "url",
      expiresIn: 60,
      key: "k",
      responseContentDisposition: "attachment",
    });
  });

  test("sign-upload dry-run echoes all knobs", async () => {
    await runSignUpload({
      ...baseOpts({ dryRun: true }),
      contentType: "image/png",
      expiresIn: 30,
      key: "k",
      maxSize: 1024,
      minSize: 1,
    });
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "sign-upload",
      contentType: "image/png",
      expiresIn: 30,
      key: "k",
      maxSize: 1024,
      minSize: 1,
    });
  });

  test("sign-upload rejects non-positive expires-in before any I/O", async () => {
    await expect(
      runSignUpload({
        ...baseOpts({ dryRun: true }),
        expiresIn: 0,
        key: "k",
      })
    ).rejects.toBeInstanceOf(FilesError);
  });
});

describe("cli/commands real (fs adapter)", () => {
  const uploadFile = async (
    key: string,
    body: string,
    file: string
  ): Promise<void> => {
    await fsp.writeFile(file, body);
    await runUpload({ ...baseOpts(), file, key });
  };

  test("upload from --file writes through to the fs root", async () => {
    const local = path.join(root, "input.txt");
    await uploadFile("docs/note.txt", "hello fs", local);
    const written = await fsp.readFile(
      path.join(root, "docs/note.txt"),
      "utf-8"
    );
    expect(written).toBe("hello fs");
    const result = lastJson(cap.stdout);
    expect(result.key).toBe("docs/note.txt");
    expect(result.size).toBe("hello fs".length);
  });

  test("head returns metadata JSON for an existing key", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("h.txt", "abcd", local);
    cap.stdout.length = 0;
    await runHead({ ...baseOpts(), key: "h.txt" });
    expect(lastJson(cap.stdout)).toMatchObject({ key: "h.txt", size: 4 });
  });

  test("exists prints true for present key and does not exit", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("present", "z", local);
    cap.stdout.length = 0;
    await runExists({ ...baseOpts(), key: "present" });
    expect(lastJson(cap.stdout)).toEqual({ exists: true, key: "present" });
    expect(cap.exits).toEqual([]);
  });

  test("exists exits 1 when key is missing", async () => {
    await expect(runExists({ ...baseOpts(), key: "missing" })).rejects.toThrow(
      "__exit:1"
    );
    expect(cap.exits).toEqual([1]);
    expect(lastJson(cap.stdout)).toEqual({ exists: false, key: "missing" });
  });

  test("delete removes the underlying file", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("gone.txt", "x", local);
    cap.stdout.length = 0;
    await runDelete({ ...baseOpts(), key: "gone.txt" });
    expect(lastJson(cap.stdout)).toEqual({ deleted: true, key: "gone.txt" });
    await expect(fsp.access(path.join(root, "gone.txt"))).rejects.toThrow();
  });

  test("copy duplicates the object server-side", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("src.txt", "data", local);
    cap.stdout.length = 0;
    await runCopy({ ...baseOpts(), from: "src.txt", to: "dst.txt" });
    expect(lastJson(cap.stdout)).toEqual({
      copied: true,
      from: "src.txt",
      to: "dst.txt",
    });
    const contents = await fsp.readFile(path.join(root, "dst.txt"), "utf-8");
    expect(contents).toBe("data");
  });

  test("list returns sorted items under a prefix", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("docs/a", "a", local);
    await uploadFile("docs/b", "bb", local);
    await uploadFile("other", "c", local);
    cap.stdout.length = 0;
    await runList({ ...baseOpts(), prefix: "docs/" });
    const out = lastJson(cap.stdout) as {
      items: { key: string }[];
    };
    expect(out.items.map((i) => i.key)).toEqual(["docs/a", "docs/b"]);
  });

  test("url returns a file:// URL by default for the fs adapter", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("u.txt", "u", local);
    cap.stdout.length = 0;
    await runUrl({ ...baseOpts(), key: "u.txt" });
    const out = lastJson(cap.stdout) as { key: string; url: string };
    expect(out.key).toBe("u.txt");
    expect(out.url.startsWith("file://")).toBe(true);
  });

  test("sign-upload returns method/url/headers", async () => {
    cap.stdout.length = 0;
    // fs adapter needs a urlBaseUrl to know where to sign against —
    // there's no real upload endpoint in-process.
    await runSignUpload({
      ...baseOpts({
        global: {
          provider: "fs",
          root,
          urlBaseUrl: "http://localhost:3000/upload",
        },
      }),
      expiresIn: 60,
      key: "up.bin",
    });
    const out = lastJson(cap.stdout) as {
      key: string;
      url: string;
      method: string;
    };
    expect(out.key).toBe("up.bin");
    expect(out.url).toContain("http://localhost:3000/upload");
    expect(out.method).toBe("PUT");
  });

  test("download with --out writes file and emits metadata JSON to stdout", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("d.txt", "downloaded", local);
    const dest = path.join(root, "out.bin");
    cap.stdout.length = 0;
    await runDownload({ ...baseOpts(), key: "d.txt", out: dest });
    expect(await fsp.readFile(dest, "utf-8")).toBe("downloaded");
    const out = lastJson(cap.stdout) as { key: string; size: number };
    expect(out.key).toBe("d.txt");
    expect(out.size).toBe("downloaded".length);
  });

  test("download with --stdout --verbose emits body to stdout and JSON metadata to stderr", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("v.txt", "verbose-body", local);
    cap.stdout.length = 0;
    cap.stderr.length = 0;
    await runDownload({
      ...baseOpts({ verbose: true }),
      key: "v.txt",
      stdout: true,
    });
    // Body should land on stdout untouched (raw stream, no JSON wrapper).
    expect(cap.stdout.join("")).toContain("verbose-body");
    // Metadata envelope should land on stderr so it doesn't pollute the byte
    // stream — same JSON shape as the `--out` path emits to stdout.
    const meta = JSON.parse(cap.stderr.join("").trim()) as {
      key: string;
      size: number;
    };
    expect(meta.key).toBe("v.txt");
    expect(meta.size).toBe("verbose-body".length);
  });

  test("download with --stdout --verbose --no-json writes pretty metadata to stderr", async () => {
    // --no-json (`json: false`) flips the stderr formatter from compact JSON
    // to a two-space pretty-printed envelope — humans get readable output,
    // machines opt in via --json (the default).
    const local = path.join(root, "in.txt");
    await uploadFile("v2.txt", "x", local);
    cap.stdout.length = 0;
    cap.stderr.length = 0;
    await runDownload({
      ...baseOpts({ json: false, verbose: true }),
      key: "v2.txt",
      stdout: true,
    });
    expect(cap.stdout.join("")).toContain("x");
    // Pretty JSON has indented "key":  prefixed with two spaces.
    expect(cap.stderr.join("")).toContain('  "key": "v2.txt"');
  });
});
