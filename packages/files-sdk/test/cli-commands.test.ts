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
  runMove,
  runSignUpload,
  runTransfer,
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
      keys: ["k"],
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
    await runHead({ ...baseOpts({ dryRun: true }), keys: ["k"] });
    expect(lastJson(cap.stdout).action).toBe("head");
    cap.stdout.length = 0;

    await runExists({ ...baseOpts({ dryRun: true }), keys: ["k"] });
    expect(lastJson(cap.stdout).action).toBe("exists");
    cap.stdout.length = 0;

    await runDelete({ ...baseOpts({ dryRun: true }), keys: ["k"] });
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

  test("move dry-run echoes from/to", async () => {
    await runMove({
      ...baseOpts({ dryRun: true }),
      from: "a",
      to: "b",
    });
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "move",
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
    await runHead({ ...baseOpts(), keys: ["h.txt"] });
    expect(lastJson(cap.stdout)).toMatchObject({ key: "h.txt", size: 4 });
  });

  test("head returns a structured { files } result for many keys", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("hm-a.txt", "aa", local);
    await uploadFile("hm-b.txt", "bbbb", local);
    cap.stdout.length = 0;
    await runHead({ ...baseOpts(), keys: ["hm-a.txt", "hm-b.txt"] });
    const out = lastJson(cap.stdout) as { files: { key: string }[] };
    expect(out.files.map((f) => f.key)).toEqual(["hm-a.txt", "hm-b.txt"]);
    expect(out).not.toHaveProperty("errors");
    expect(cap.exits).toEqual([]);
  });

  test("head (many) reports per-key errors and exits non-zero", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("hp.txt", "x", local);
    cap.stdout.length = 0;
    await expect(
      runHead({ ...baseOpts(), keys: ["hp.txt", "nope.txt"] })
    ).rejects.toThrow("__exit:1");
    const out = lastJson(cap.stdout) as {
      files: { key: string }[];
      errors: { key: string }[];
    };
    expect(out.files.map((f) => f.key)).toEqual(["hp.txt"]);
    expect(out.errors.map((e) => e.key)).toEqual(["nope.txt"]);
    // NotFound maps to exit code 1.
    expect(cap.exits).toEqual([1]);
  });

  test("exists prints true for present key and does not exit", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("present", "z", local);
    cap.stdout.length = 0;
    await runExists({ ...baseOpts(), keys: ["present"] });
    expect(lastJson(cap.stdout)).toEqual({ exists: true, key: "present" });
    expect(cap.exits).toEqual([]);
  });

  test("exists exits 1 when key is missing", async () => {
    await expect(
      runExists({ ...baseOpts(), keys: ["missing"] })
    ).rejects.toThrow("__exit:1");
    expect(cap.exits).toEqual([1]);
    expect(lastJson(cap.stdout)).toEqual({ exists: false, key: "missing" });
  });

  test("exists (many) splits existing/missing and exits 1 if any missing", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("ex-a.txt", "a", local);
    await uploadFile("ex-b.txt", "b", local);
    cap.stdout.length = 0;
    await expect(
      runExists({ ...baseOpts(), keys: ["ex-a.txt", "gone.txt", "ex-b.txt"] })
    ).rejects.toThrow("__exit:1");
    expect(lastJson(cap.stdout)).toEqual({
      existing: ["ex-a.txt", "ex-b.txt"],
      missing: ["gone.txt"],
    });
    expect(cap.exits).toEqual([1]);
  });

  test("exists (many) exits 0 when every key exists", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("all-a.txt", "a", local);
    await uploadFile("all-b.txt", "b", local);
    cap.stdout.length = 0;
    await runExists({ ...baseOpts(), keys: ["all-a.txt", "all-b.txt"] });
    expect(lastJson(cap.stdout)).toEqual({
      existing: ["all-a.txt", "all-b.txt"],
      missing: [],
    });
    expect(cap.exits).toEqual([]);
  });

  test("delete removes the underlying file", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("gone.txt", "x", local);
    cap.stdout.length = 0;
    await runDelete({ ...baseOpts(), keys: ["gone.txt"] });
    expect(lastJson(cap.stdout)).toEqual({ deleted: true, key: "gone.txt" });
    await expect(fsp.access(path.join(root, "gone.txt"))).rejects.toThrow();
  });

  test("delete removes many keys and returns a structured result", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("m-a.txt", "a", local);
    await uploadFile("m-b.txt", "b", local);
    cap.stdout.length = 0;
    await runDelete({ ...baseOpts(), keys: ["m-a.txt", "m-b.txt"] });
    expect(lastJson(cap.stdout)).toEqual({ deleted: ["m-a.txt", "m-b.txt"] });
    await expect(fsp.access(path.join(root, "m-a.txt"))).rejects.toThrow();
    await expect(fsp.access(path.join(root, "m-b.txt"))).rejects.toThrow();
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

  test("move renames the object, removing the source", async () => {
    const local = path.join(root, "in.txt");
    await uploadFile("from.txt", "payload", local);
    cap.stdout.length = 0;
    await runMove({ ...baseOpts(), from: "from.txt", to: "to.txt" });
    expect(lastJson(cap.stdout)).toEqual({
      from: "from.txt",
      moved: true,
      to: "to.txt",
    });
    const contents = await fsp.readFile(path.join(root, "to.txt"), "utf-8");
    expect(contents).toBe("payload");
    await expect(fsp.access(path.join(root, "from.txt"))).rejects.toThrow();
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
    await runDownload({ ...baseOpts(), keys: ["d.txt"], out: dest });
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
      keys: ["v.txt"],
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
      keys: ["v2.txt"],
      stdout: true,
    });
    expect(cap.stdout.join("")).toContain("x");
    // Pretty JSON has indented "key":  prefixed with two spaces.
    expect(cap.stderr.join("")).toContain('  "key": "v2.txt"');
  });
});

