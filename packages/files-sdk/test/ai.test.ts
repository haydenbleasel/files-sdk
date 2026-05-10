import { describe, expect, test } from "bun:test";

import type { ToolExecutionOptions } from "ai";

import { createFileTools } from "../src/ai/index.js";
import { Files, FilesError } from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

// `Tool<INPUT, OUTPUT>` is invariant in INPUT (INPUT appears in
// `needsApproval`'s function position), so a single nominal alias can't
// accept the differently-shaped tools returned by `createFileTools`. The
// tests only poke at `execute` / `needsApproval` / etc., so we view each
// tool through this minimal structural shape.
interface AnyTool {
  execute?: (
    input: Record<string, unknown>,
    options: ToolExecutionOptions
  ) => Promise<unknown> | unknown;
  needsApproval?: unknown;
  description?: unknown;
  title?: unknown;
  inputSchema?: unknown;
}

const stubExecOptions = (): ToolExecutionOptions => ({
  messages: [],
  toolCallId: "test-call",
});

const exec = async (
  t: unknown,
  input: Record<string, unknown>
): Promise<unknown> => {
  const candidate = t as AnyTool | undefined;
  if (!candidate) {
    throw new Error("tool was not present in the returned set");
  }
  if (typeof candidate.execute !== "function") {
    throw new TypeError("tool has no execute function");
  }
  return await candidate.execute(input, stubExecOptions());
};

const newFiles = () => new Files({ adapter: fakeAdapter() });

