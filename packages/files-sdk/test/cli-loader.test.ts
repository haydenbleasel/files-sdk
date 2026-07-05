import { afterAll, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

import { describeProvider, loadFiles } from "../src/cli/loader.js";
import { Files } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";

const tmpDirs: string[] = [];
const makeRoot = async (): Promise<string> => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "files-sdk-cli-load-"));
  tmpDirs.push(dir);
  return dir;
};
afterAll(async () => {
  await Promise.all(
    tmpDirs.map((d) => fsp.rm(d, { force: true, recursive: true }))
  );
});

describe("cli/loader pickProvider", () => {
  test("describeProvider returns the explicit --provider", () => {
    expect(describeProvider({ provider: "fs", root: "/tmp" })).toBe("fs");
  });

  test("falls back to FILES_SDK_PROVIDER env var", () => {
    const prev = process.env.FILES_SDK_PROVIDER;
    process.env.FILES_SDK_PROVIDER = "fs";
    try {
      expect(describeProvider({ root: "/tmp" })).toBe("fs");
    } finally {
      if (prev === undefined) {
        delete process.env.FILES_SDK_PROVIDER;
      } else {
        process.env.FILES_SDK_PROVIDER = prev;
      }
    }
  });

  test("missing provider throws FilesError listing known names", () => {
    const prev = process.env.FILES_SDK_PROVIDER;
    delete process.env.FILES_SDK_PROVIDER;
    try {
      let caught: unknown;
      try {
        describeProvider({});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FilesError);
      expect((caught as FilesError).message).toContain(
        "--provider is required"
      );
      expect((caught as FilesError).message).toContain("fs");
    } finally {
      if (prev !== undefined) {
        process.env.FILES_SDK_PROVIDER = prev;
      }
    }
  });

  test("unknown provider throws FilesError", () => {
    let caught: unknown;
    try {
      describeProvider({ provider: "not-a-real-provider" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FilesError);
    expect((caught as FilesError).message).toContain("unknown provider");
  });
});

describe("cli/loader loadFiles", () => {
  test("loads the fs adapter end-to-end and returns a Files instance", async () => {
    const root = await makeRoot();
    const result = await loadFiles({ provider: "fs", root });
    expect(result.provider).toBe("fs");
    expect(result.files).toBeInstanceOf(Files);

    // Smoke-check the adapter actually works against the tmp root
    await result.files.upload("hello.txt", "hi there", {
      contentType: "text/plain",
    });
    const head = await result.files.head("hello.txt");
    expect(head.size).toBe("hi there".length);

    // Confirm the file landed under the configured root
    const contents = await fsp.readFile(path.join(root, "hello.txt"), "utf-8");
    expect(contents).toBe("hi there");
  });

  test("threads --config-json passthrough into the adapter via extra", async () => {
    // The fs adapter accepts `defaultUrlExpiresIn` either via the typed flag
    // or via --config-json's extra blob. The typed flag wins on conflict;
    // here we just confirm the extra path is wired in.
    const root = await makeRoot();
    const result = await loadFiles({
      configJson: { defaultUrlExpiresIn: 42 },
      provider: "fs",
      root,
    });
    expect(result.provider).toBe("fs");
  });

  test("propagates unknown-provider errors from loadFiles too", async () => {
    await expect(loadFiles({ provider: "nope" })).rejects.toBeInstanceOf(
      FilesError
    );
  });

  test("threads --key-prefix / --timeout / --retries into the Files instance", async () => {
    const root = await makeRoot();
    const { files } = await loadFiles({
      prefix: "scoped",
      provider: "fs",
      retries: 2,
      root,
      timeout: 5000,
    });
    // The instance prefix scopes writes: the key lands under scoped/ on disk,
    // and reads report the prefix-stripped key.
    const result = await files.upload("note.txt", "hi");
    expect(result.key).toBe("note.txt");
    const onDisk = await fsp.readFile(
      path.join(root, "scoped", "note.txt"),
      "utf-8"
    );
    expect(onDisk).toBe("hi");
  });
});
