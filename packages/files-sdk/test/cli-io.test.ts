import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import {
  emit,
  fail,
  readBody,
  storedFileToJson,
  writeBody,
} from "../src/cli/io.js";
import { createStoredFile } from "../src/index.js";
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

describe("cli/io emit", () => {
  let cap: Capture;
  beforeEach(() => {
    cap = capture();
  });
  afterEach(() => {
    cap.restore();
  });

  test("json mode (default) writes single-line JSON + newline to stdout", () => {
    emit({ a: 1, b: "x" }, { json: true, pretty: false, verbose: false });
    expect(cap.stdout.join("")).toBe('{"a":1,"b":"x"}\n');
  });

  test("json + pretty indents output", () => {
    emit({ a: 1 }, { json: true, pretty: true, verbose: false });
    expect(cap.stdout.join("")).toBe('{\n  "a": 1\n}\n');
  });

  test("non-json string passes through verbatim", () => {
    emit("hello", { json: false, pretty: false, verbose: false });
    expect(cap.stdout.join("")).toBe("hello\n");
  });

  test("non-json object falls back to pretty JSON for humans", () => {
    emit({ k: 2 }, { json: false, pretty: false, verbose: false });
    expect(cap.stdout.join("")).toBe('{\n  "k": 2\n}\n');
  });

  test("embedded FilesErrors keep their message and drop their cause", () => {
    // Bulk partial-failure results embed live FilesErrors. `message` is a
    // non-enumerable Error property (a bare stringify drops it) and the
    // enumerable `cause` is the raw provider error, which must not leak
    // request internals across the CLI boundary.
    const providerError = Object.assign(new Error("raw provider failure"), {
      requestId: "req-123",
    });
    const payload = {
      deleted: ["a.txt"],
      errors: [
        {
          error: new FilesError("NotFound", "Not found: b.txt", providerError),
          key: "b.txt",
        },
      ],
    };
    emit(payload, { json: true, pretty: false, verbose: false });
    const parsed = JSON.parse(cap.stdout.join("")) as {
      errors: { key: string; error: Record<string, unknown> }[];
    };
    expect(parsed.errors[0]?.error).toEqual({
      aborted: false,
      code: "NotFound",
      message: "Not found: b.txt",
      timedOut: false,
    });
  });
});

describe("cli/io fail", () => {
  let cap: Capture;
  beforeEach(() => {
    cap = capture();
  });
  afterEach(() => {
    cap.restore();
  });

  const out = { json: true, pretty: false, verbose: false };

  test("NotFound -> exit 1, json error payload on stderr", () => {
    expect(() => fail(new FilesError("NotFound", "nope"), out)).toThrow(
      "__exit:1"
    );
    expect(cap.exits).toEqual([1]);
    const payload = JSON.parse(cap.stderr.join(""));
    expect(payload).toEqual({ error: { code: "NotFound", message: "nope" } });
  });

  test("Unauthorized -> exit 3", () => {
    expect(() => fail(new FilesError("Unauthorized", "u"), out)).toThrow(
      "__exit:3"
    );
    expect(cap.exits).toEqual([3]);
  });

  test("Conflict -> exit 4", () => {
    expect(() => fail(new FilesError("Conflict", "c"), out)).toThrow(
      "__exit:4"
    );
    expect(cap.exits).toEqual([4]);
  });

  test("Provider / unknown -> exit 2", () => {
    expect(() => fail(new FilesError("Provider", "p"), out)).toThrow(
      "__exit:2"
    );
    expect(cap.exits).toEqual([2]);
  });

  test("plain Error (non-FilesError) reports code=Provider, exits 2", () => {
    expect(() => fail(new Error("boom"), out)).toThrow("__exit:2");
    const payload = JSON.parse(cap.stderr.join(""));
    expect(payload.error).toEqual({ code: "Provider", message: "boom" });
  });

  test("non-Error thrown value is stringified", () => {
    expect(() => fail("scalar", out)).toThrow("__exit:2");
    const payload = JSON.parse(cap.stderr.join(""));
    expect(payload.error.message).toBe("scalar");
  });

  test("non-json mode writes 'error (CODE): message' to stderr", () => {
    expect(() =>
      fail(new FilesError("NotFound", "missing key"), {
        json: false,
        pretty: false,
        verbose: false,
      })
    ).toThrow("__exit:1");
    expect(cap.stderr.join("")).toBe("error (NotFound): missing key\n");
  });

  test("verbose adds stack in both json and non-json modes", () => {
    const err = new FilesError("Provider", "stacky");
    expect(() =>
      fail(err, { json: true, pretty: false, verbose: true })
    ).toThrow("__exit:2");
    const payload = JSON.parse(cap.stderr.join(""));
    expect(typeof payload.error.stack).toBe("string");
    expect(payload.error.stack.length).toBeGreaterThan(0);

    cap.stderr.length = 0;
    expect(() =>
      fail(err, { json: false, pretty: false, verbose: true })
    ).toThrow("__exit:2");
    const text = cap.stderr.join("");
    expect(text.startsWith("error (Provider): stacky\n")).toBe(true);
    expect(text.includes("FilesError")).toBe(true);
  });
});

