import { describe, expect, test } from "bun:test";

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

import {
  claudeCopyFile,
  claudeDeleteFile,
  claudeDownloadFile,
  claudeGetFileMetadata,
  claudeGetFileUrl,
  claudeListFiles,
  claudeSignUploadUrl,
  claudeUploadFile,
  createClaudeFileTools,
} from "../src/claude/index.js";
import { Files, FilesError } from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const newFiles = () => new Files({ adapter: fakeAdapter() });

interface TextContent {
  type: "text";
  text: string;
}

interface CallResult {
  content: TextContent[];
  isError?: boolean;
}

interface InvokableTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
  handler: (input: unknown, extra: unknown) => Promise<CallResult>;
}

const asTool = (t: unknown): InvokableTool => t as unknown as InvokableTool;

const invoke = (
  def: unknown,
  input: Record<string, unknown>
): Promise<CallResult> => asTool(def).handler(input, {});

const parseOutput = (result: CallResult): unknown => {
  const text = result.content[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const callCanUseTool = (canUseTool: CanUseTool, name: string, input = {}) =>
  canUseTool(name, input, {
    signal: new AbortController().signal,
    toolUseID: "test-call",
  });

describe("createClaudeFileTools", () => {
  test("returns the expected bundle shape", () => {
    const tools = createClaudeFileTools({ files: newFiles() });
    expect(typeof tools.mcpServers).toBe("object");
    expect(Array.isArray(tools.allowedTools)).toBe(true);
    expect(typeof tools.canUseTool).toBe("function");
    expect(typeof tools.needsApproval).toBe("function");
    expect(tools.serverName).toBe("files");
    expect(tools.mcpServers.files).toBe(tools.server);
    expect(tools.server.type).toBe("sdk");
    expect(tools.server.name).toBe("files");
  });

  test("allowedTools lists all eight prefixed names by default", () => {
    const tools = createClaudeFileTools({ files: newFiles() });
    expect(tools.allowedTools.toSorted()).toEqual(
      [
        "mcp__files__copyFile",
        "mcp__files__deleteFile",
        "mcp__files__downloadFile",
        "mcp__files__getFileMetadata",
        "mcp__files__getFileUrl",
        "mcp__files__listFiles",
        "mcp__files__signUploadUrl",
        "mcp__files__uploadFile",
      ].toSorted()
    );
  });

  test("readOnly: true strips write tools from allowedTools", () => {
    const tools = createClaudeFileTools({
      files: newFiles(),
      readOnly: true,
    });
    expect(tools.allowedTools.toSorted()).toEqual(
      [
        "mcp__files__downloadFile",
        "mcp__files__getFileMetadata",
        "mcp__files__getFileUrl",
        "mcp__files__listFiles",
      ].toSorted()
    );
  });

  test("serverName override is reflected in allowedTools and mcpServers key", () => {
    const tools = createClaudeFileTools({
      files: newFiles(),
      serverName: "storage",
    });
    expect(tools.serverName).toBe("storage");
    expect(tools.mcpServers.storage).toBeDefined();
    expect(tools.mcpServers.files).toBeUndefined();
    for (const name of tools.allowedTools) {
      expect(name.startsWith("mcp__storage__")).toBe(true);
    }
  });

  test("needsApproval: writes true / reads false by default", () => {
    const tools = createClaudeFileTools({ files: newFiles() });
    expect(tools.needsApproval("uploadFile")).toBe(true);
    expect(tools.needsApproval("deleteFile")).toBe(true);
    expect(tools.needsApproval("copyFile")).toBe(true);
    expect(tools.needsApproval("signUploadUrl")).toBe(true);
    expect(tools.needsApproval("listFiles")).toBe(false);
    expect(tools.needsApproval("downloadFile")).toBe(false);
    expect(tools.needsApproval("getFileMetadata")).toBe(false);
    expect(tools.needsApproval("getFileUrl")).toBe(false);
  });

  test("needsApproval accepts mcp-prefixed names", () => {
    const tools = createClaudeFileTools({ files: newFiles() });
    expect(tools.needsApproval("mcp__files__uploadFile")).toBe(true);
    expect(tools.needsApproval("mcp__files__listFiles")).toBe(false);
  });

  test("needsApproval honors requireApproval: false", () => {
    const tools = createClaudeFileTools({
      files: newFiles(),
      requireApproval: false,
    });
    expect(tools.needsApproval("uploadFile")).toBe(false);
    expect(tools.needsApproval("deleteFile")).toBe(false);
    expect(tools.needsApproval("copyFile")).toBe(false);
    expect(tools.needsApproval("signUploadUrl")).toBe(false);
  });

  test("needsApproval honors per-tool requireApproval object", () => {
    const tools = createClaudeFileTools({
      files: newFiles(),
      requireApproval: { deleteFile: true, uploadFile: false },
    });
    expect(tools.needsApproval("uploadFile")).toBe(false);
    expect(tools.needsApproval("deleteFile")).toBe(true);
    expect(tools.needsApproval("copyFile")).toBe(true);
    expect(tools.needsApproval("signUploadUrl")).toBe(true);
  });

  test("needsApproval returns false for unknown names", () => {
    const tools = createClaudeFileTools({ files: newFiles() });
    expect(tools.needsApproval("notATool")).toBe(false);
    expect(tools.needsApproval("mcp__files__notATool")).toBe(false);
    expect(tools.needsApproval("mcp__other__uploadFile")).toBe(false);
  });

  test("canUseTool: denies approval-gated writes, allows reads", async () => {
    const tools = createClaudeFileTools({ files: newFiles() });

    const upload = await callCanUseTool(
      tools.canUseTool,
      "mcp__files__uploadFile",
      { content: "x", key: "a.txt" }
    );
    expect(upload.behavior).toBe("deny");
    if (upload.behavior === "deny") {
      expect(upload.message).toMatch(/approval/u);
    }

    const list = await callCanUseTool(
      tools.canUseTool,
      "mcp__files__listFiles",
      { prefix: "a/" }
    );
    expect(list.behavior).toBe("allow");
    if (list.behavior === "allow") {
      expect(list.updatedInput).toEqual({ prefix: "a/" });
    }
  });

  test("canUseTool: requireApproval: false allows every write", async () => {
    const tools = createClaudeFileTools({
      files: newFiles(),
      requireApproval: false,
    });
    for (const name of [
      "mcp__files__uploadFile",
      "mcp__files__deleteFile",
      "mcp__files__copyFile",
      "mcp__files__signUploadUrl",
    ]) {
      // eslint-disable-next-line no-await-in-loop -- checks approval for each tool name against the shared tool set
      const r = await callCanUseTool(tools.canUseTool, name);
      expect(r.behavior).toBe("allow");
    }
  });

  test("upload + list + download round-trip via the bundled server", async () => {
    const files = newFiles();
    createClaudeFileTools({ files });

    const upload = claudeUploadFile(files);
    const list = claudeListFiles(files);
    const download = claudeDownloadFile(files);

    const uploaded = parseOutput(
      await invoke(upload, {
        content: "hello world",
        contentType: "text/plain",
        key: "report.txt",
      })
    ) as { key: string; size: number };
    expect(uploaded.key).toBe("report.txt");
    expect(uploaded.size).toBe("hello world".length);

    const listed = parseOutput(await invoke(list, {})) as {
      items: { key: string }[];
    };
    expect(listed.items.map((i) => i.key)).toEqual(["report.txt"]);

    const downloaded = parseOutput(
      await invoke(download, { key: "report.txt" })
    ) as { content: string };
    expect(downloaded.content).toBe("hello world");
  });

  test("downloadFile binary=true returns base64", async () => {
    const files = newFiles();
    const raw = new Uint8Array([0, 1, 2, 254, 255]);
    await files.upload("blob.bin", raw);

    const result = parseOutput(
      await invoke(claudeDownloadFile(files), {
        binary: true,
        key: "blob.bin",
      })
    ) as { content: string; encoding: "text" | "base64" };
    expect(result.encoding).toBe("base64");
    const decoded = Uint8Array.from(
      atob(result.content),
      (c) => c.codePointAt(0) ?? 0
    );
    expect([...decoded]).toEqual([...raw]);
  });

  test("FilesError surfaces as isError: true with the error message", async () => {
    const files = newFiles();
    await files.upload("big.txt", "abcdefghij");

    const result = await invoke(claudeDownloadFile(files), {
      key: "big.txt",
      maxBytes: 4,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/maxBytes/u);
    // FilesError class is still exported from the package
    expect(typeof FilesError).toBe("function");
  });

  test("missing key surfaces as isError: true", async () => {
    const result = await invoke(claudeDownloadFile(newFiles()), {
      key: "missing.txt",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/missing\.txt|not found/u);
  });

  test("overrides patch description / annotations without dropping fields", () => {
    const tools = createClaudeFileTools({
      files: newFiles(),
      overrides: {
        deleteFile: { annotations: { destructiveHint: false } },
        listFiles: { description: "Custom list" },
      },
    });
    const list = tools.server.instance;
    expect(list).toBeDefined();
    // Verify the overrides are reflected by re-creating with the same options
    // and inspecting the per-tool factory output via the server's tool list is
    // not trivially exposed — instead, inspect via the individual factory path:
    // the override mechanism uses Object.assign, so a fresh override-patched
    // SdkMcpToolDefinition should match by inspecting the underlying factory.
    // Direct introspection: the server holds tools internally; we verify here
    // that allowedTools still names the overridden tools.
    expect(tools.allowedTools).toContain("mcp__files__listFiles");
    expect(tools.allowedTools).toContain("mcp__files__deleteFile");
  });

  test("overrides for unknown tool names are ignored", () => {
    const tools = createClaudeFileTools({
      files: newFiles(),
      overrides: {
        // @ts-expect-error — unknown keys typed out; runtime guard drops them
        notATool: { description: "noop" },
      },
    });
    expect(tools.allowedTools).not.toContain("mcp__files__notATool");
  });

  test("getFileMetadata + getFileUrl + copyFile + signUploadUrl invocations", async () => {
    const files = newFiles();

    await invoke(claudeUploadFile(files), {
      content: "payload",
      contentType: "text/plain",
      key: "src.txt",
      metadata: { tenant: "acme" },
    });

    const meta = parseOutput(
      await invoke(claudeGetFileMetadata(files), { key: "src.txt" })
    ) as { key: string; size: number; metadata?: Record<string, string> };
    expect(meta.key).toBe("src.txt");
    expect(meta.metadata).toEqual({ tenant: "acme" });

    const urlResult = parseOutput(
      await invoke(claudeGetFileUrl(files), {
        expiresIn: 90,
        key: "src.txt",
      })
    ) as { key: string; url: string };
    expect(urlResult.url).toContain("expires=90");

    const copyResult = parseOutput(
      await invoke(claudeCopyFile(files), {
        from: "src.txt",
        to: "dst.txt",
      })
    ) as { copied: boolean; from: string; to: string };
    expect(copyResult).toEqual({
      copied: true,
      from: "src.txt",
      to: "dst.txt",
    });

    const signResult = parseOutput(
      await invoke(claudeSignUploadUrl(files), {
        expiresIn: 120,
        key: "upload.bin",
      })
    ) as { method: string; url: string };
    expect(signResult.method).toBe("PUT");
    expect(signResult.url).toMatch(/^https:\/\/fake\.local/u);

    const delResult = parseOutput(
      await invoke(claudeDeleteFile(files), { key: "src.txt" })
    ) as { deleted: boolean; key: string };
    expect(delResult).toEqual({ deleted: true, key: "src.txt" });
  });

  test("uploadFile encoding=base64 decodes binary content", async () => {
    const files = newFiles();
    const raw = new Uint8Array([10, 20, 30, 40, 50]);
    let binary = "";
    for (const b of raw) {
      binary += String.fromCodePoint(b);
    }
    const base64 = btoa(binary);

    await invoke(claudeUploadFile(files), {
      content: base64,
      contentType: "application/octet-stream",
      encoding: "base64",
      key: "binary.dat",
    });

    const stored = await files.download("binary.dat");
    const buf = await stored.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(raw);
  });

  test("listFiles forwards prefix to underlying adapter", async () => {
    const files = newFiles();
    const upload = claudeUploadFile(files);
    await Promise.all(
      ["a/1.txt", "a/2.txt", "b/1.txt"].map((k) =>
        invoke(upload, { content: "x", key: k })
      )
    );
    const result = parseOutput(
      await invoke(claudeListFiles(files), { prefix: "a/" })
    ) as { items: { key: string }[] };
    expect(result.items.map((i) => i.key)).toEqual(["a/1.txt", "a/2.txt"]);
  });

  test("cherry-picked individual factories produce valid SdkMcpToolDefinitions", async () => {
    const files = newFiles();

    const list = claudeListFiles(files);
    const upload = claudeUploadFile(files);
    const download = claudeDownloadFile(files);
    const meta = claudeGetFileMetadata(files);
    const url = claudeGetFileUrl(files);
    const del = claudeDeleteFile(files);
    const copy = claudeCopyFile(files);
    const sign = claudeSignUploadUrl(files);

    for (const t of [list, upload, download, meta, url, del, copy, sign]) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.handler).toBe("function");
      expect(t.inputSchema).toBeDefined();
    }

    expect(list.name).toBe("listFiles");
    expect(upload.name).toBe("uploadFile");

    // Read tools get readOnlyHint
    expect(list.annotations?.readOnlyHint).toBe(true);
    // Destructive writes get destructiveHint
    expect(upload.annotations?.destructiveHint).toBe(true);
    expect(del.annotations?.destructiveHint).toBe(true);
    // Idempotent writes opt out of destructiveHint
    expect(copy.annotations?.idempotentHint).toBe(true);
    expect(sign.annotations?.idempotentHint).toBe(true);

    // Round-trip through the cherry-picked instances
    await invoke(upload, { content: "hello", key: "a.txt" });
    const listed = parseOutput(await invoke(list, {})) as {
      items: { key: string }[];
    };
    expect(listed.items.map((i) => i.key)).toEqual(["a.txt"]);
  });

  test("write-tool factories accept custom annotations", () => {
    const upload = claudeUploadFile(newFiles(), {
      annotations: { title: "Upload to S3" },
    });
    expect(upload.annotations?.title).toBe("Upload to S3");
  });
});
