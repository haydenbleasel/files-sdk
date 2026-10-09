// `files events parse` — the command and its commander wiring.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { runEventsParse } from "../src/cli/commands.js";
import { buildProgram } from "../src/cli/program.js";

const FIXTURES = path.join(import.meta.dir, "fixtures", "events");

type WriteFn = typeof process.stdout.write;

let stdout: string[] = [];
let stderr: string[] = [];
let restore: () => void = () => {};

beforeEach(() => {
  stdout = [];
  stderr = [];
  const origOut = process.stdout.write.bind(process.stdout) as WriteFn;
  const origErr = process.stderr.write.bind(process.stderr) as WriteFn;
  const origExitCode = process.exitCode;
  (process.stdout as { write: WriteFn }).write = ((chunk: string) => {
    stdout.push(String(chunk));
    return true;
  }) as WriteFn;
  (process.stderr as { write: WriteFn }).write = ((chunk: string) => {
    stderr.push(String(chunk));
    return true;
  }) as WriteFn;
  restore = () => {
    (process.stdout as { write: WriteFn }).write = origOut;
    (process.stderr as { write: WriteFn }).write = origErr;
    process.exitCode = origExitCode ?? 0;
  };
});

afterEach(() => restore());

const printed = (): { key: string; type: string; source: string }[] =>
  JSON.parse(stdout.join("").trim()) as {
    key: string;
    type: string;
    source: string;
  }[];

describe("files events parse", () => {
  test("--format reads a delivery with no provider configured", async () => {
    await runEventsParse({
      dryRun: false,
      file: path.join(FIXTURES, "s3/sqs-body.json"),
      format: "s3",
      global: {},
      json: true,
      pretty: false,
      verbose: false,
    });
    expect(printed()).toMatchObject([
      { key: "test.pdf", source: "provider", type: "created" },
    ]);
  });

  test("--key-prefix maps keys the way the instance would", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "files-events-"));
    const file = path.join(dir, "delivery.json");
    await fsp.writeFile(
      file,
      JSON.stringify({
        account: "a",
        action: "PutObject",
        bucket: "b",
        object: { key: "tenant/a.txt", size: 1 },
      })
    );
    await runEventsParse({
      dryRun: false,
      file,
      format: "r2",
      global: { prefix: "tenant" },
      json: true,
      pretty: false,
      verbose: false,
    });
    expect(printed().map((e) => e.key)).toEqual(["a.txt"]);
    await fsp.rm(dir, { force: true, recursive: true });
  });

  test("without --format, the configured provider picks the format", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "files-events-"));
    // The fs adapter has no notification format to read.
    await expect(
      runEventsParse({
        dryRun: false,
        file: path.join(FIXTURES, "s3/lambda-put.json"),
        global: { provider: "fs", root },
        json: true,
        pretty: false,
        verbose: false,
      })
    ).rejects.toThrow("the fs adapter has no notification format");
    await fsp.rm(root, { force: true, recursive: true });
  });

  test("an S3-compatible provider reads S3 deliveries", async () => {
    await runEventsParse({
      dryRun: false,
      file: path.join(FIXTURES, "s3/minio-webhook-put.json"),
      global: {
        accessKeyId: "k",
        bucket: "test-bucket",
        endpoint: "http://127.0.0.1:9000",
        provider: "minio",
        secretAccessKey: "s",
      },
      json: true,
      pretty: false,
      verbose: false,
    });
    expect(printed()).toMatchObject([{ key: "image.jpg", type: "created" }]);
    expect(stderr.join("")).toBe("");
  });

  test("is wired into the program", async () => {
    await buildProgram().parseAsync([
      "bun",
      "files",
      "events",
      "parse",
      path.join(FIXTURES, "gcs/pubsub-pull-finalize.json"),
      "--format",
      "gcs",
    ]);
    expect(printed()).toMatchObject([
      { key: "folder/Test.cs", type: "created" },
    ]);
  });
});