describe("cli/io readBody", () => {
  const tmpDirs: string[] = [];
  const makeTmpFile = async (contents: string): Promise<string> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-cli-io-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "body.bin");
    await fsp.writeFile(file, contents);
    return file;
  };
  afterEach(async () => {
    await Promise.all(
      tmpDirs.splice(0).map((d) => fsp.rm(d, { force: true, recursive: true }))
    );
  });

  test("from --file: returns a web stream sized from stat()", async () => {
    const file = await makeTmpFile("hello world");
    const { body, hint, size } = await readBody({ file });
    expect(hint).toBe(file);
    expect(size).toBe("hello world".length);
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- sequentially draining a stream reader
      const r = await reader.read();
      if (r.done) {
        break;
      }
      if (r.value) {
        chunks.push(r.value);
      }
    }
    const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    expect(new TextDecoder().decode(buf)).toBe("hello world");
  });

  test("from --stdin: hint=<stdin>, size=-1 (unknown)", async () => {
    // readBody doesn't drain stdin — it just wraps it. Safe to call.
    const { hint, size } = await readBody({ stdin: true });
    expect(hint).toBe("<stdin>");
    expect(size).toBe(-1);
  });

  test("with neither stdin nor file: throws FilesError(Provider)", async () => {
    await expect(readBody({})).rejects.toBeInstanceOf(FilesError);
  });
});

const makeStoredFile = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return createStoredFile(
    {
      etag: '"x"',
      key: "k",
      lastModified: 0,
      size: bytes.byteLength,
      type: "text/plain",
    },
    { data: bytes, kind: "buffer" }
  );
};

describe("cli/io writeBody", () => {
  const tmpDirs: string[] = [];
  const makeTmpDir = async (): Promise<string> => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-cli-io-"));
    tmpDirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(
      tmpDirs.splice(0).map((d) => fsp.rm(d, { force: true, recursive: true }))
    );
  });

  test("--out writes the body to disk", async () => {
    const dir = await makeTmpDir();
    const out = path.join(dir, "got.bin");
    await writeBody(makeStoredFile("payload"), { out });
    expect(await fsp.readFile(out, "utf-8")).toBe("payload");
  });

  test("--stdout pipes the body to process.stdout", async () => {
    // pipe stdout into a buffer by replacing the underlying socket write
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout) as WriteFn;
    (process.stdout as { write: WriteFn }).write = ((chunk: unknown) => {
      chunks.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString("utf-8")
      );
      return true;
    }) as WriteFn;
    try {
      await writeBody(makeStoredFile("piped"), { stdout: true });
    } finally {
      (process.stdout as { write: WriteFn }).write = origWrite;
    }
    expect(chunks.join("")).toContain("piped");
  });

  test("with neither out nor stdout: throws FilesError", async () => {
    await expect(writeBody(makeStoredFile("x"), {})).rejects.toBeInstanceOf(
      FilesError
    );
  });
});

describe("cli/io storedFileToJson", () => {
  test("projects only the public metadata fields", () => {
    const file = createStoredFile(
      {
        etag: '"abc"',
        key: "k/x",
        lastModified: 123,
        metadata: { a: "1" },
        size: 9,
        type: "text/plain",
      },
      { data: new Uint8Array(9), kind: "buffer" }
    );
    expect(storedFileToJson(file)).toEqual({
      etag: '"abc"',
      key: "k/x",
      lastModified: 123,
      metadata: { a: "1" },
      name: file.name,
      size: 9,
      type: "text/plain",
    });
  });
});
