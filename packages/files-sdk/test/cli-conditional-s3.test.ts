import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import { runUpload } from "../src/cli/commands.js";
import type { CommonRunOpts } from "../src/cli/commands.js";

// The CLI always reads its body as a stream, and the S3 adapter — the only
// one with native conditional primitives — rejects stream bodies for a
// conditional PutObject. This drives `upload --if-none-match` end to end
// through a mocked S3Client to prove the CLI buffers the body first.

const s3Mock = mockClient(S3Client);

type WriteFn = typeof process.stdout.write;
const origOut = process.stdout.write.bind(process.stdout) as WriteFn;
const stdout: string[] = [];

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-cli-cas-"));
  stdout.length = 0;
  s3Mock.reset();
  (process.stdout as { write: WriteFn }).write = ((chunk: unknown) => {
    stdout.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk as Uint8Array).toString("utf-8")
    );
    return true;
  }) as WriteFn;
});

afterEach(async () => {
  (process.stdout as { write: WriteFn }).write = origOut;
  await fsp.rm(root, { force: true, recursive: true });
});

afterAll(() => {
  s3Mock.restore();
});

const baseOpts = (): CommonRunOpts => ({
  dryRun: false,
  global: {
    accessKeyId: "AKIA",
    bucket: "b",
    provider: "s3",
    region: "us-east-1",
    secretAccessKey: "secret",
  },
  json: true,
  pretty: false,
  verbose: false,
});

describe("cli upload with a condition against s3", () => {
  test("--if-none-match buffers the file body so the conditional PutObject has a length", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"created"' });
    const local = path.join(root, "config.json");
    await fsp.writeFile(local, '{"ok":true}');

    await runUpload({
      ...baseOpts(),
      file: local,
      ifNoneMatch: true,
      key: "k",
    });

    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const [{ input }] = (calls[0] as NonNullable<(typeof calls)[0]>).args;
    expect(input.IfNoneMatch).toBe("*");
    expect(input.ContentLength).toBe('{"ok":true}'.length);
    expect(input.Body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(input.Body as Uint8Array).toString()).toBe(
      '{"ok":true}'
    );
    const emitted = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "");
    expect(emitted).toMatchObject({ etag: "created", key: "k" });
  });

  test("--if-match sends If-Match with the quoted ETag", async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"next"' });
    const local = path.join(root, "config.json");
    await fsp.writeFile(local, "v2");

    await runUpload({ ...baseOpts(), file: local, ifMatch: "prev", key: "k" });

    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const [{ input }] = (calls[0] as NonNullable<(typeof calls)[0]>).args;
    expect(input.IfMatch).toBe('"prev"');
    expect(input.ContentLength).toBe(2);
  });
});
