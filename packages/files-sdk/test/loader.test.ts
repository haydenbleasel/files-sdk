import { afterAll, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { Files } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";
import { loadFiles } from "../src/loader/index.js";
import type { LoadFilesOptions, LoadFilesResult } from "../src/loader/index.js";

// Behavior is covered in depth by cli-loader.test.ts against the underlying
// implementation; this suite pins the public `files-sdk/loader` surface — the
// wrapper resolves at the source level and its type aliases stay assignable.

const tmpDirs: string[] = [];
const makeRoot = async (): Promise<string> => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-loader-"));
  tmpDirs.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(
    tmpDirs.map((d) => fsp.rm(d, { force: true, recursive: true }))
  );
});

describe("loader loadFiles (public subpath)", () => {
  test("constructs a working Files instance via the fs provider", async () => {
    const root = await makeRoot();
    const options: LoadFilesOptions = { provider: "fs", root };
    const result: LoadFilesResult = await loadFiles(options);
    expect(result.provider).toBe("fs");
    expect(result.files).toBeInstanceOf(Files);

    await result.files.upload("hello.txt", "hi", { contentType: "text/plain" });
    const contents = await fsp.readFile(path.join(root, "hello.txt"), "utf-8");
    expect(contents).toBe("hi");
  });

  test("rejects unknown providers with FilesError", async () => {
    await expect(loadFiles({ provider: "nope" })).rejects.toBeInstanceOf(
      FilesError
    );
  });
});