describe("createFileTools", () => {
  test("returns all eight tools by default", () => {
    const tools = createFileTools({ files: newFiles() });
    expect(Object.keys(tools).toSorted()).toEqual(
      [
        "copyFile",
        "deleteFile",
        "downloadFile",
        "getFileMetadata",
        "getFileUrl",
        "listFiles",
        "signUploadUrl",
        "uploadFile",
      ].toSorted()
    );
  });

  test("readOnly: true strips every write tool", () => {
    const tools = createFileTools({ files: newFiles(), readOnly: true });
    expect(Object.keys(tools).toSorted()).toEqual(
      ["downloadFile", "getFileMetadata", "getFileUrl", "listFiles"].toSorted()
    );
    expect("uploadFile" in tools).toBe(false);
    expect("deleteFile" in tools).toBe(false);
    expect("copyFile" in tools).toBe(false);
    expect("signUploadUrl" in tools).toBe(false);
  });

  test("write tools default to needsApproval=true; reads do not set it", () => {
    const tools = createFileTools({ files: newFiles() });
    expect((tools.uploadFile as AnyTool).needsApproval).toBe(true);
    expect((tools.deleteFile as AnyTool).needsApproval).toBe(true);
    expect((tools.copyFile as AnyTool).needsApproval).toBe(true);
    expect((tools.signUploadUrl as AnyTool).needsApproval).toBe(true);
    expect((tools.listFiles as AnyTool).needsApproval).toBeUndefined();
    expect((tools.downloadFile as AnyTool).needsApproval).toBeUndefined();
  });

  test("requireApproval: false clears needsApproval on every write tool", () => {
    const tools = createFileTools({
      files: newFiles(),
      requireApproval: false,
    });
    expect((tools.uploadFile as AnyTool).needsApproval).toBe(false);
    expect((tools.deleteFile as AnyTool).needsApproval).toBe(false);
    expect((tools.copyFile as AnyTool).needsApproval).toBe(false);
    expect((tools.signUploadUrl as AnyTool).needsApproval).toBe(false);
  });

  test("requireApproval object resolves per-tool with default true for unspecified writes", () => {
    const tools = createFileTools({
      files: newFiles(),
      requireApproval: {
        deleteFile: true,
        uploadFile: false,
      },
    });
    expect((tools.uploadFile as AnyTool).needsApproval).toBe(false);
    expect((tools.deleteFile as AnyTool).needsApproval).toBe(true);
    expect((tools.copyFile as AnyTool).needsApproval).toBe(true);
    expect((tools.signUploadUrl as AnyTool).needsApproval).toBe(true);
  });

  test("overrides patch tool fields without dropping required props", () => {
    const tools = createFileTools({
      files: newFiles(),
      overrides: {
        deleteFile: { needsApproval: false, title: "Remove file" },
        downloadFile: { description: "Custom description" },
      },
    });
    expect((tools.downloadFile as AnyTool).description).toBe(
      "Custom description"
    );
    expect((tools.downloadFile as AnyTool).inputSchema).toBeDefined();
    expect((tools.downloadFile as AnyTool).execute).toBeInstanceOf(Function);
    expect((tools.deleteFile as AnyTool).needsApproval).toBe(false);
    expect((tools.deleteFile as AnyTool).title).toBe("Remove file");
  });

  test("overrides for unknown tool names are ignored", () => {
    const tools = createFileTools({
      files: newFiles(),
      overrides: { notATool: { description: "noop" } },
    });
    expect("notATool" in tools).toBe(false);
  });

  test("uploadFile + listFiles + getFileMetadata round-trip via the fake adapter", async () => {
    const files = newFiles();
    const tools = createFileTools({ files });

    const upload = (await exec(tools.uploadFile, {
      content: "hello world",
      contentType: "text/plain",
      key: "report.txt",
      metadata: { tenant: "acme" },
    })) as { key: string; size: number; contentType: string; etag?: string };
    expect(upload.key).toBe("report.txt");
    expect(upload.size).toBe("hello world".length);
    expect(upload.contentType).toBe("text/plain");
    expect(upload.etag).toBeTruthy();

    const list = (await exec(tools.listFiles, {})) as {
      items: { key: string; size: number }[];
      cursor?: string;
    };
    expect(list.items.map((i) => i.key)).toEqual(["report.txt"]);
    expect(list.items[0]?.size).toBe("hello world".length);

    const meta = (await exec(tools.getFileMetadata, {
      key: "report.txt",
    })) as { metadata?: Record<string, string>; size: number };
    expect(meta.metadata).toEqual({ tenant: "acme" });
    expect(meta.size).toBe("hello world".length);
  });

  test("downloadFile returns UTF-8 text by default", async () => {
    const files = newFiles();
    const tools = createFileTools({ files });
    await exec(tools.uploadFile, { content: "hello", key: "a.txt" });

    const result = (await exec(tools.downloadFile, { key: "a.txt" })) as {
      content: string;
      encoding: "text" | "base64";
      size: number;
    };
    expect(result.encoding).toBe("text");
    expect(result.content).toBe("hello");
    expect(result.size).toBe(5);
  });

  test("downloadFile with binary=true returns base64 bytes that round-trip", async () => {
    const files = newFiles();
    const tools = createFileTools({ files });

    const raw = new Uint8Array([0, 1, 2, 254, 255]);
    await files.upload("blob.bin", raw);

    const result = (await exec(tools.downloadFile, {
      binary: true,
      key: "blob.bin",
    })) as { content: string; encoding: "text" | "base64" };
    expect(result.encoding).toBe("base64");
    const decoded = Uint8Array.from(
      atob(result.content),
      (c) => c.codePointAt(0) ?? 0
    );
    expect([...decoded]).toEqual([...raw]);
  });

  test("downloadFile rejects when size exceeds maxBytes before transfer", async () => {
    const files = newFiles();
    const tools = createFileTools({ files });
    await exec(tools.uploadFile, { content: "abcdefghij", key: "big.txt" });

    try {
      await exec(tools.downloadFile, { key: "big.txt", maxBytes: 4 });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).message).toMatch(/maxBytes/u);
    }
  });

  test("uploadFile with encoding=base64 decodes binary content", async () => {
    const files = newFiles();
    const tools = createFileTools({ files });

    const raw = new Uint8Array([10, 20, 30, 40, 50]);
    let binary = "";
    for (const b of raw) {
      binary += String.fromCodePoint(b);
    }
    const base64 = btoa(binary);

    await exec(tools.uploadFile, {
      content: base64,
      contentType: "application/octet-stream",
      encoding: "base64",
      key: "binary.dat",
    });

    const stored = await files.download("binary.dat");
    const buf = await stored.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(raw);
  });

  test("copyFile and deleteFile mutate the bucket", async () => {
    const files = newFiles();
    const tools = createFileTools({ files });
    await exec(tools.uploadFile, { content: "payload", key: "src.txt" });

    const copyResult = (await exec(tools.copyFile, {
      from: "src.txt",
      to: "dst.txt",
    })) as { copied: boolean; from: string; to: string };
    expect(copyResult).toEqual({
      copied: true,
      from: "src.txt",
      to: "dst.txt",
    });
    const dstFile = await files.download("dst.txt");
    expect(await dstFile.text()).toBe("payload");

    const deleteResult = (await exec(tools.deleteFile, {
      key: "src.txt",
    })) as { deleted: boolean; key: string };
    expect(deleteResult).toEqual({ deleted: true, key: "src.txt" });

    try {
      await files.download("src.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("getFileUrl forwards expiresIn to the adapter", async () => {
    const files = newFiles();
    const tools = createFileTools({ files });
    await exec(tools.uploadFile, { content: "x", key: "u.txt" });

    const result = (await exec(tools.getFileUrl, {
      expiresIn: 60,
      key: "u.txt",
    })) as { key: string; url: string };
    expect(result.key).toBe("u.txt");
    expect(result.url).toContain("expires=60");
  });

  test("signUploadUrl returns a SignedUpload descriptor", async () => {
    const files = newFiles();
    const tools = createFileTools({ files });

    const result = (await exec(tools.signUploadUrl, {
      expiresIn: 120,
      key: "upload.bin",
    })) as { method: string; url: string };
    expect(result.method).toBe("PUT");
    expect(result.url).toMatch(/^https:\/\/fake\.local/u);
  });
});