describe("cli/commands new surface", () => {
  // Write the upload source OUTSIDE the fs root — a file under the root would
  // itself show up as a stray object key in list/transfer results.
  const write = async (key: string, body: string): Promise<void> => {
    const src = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-src-"));
    tmpDirs.push(src);
    const file = path.join(src, "body");
    await fsp.writeFile(file, body);
    await runUpload({ ...baseOpts(), file, key });
    cap.stdout.length = 0;
  };

  test("upload --multipart dry-run echoes multipart: true", async () => {
    await runUpload({
      ...baseOpts({ dryRun: true }),
      key: "k",
      multipart: true,
    });
    expect(lastJson(cap.stdout).multipart).toBe(true);
  });

  test("upload --part-size implies multipart object in dry-run", async () => {
    await runUpload({
      ...baseOpts({ dryRun: true }),
      key: "k",
      multipartConcurrency: 2,
      partSize: 1024,
    });
    expect(lastJson(cap.stdout).multipart).toEqual({
      concurrency: 2,
      partSize: 1024,
    });
  });

  test("upload with neither key nor --dir throws", async () => {
    await expect(runUpload({ ...baseOpts() })).rejects.toThrow(FilesError);
  });

  test("upload --dir rejects a stray key/--file/--stdin", async () => {
    await expect(
      runUpload({ ...baseOpts(), dir: root, key: "k" })
    ).rejects.toThrow(FilesError);
  });

  test("upload --dir dry-run echoes the dir without walking", async () => {
    await runUpload({ ...baseOpts({ dryRun: true }), dir: "/nope" });
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "upload",
      dir: "/nope",
      dryRun: true,
    });
  });

  test("upload --dir uploads a tree, inferring content types", async () => {
    const localDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "files-sdk-dir-")
    );
    tmpDirs.push(localDir);
    await fsp.mkdir(path.join(localDir, "sub"), { recursive: true });
    await fsp.writeFile(path.join(localDir, "a.json"), '{"x":1}');
    await fsp.writeFile(path.join(localDir, "sub", "b.txt"), "hello");
    await runUpload({ ...baseOpts(), dir: localDir });
    const out = lastJson(cap.stdout) as {
      uploaded: { key: string; contentType: string }[];
    };
    expect(out.uploaded.map((u) => u.key)).toEqual(["a.json", "sub/b.txt"]);
    expect(out.uploaded[0]?.contentType).toBe("application/json");
    expect(await fsp.readFile(path.join(root, "sub/b.txt"), "utf-8")).toBe(
      "hello"
    );
  });

  test("download --range slices a single key", async () => {
    await write("r.txt", "downloaded");
    const dest = path.join(root, "slice.bin");
    await runDownload({
      ...baseOpts(),
      keys: ["r.txt"],
      out: dest,
      range: "0-3",
    });
    expect(await fsp.readFile(dest, "utf-8")).toBe("down");
  });

  test("download --range dry-run echoes the parsed range", async () => {
    await runDownload({
      ...baseOpts({ dryRun: true }),
      keys: ["k"],
      range: "10-20",
      stdout: true,
    });
    expect(lastJson(cap.stdout).range).toEqual({ end: 20, start: 10 });
  });

  test("download many --out-dir writes each key under the dir", async () => {
    await write("docs/a.txt", "AAA");
    await write("docs/b.txt", "BBBB");
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-out-"));
    tmpDirs.push(outDir);
    await runDownload({
      ...baseOpts(),
      keys: ["docs/a.txt", "docs/b.txt"],
      outDir,
    });
    const out = lastJson(cap.stdout) as { downloaded: { key: string }[] };
    expect(out.downloaded.map((d) => d.key).toSorted()).toEqual([
      "docs/a.txt",
      "docs/b.txt",
    ]);
    expect(await fsp.readFile(path.join(outDir, "docs/a.txt"), "utf-8")).toBe(
      "AAA"
    );
  });

  test("download many reports per-key errors and exits non-zero", async () => {
    await write("ok.txt", "present");
    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-out-"));
    tmpDirs.push(outDir);
    await expect(
      runDownload({ ...baseOpts(), keys: ["ok.txt", "gone.txt"], outDir })
    ).rejects.toThrow("__exit:1");
    const out = lastJson(cap.stdout) as {
      downloaded: { key: string }[];
      errors: { key: string }[];
    };
    expect(out.downloaded.map((d) => d.key)).toEqual(["ok.txt"]);
    expect(out.errors.map((e) => e.key)).toEqual(["gone.txt"]);
    expect(cap.exits).toEqual([1]);
  });

  test("download many dry-run echoes keys + outDir", async () => {
    await runDownload({
      ...baseOpts({ dryRun: true }),
      keys: ["a", "b"],
      outDir: "/out",
    });
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "download",
      keys: ["a", "b"],
      outDir: "/out",
    });
  });

  test("download many rejects --out / --range / missing --out-dir", async () => {
    await expect(
      runDownload({ ...baseOpts(), keys: ["a", "b"], out: "/x" })
    ).rejects.toThrow(/single key/u);
    await expect(
      runDownload({
        ...baseOpts(),
        keys: ["a", "b"],
        outDir: "/o",
        range: "0-1",
      })
    ).rejects.toThrow(/single key/u);
    await expect(
      runDownload({ ...baseOpts(), keys: ["a", "b"] })
    ).rejects.toThrow(/out-dir/u);
  });

  test("delete many threads --concurrency / --stop-on-error", async () => {
    await write("d-a.txt", "a");
    await write("d-b.txt", "b");
    await runDelete({
      ...baseOpts(),
      concurrency: 1,
      keys: ["d-a.txt", "d-b.txt"],
      stopOnError: true,
    });
    expect(lastJson(cap.stdout)).toEqual({ deleted: ["d-a.txt", "d-b.txt"] });
  });

  test("list --all walks every page and omits the cursor", async () => {
    await write("all/a", "a");
    await write("all/b", "b");
    await runList({ ...baseOpts(), all: true, prefix: "all/" });
    const out = lastJson(cap.stdout) as {
      items: { key: string }[];
      cursor?: string;
    };
    expect(out.items.map((i) => i.key).toSorted()).toEqual(["all/a", "all/b"]);
    expect(out).not.toHaveProperty("cursor");
  });

  test("list --all dry-run echoes all: true", async () => {
    await runList({ ...baseOpts({ dryRun: true }), all: true });
    expect(lastJson(cap.stdout).all).toBe(true);
  });

  test("transfer copies every object to another provider", async () => {
    await write("t/a.txt", "one");
    await write("t/b.txt", "two");
    const destRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "files-sdk-dst-")
    );
    tmpDirs.push(destRoot);
    await runTransfer({
      ...baseOpts(),
      to: JSON.stringify({ provider: "fs", root: destRoot }),
    });
    const out = lastJson(cap.stdout) as { transferred: string[] };
    expect(out.transferred.toSorted()).toEqual(["t/a.txt", "t/b.txt"]);
    expect(await fsp.readFile(path.join(destRoot, "t/a.txt"), "utf-8")).toBe(
      "one"
    );
  });

  test("transfer --no-overwrite skips keys already present", async () => {
    await write("s.txt", "x");
    const destRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "files-sdk-dst-")
    );
    tmpDirs.push(destRoot);
    const to = JSON.stringify({ provider: "fs", root: destRoot });
    await runTransfer({ ...baseOpts(), to });
    cap.stdout.length = 0;
    await runTransfer({ ...baseOpts(), overwrite: false, to });
    expect(lastJson(cap.stdout)).toMatchObject({
      skipped: ["s.txt"],
      transferred: [],
    });
  });

  test("transfer dry-run validates the destination provider", async () => {
    await runTransfer({
      ...baseOpts({ dryRun: true }),
      prefix: "p/",
      to: JSON.stringify({ provider: "fs", root: "/tmp/x" }),
    });
    expect(lastJson(cap.stdout)).toMatchObject({
      action: "transfer",
      prefix: "p/",
      to: "fs",
    });
  });

  test("transfer rejects a non-object or provider-less --to", async () => {
    await expect(runTransfer({ ...baseOpts(), to: "null" })).rejects.toThrow(
      FilesError
    );
    await expect(
      runTransfer({ ...baseOpts(), to: JSON.stringify({ root: "/x" }) })
    ).rejects.toThrow(FilesError);
  });

  test("transfer surfaces verbose per-key progress on stderr", async () => {
    await write("p.txt", "data");
    const destRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "files-sdk-dst-")
    );
    tmpDirs.push(destRoot);
    cap.stderr.length = 0;
    await runTransfer({
      ...baseOpts({ verbose: true }),
      to: JSON.stringify({ provider: "fs", root: destRoot }),
    });
    expect(cap.stderr.join("")).toContain("transferred p.txt");
  });
});
