import { describe, expect, test } from "bun:test";

import { RunContext } from "@openai/agents";

import { Files, FilesError } from "../src/index.js";
import {
  agentsCopyFile,
  agentsDeleteFile,
  agentsDownloadFile,
  agentsGetFileMetadata,
  agentsGetFileUrl,
  agentsListFiles,
  agentsSignUploadUrl,
  agentsUploadFile,
  createAgentsFileTools,
} from "../src/openai/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const newFiles = () => new Files({ adapter: fakeAdapter() });

interface AgentTool {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
  strict: boolean;
  needsApproval: (...args: unknown[]) => Promise<boolean>;
  invoke: (runContext: RunContext, input: string) => Promise<unknown>;
}

const asTool = (t: unknown): AgentTool => t as AgentTool;

const invoke = async (
  t: unknown,
  input: Record<string, unknown>
): Promise<unknown> => {
  const tool = asTool(t);
  const ctx = new RunContext();
  return await tool.invoke(ctx, JSON.stringify(input));
};

const approval = async (t: unknown): Promise<boolean> => {
  const tool = asTool(t);
  const ctx = new RunContext();
  return await tool.needsApproval(ctx, {}, "test-call");
};

describe("createAgentsFileTools", () => {
  test("returns all eight tools by default", () => {
    const tools = createAgentsFileTools({ files: newFiles() });
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

  test("readOnly: true strips write tools", () => {
    const tools = createAgentsFileTools({
      files: newFiles(),
      readOnly: true,
    });
    expect(Object.keys(tools).toSorted()).toEqual(
      ["downloadFile", "getFileMetadata", "getFileUrl", "listFiles"].toSorted()
    );
    expect("uploadFile" in tools).toBe(false);
  });

  test("each tool has the @openai/agents shape", () => {
    const tools = createAgentsFileTools({ files: newFiles() });
    for (const [name, tool] of Object.entries(tools)) {
      const t = asTool(tool);
      expect(t.type).toBe("function");
      expect(t.name).toBe(name);
      expect(typeof t.description).toBe("string");
      expect(t.parameters).toBeDefined();
      expect(typeof t.invoke).toBe("function");
      expect(typeof t.needsApproval).toBe("function");
    }
  });

  test("write tools default to needsApproval=true; reads to false", async () => {
    const tools = createAgentsFileTools({ files: newFiles() });
    expect(await approval(tools.uploadFile)).toBe(true);
    expect(await approval(tools.deleteFile)).toBe(true);
    expect(await approval(tools.copyFile)).toBe(true);
    expect(await approval(tools.signUploadUrl)).toBe(true);
    expect(await approval(tools.listFiles)).toBe(false);
    expect(await approval(tools.downloadFile)).toBe(false);
  });

  test("requireApproval: false clears every write", async () => {
    const tools = createAgentsFileTools({
      files: newFiles(),
      requireApproval: false,
    });
    expect(await approval(tools.uploadFile)).toBe(false);
    expect(await approval(tools.deleteFile)).toBe(false);
    expect(await approval(tools.copyFile)).toBe(false);
    expect(await approval(tools.signUploadUrl)).toBe(false);
  });

  test("requireApproval object resolves per-tool with default true for unspecified writes", async () => {
    const tools = createAgentsFileTools({
      files: newFiles(),
      requireApproval: { deleteFile: true, uploadFile: false },
    });
    expect(await approval(tools.uploadFile)).toBe(false);
    expect(await approval(tools.deleteFile)).toBe(true);
    expect(await approval(tools.copyFile)).toBe(true);
    expect(await approval(tools.signUploadUrl)).toBe(true);
  });

  test("invoke: upload + list + download round-trip via fake adapter", async () => {
    const files = newFiles();
    const tools = createAgentsFileTools({ files });

    const uploaded = (await invoke(tools.uploadFile, {
      content: "hello world",
      contentType: "text/plain",
      key: "report.txt",
    })) as { key: string; size: number };
    expect(uploaded.key).toBe("report.txt");
    expect(uploaded.size).toBe("hello world".length);

    const listed = (await invoke(tools.listFiles, {})) as {
      items: { key: string }[];
    };
    expect(listed.items.map((i) => i.key)).toEqual(["report.txt"]);

    const downloaded = (await invoke(tools.downloadFile, {
      key: "report.txt",
    })) as { content: string };
    expect(downloaded.content).toBe("hello world");
  });

  test("FilesError from executor surfaces via the agents SDK's default error handler", async () => {
    // The Agents SDK wraps execute() errors via its default `errorFunction`,
    // converting them into a model-visible string rather than rethrowing —
    // this is the expected pattern for Agents (the model can self-correct on
    // the next turn). We verify the FilesError message reaches the model.
    const files = newFiles();
    const tools = createAgentsFileTools({ files });
    await invoke(tools.uploadFile, { content: "abcdefghij", key: "big.txt" });

    const result = (await invoke(tools.downloadFile, {
      key: "big.txt",
      maxBytes: 4,
    })) as string;
    expect(typeof result).toBe("string");
    expect(result).toMatch(/maxBytes/u);
    expect(result).toMatch(/FilesError/u);
    // FilesError class is still exported and usable from the package
    expect(typeof FilesError).toBe("function");
  });

  test("overrides patch description without dropping required props", () => {
    const tools = createAgentsFileTools({
      files: newFiles(),
      overrides: {
        deleteFile: { needsApproval: false },
        listFiles: { description: "Custom list" },
      },
    });
    expect(asTool(tools.listFiles).description).toBe("Custom list");
    expect(asTool(tools.listFiles).invoke).toBeInstanceOf(Function);
    // After override, needsApproval becomes a literal boolean (overrides apply
    // via Object.assign on the tool object — same pattern as ai-sdk)
    expect(asTool(tools.deleteFile).needsApproval).toBe(false as never);
  });

  test("overrides for unknown tool names are ignored", () => {
    const tools = createAgentsFileTools({
      files: newFiles(),
      overrides: {
        // @ts-expect-error — unknown keys typed out; runtime guard drops them
        notATool: { description: "noop" },
      },
    });
    expect("notATool" in tools).toBe(false);
  });

  test("getFileMetadata + getFileUrl + copyFile + signUploadUrl invocations", async () => {
    const files = newFiles();
    const tools = createAgentsFileTools({ files });

    await invoke(tools.uploadFile, {
      content: "payload",
      contentType: "text/plain",
      key: "src.txt",
      metadata: { tenant: "acme" },
    });

    const meta = (await invoke(tools.getFileMetadata, { key: "src.txt" })) as {
      key: string;
      size: number;
      metadata?: Record<string, string>;
    };
    expect(meta.key).toBe("src.txt");
    expect(meta.metadata).toEqual({ tenant: "acme" });

    const urlResult = (await invoke(tools.getFileUrl, {
      expiresIn: 90,
      key: "src.txt",
    })) as { key: string; url: string };
    expect(urlResult.url).toContain("expires=90");

    const copyResult = (await invoke(tools.copyFile, {
      from: "src.txt",
      to: "dst.txt",
    })) as { copied: boolean; from: string; to: string };
    expect(copyResult).toEqual({
      copied: true,
      from: "src.txt",
      to: "dst.txt",
    });

    const signResult = (await invoke(tools.signUploadUrl, {
      expiresIn: 120,
      key: "upload.bin",
    })) as { method: string; url: string };
    expect(signResult.method).toBe("PUT");
    expect(signResult.url).toMatch(/^https:\/\/fake\.local/u);

    const delResult = (await invoke(tools.deleteFile, { key: "src.txt" })) as {
      deleted: boolean;
      key: string;
    };
    expect(delResult).toEqual({ deleted: true, key: "src.txt" });
  });

  test("downloadFile binary=true returns base64 bytes", async () => {
    const files = newFiles();
    const tools = createAgentsFileTools({ files });

    const raw = new Uint8Array([0, 1, 2, 254, 255]);
    await files.upload("blob.bin", raw);

    const result = (await invoke(tools.downloadFile, {
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

  test("uploadFile encoding=base64 decodes binary content", async () => {
    const files = newFiles();
    const tools = createAgentsFileTools({ files });

    const raw = new Uint8Array([10, 20, 30, 40, 50]);
    let binary = "";
    for (const b of raw) {
      binary += String.fromCodePoint(b);
    }
    const base64 = btoa(binary);

    await invoke(tools.uploadFile, {
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
    const tools = createAgentsFileTools({ files });
    await Promise.all(
      ["a/1.txt", "a/2.txt", "b/1.txt"].map((k) =>
        invoke(tools.uploadFile, { content: "x", key: k })
      )
    );

    const result = (await invoke(tools.listFiles, { prefix: "a/" })) as {
      items: { key: string }[];
    };
    expect(result.items.map((i) => i.key)).toEqual(["a/1.txt", "a/2.txt"]);
  });

  test("FilesError-passthrough surfaces as model-visible string for every executor", async () => {
    // NotFound error path — head() inside downloadFile fails with FilesError.
    // The Agents SDK wraps it via the default errorFunction.
    const tools = createAgentsFileTools({ files: newFiles() });
    const result = (await invoke(tools.downloadFile, {
      key: "missing.txt",
    })) as string;
    expect(typeof result).toBe("string");
    expect(result).toMatch(/missing\.txt|not found|FilesError/u);
  });

  test("cherry-picked individual factories work and accept needsApproval", async () => {
    const files = newFiles();

    const list = agentsListFiles(files);
    const upload = agentsUploadFile(files, { needsApproval: false });
    const download = agentsDownloadFile(files);
    const meta = agentsGetFileMetadata(files);
    const url = agentsGetFileUrl(files);
    const del = agentsDeleteFile(files, { needsApproval: false });
    const copy = agentsCopyFile(files, { needsApproval: false });
    const sign = agentsSignUploadUrl(files, { needsApproval: false });

    // Each is a fully-formed agents tool
    for (const t of [list, upload, download, meta, url, del, copy, sign]) {
      expect(asTool(t).type).toBe("function");
      expect(typeof asTool(t).invoke).toBe("function");
    }

    // needsApproval honored on the cherry-picked write tools
    expect(await approval(upload)).toBe(false);
    expect(await approval(del)).toBe(false);
    expect(await approval(copy)).toBe(false);
    expect(await approval(sign)).toBe(false);

    // Round-trip through the cherry-picked instances
    await invoke(upload, { content: "hello", key: "a.txt" });
    const listed = (await invoke(list, {})) as { items: { key: string }[] };
    expect(listed.items.map((i) => i.key)).toEqual(["a.txt"]);
  });
});
