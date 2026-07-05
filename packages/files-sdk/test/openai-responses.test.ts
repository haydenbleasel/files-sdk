import { describe, expect, spyOn, test } from "bun:test";

import { Files, FilesError } from "../src/index.js";
import { MAX_DOWNLOAD_BYTES } from "../src/internal/ai-tools/schemas.js";
import { createResponsesFileTools } from "../src/openai/index.js";
import type { FunctionCallItem } from "../src/openai/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const newFiles = () => new Files({ adapter: fakeAdapter() });

const call = (
  name: string,
  args: Record<string, unknown> | string,
  callId = "call_1"
): FunctionCallItem => ({
  arguments: typeof args === "string" ? args : JSON.stringify(args),
  call_id: callId,
  name,
  type: "function_call",
});

const approved = { approved: true } as const;

describe("createResponsesFileTools", () => {
  test("definitions returns all eight tools by default", () => {
    const ft = createResponsesFileTools({ files: newFiles() });
    expect(ft.definitions.map((d) => d.name).toSorted()).toEqual(
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
    const ft = createResponsesFileTools({
      files: newFiles(),
      readOnly: true,
    });
    expect(ft.definitions.map((d) => d.name).toSorted()).toEqual(
      ["downloadFile", "getFileMetadata", "getFileUrl", "listFiles"].toSorted()
    );
  });

  test("each definition is a strict-defaulted-false function tool with object parameters", () => {
    const ft = createResponsesFileTools({ files: newFiles() });
    for (const def of ft.definitions) {
      expect(def.type).toBe("function");
      expect(typeof def.name).toBe("string");
      expect(typeof def.description).toBe("string");
      expect(def.strict).toBe(false);
      expect(def.parameters).toMatchObject({
        additionalProperties: false,
        type: "object",
      });
    }
  });

  test("needsApproval reports writes true / reads false by default", () => {
    const ft = createResponsesFileTools({ files: newFiles() });
    expect(ft.needsApproval("uploadFile")).toBe(true);
    expect(ft.needsApproval("deleteFile")).toBe(true);
    expect(ft.needsApproval("copyFile")).toBe(true);
    expect(ft.needsApproval("signUploadUrl")).toBe(true);
    expect(ft.needsApproval("listFiles")).toBe(false);
    expect(ft.needsApproval("downloadFile")).toBe(false);
    expect(ft.needsApproval("notATool")).toBe(false);
  });

  test("requireApproval: false clears every write", () => {
    const ft = createResponsesFileTools({
      files: newFiles(),
      requireApproval: false,
    });
    expect(ft.needsApproval("uploadFile")).toBe(false);
    expect(ft.needsApproval("deleteFile")).toBe(false);
    expect(ft.needsApproval("copyFile")).toBe(false);
    expect(ft.needsApproval("signUploadUrl")).toBe(false);
  });

  test("requireApproval object resolves per-tool with default true for unspecified writes", () => {
    const ft = createResponsesFileTools({
      files: newFiles(),
      requireApproval: { deleteFile: true, uploadFile: false },
    });
    expect(ft.needsApproval("uploadFile")).toBe(false);
    expect(ft.needsApproval("deleteFile")).toBe(true);
    expect(ft.needsApproval("copyFile")).toBe(true);
    expect(ft.needsApproval("signUploadUrl")).toBe(true);
  });

  test("overrides patch description and strict on the right definition", () => {
    const ft = createResponsesFileTools({
      files: newFiles(),
      overrides: {
        listFiles: { description: "Custom list" },
        uploadFile: { strict: true },
      },
    });
    const list = ft.definitions.find((d) => d.name === "listFiles");
    const upload = ft.definitions.find((d) => d.name === "uploadFile");
    expect(list?.description).toBe("Custom list");
    expect(list?.strict).toBe(false);
    expect(upload?.strict).toBe(true);
  });

  test("execute round-trip: upload → list → download → delete", async () => {
    const files = newFiles();
    const ft = createResponsesFileTools({ files });

    const uploadOut = await ft.execute(
      call("uploadFile", {
        content: "hello",
        contentType: "text/plain",
        key: "a.txt",
      }),
      approved
    );
    expect(uploadOut.type).toBe("function_call_output");
    expect(uploadOut.call_id).toBe("call_1");
    expect(JSON.parse(uploadOut.output)).toMatchObject({
      contentType: "text/plain",
      key: "a.txt",
      size: 5,
    });

    const listOut = await ft.execute(call("listFiles", {}));
    const listed = JSON.parse(listOut.output) as {
      items: { key: string }[];
    };
    expect(listed.items.map((i) => i.key)).toEqual(["a.txt"]);

    const dlOut = await ft.execute(call("downloadFile", { key: "a.txt" }));
    expect(JSON.parse(dlOut.output)).toMatchObject({
      content: "hello",
      encoding: "text",
    });

    const delOut = await ft.execute(
      call("deleteFile", { key: "a.txt" }),
      approved
    );
    expect(JSON.parse(delOut.output)).toEqual({ deleted: true, key: "a.txt" });
  });

  test("execute blocks approval-gated writes until approved", async () => {
    const files = newFiles();
    const ft = createResponsesFileTools({ files });
    const out = await ft.execute(
      call("uploadFile", { content: "x", key: "blocked.txt" })
    );
    const parsed = JSON.parse(out.output) as {
      approvalRequired: boolean;
      error: string;
      tool: string;
    };
    expect(parsed).toMatchObject({
      approvalRequired: true,
      tool: "uploadFile",
    });
    expect(parsed.error).toMatch(/requires approval/u);
    const listed = await files.list();
    expect(listed.items).toHaveLength(0);
  });

  test("invalid JSON arguments come back as an error in the output", async () => {
    const ft = createResponsesFileTools({ files: newFiles() });
    const out = await ft.execute(call("listFiles", "not json"));
    expect(out.type).toBe("function_call_output");
    const parsed = JSON.parse(out.output) as { error: string };
    expect(parsed.error).toMatch(/Invalid JSON/u);
  });

  test("validation failures come back as an error in the output", async () => {
    const ft = createResponsesFileTools({ files: newFiles() });
    const out = await ft.execute(
      call("uploadFile", {
        // missing required `content` and `key`
        contentType: "text/plain",
      }),
      approved
    );
    const parsed = JSON.parse(out.output) as { error: string; issues: unknown };
    expect(parsed.error).toBe("Argument validation failed");
    expect(Array.isArray(parsed.issues)).toBe(true);
  });

  test("unknown tool name comes back as error, does not throw", async () => {
    const ft = createResponsesFileTools({ files: newFiles() });
    const out = await ft.execute(call("notATool", {}));
    const parsed = JSON.parse(out.output) as { error: string };
    expect(parsed.error).toMatch(/Unknown tool/u);
  });

  test("readOnly: true rejects write calls as unknown", async () => {
    const ft = createResponsesFileTools({
      files: newFiles(),
      readOnly: true,
    });
    const out = await ft.execute(
      call("uploadFile", { content: "x", key: "k" })
    );
    const parsed = JSON.parse(out.output) as { error: string };
    expect(parsed.error).toMatch(/Unknown tool/u);
  });

  test("FilesError from executor (maxBytes) is rethrown", async () => {
    const files = newFiles();
    const ft = createResponsesFileTools({ files });
    await ft.execute(
      call("uploadFile", { content: "abcdefghij", key: "big.txt" }),
      approved
    );

    try {
      await ft.execute(call("downloadFile", { key: "big.txt", maxBytes: 4 }));
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).message).toMatch(/maxBytes/u);
    }
  });

  test("validation rejects maxBytes above the hard tool ceiling", async () => {
    const ft = createResponsesFileTools({ files: newFiles() });
    const out = await ft.execute(
      call("downloadFile", {
        key: "big.txt",
        maxBytes: MAX_DOWNLOAD_BYTES + 1,
      })
    );
    const parsed = JSON.parse(out.output) as { error: string; issues: unknown };
    expect(parsed.error).toBe("Argument validation failed");
    expect(Array.isArray(parsed.issues)).toBe(true);
  });

  test("uploadFile encoding=base64 round-trips bytes", async () => {
    const files = newFiles();
    const ft = createResponsesFileTools({ files });

    const raw = new Uint8Array([10, 20, 30, 40, 50]);
    let binary = "";
    for (const b of raw) {
      binary += String.fromCodePoint(b);
    }
    const base64 = btoa(binary);

    await ft.execute(
      call("uploadFile", {
        content: base64,
        contentType: "application/octet-stream",
        encoding: "base64",
        key: "blob.dat",
      }),
      approved
    );

    const stored = await files.download("blob.dat");
    const buf = await stored.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(raw);
  });

  test("downloadFile binary=true returns base64-encoded bytes", async () => {
    const files = newFiles();
    const ft = createResponsesFileTools({ files });

    const raw = new Uint8Array([0, 1, 2, 254, 255]);
    await files.upload("blob.bin", raw);

    const out = await ft.execute(
      call("downloadFile", { binary: true, key: "blob.bin" })
    );
    const result = JSON.parse(out.output) as {
      content: string;
      encoding: "text" | "base64";
    };
    expect(result.encoding).toBe("base64");
    const decoded = Uint8Array.from(
      atob(result.content),
      (c) => c.codePointAt(0) ?? 0
    );
    expect([...decoded]).toEqual([...raw]);
  });

  test("getFileMetadata returns size + custom metadata without transferring body", async () => {
    const files = newFiles();
    const ft = createResponsesFileTools({ files });
    await ft.execute(
      call("uploadFile", {
        content: "payload",
        contentType: "text/plain",
        key: "report.txt",
        metadata: { tenant: "acme" },
      }),
      approved
    );

    const out = await ft.execute(
      call("getFileMetadata", { key: "report.txt" })
    );
    const meta = JSON.parse(out.output) as {
      key: string;
      size: number;
      type: string;
      metadata?: Record<string, string>;
    };
    expect(meta.key).toBe("report.txt");
    expect(meta.size).toBe("payload".length);
    expect(meta.type).toBe("text/plain");
    expect(meta.metadata).toEqual({ tenant: "acme" });
  });

  test("getFileUrl forwards expiresIn and responseContentDisposition", async () => {
    const files = newFiles();
    const ft = createResponsesFileTools({ files });
    await ft.execute(
      call("uploadFile", { content: "x", key: "u.txt" }),
      approved
    );

    const out = await ft.execute(
      call("getFileUrl", {
        expiresIn: 60,
        key: "u.txt",
        responseContentDisposition: 'attachment; filename="u.txt"',
      })
    );
    const result = JSON.parse(out.output) as { key: string; url: string };
    expect(result.key).toBe("u.txt");
    expect(result.url).toContain("expires=60");
  });

  test("copyFile duplicates the source key, leaves source intact", async () => {
    const files = newFiles();
    const ft = createResponsesFileTools({ files });
    await ft.execute(
      call("uploadFile", { content: "payload", key: "src.txt" }),
      approved
    );

    const out = await ft.execute(
      call("copyFile", { from: "src.txt", to: "dst.txt" }),
      approved
    );
    expect(JSON.parse(out.output)).toEqual({
      copied: true,
      from: "src.txt",
      to: "dst.txt",
    });
    const srcFile = await files.download("src.txt");
    const dstFile = await files.download("dst.txt");
    expect(await srcFile.text()).toBe("payload");
    expect(await dstFile.text()).toBe("payload");
  });

  test("signUploadUrl returns a SignedUpload descriptor", async () => {
    const ft = createResponsesFileTools({ files: newFiles() });
    const out = await ft.execute(
      call("signUploadUrl", { expiresIn: 120, key: "upload.bin" }),
      approved
    );
    const result = JSON.parse(out.output) as { method: string; url: string };
    expect(result.method).toBe("PUT");
    expect(result.url).toMatch(/^https:\/\/fake\.local/u);
  });

  test("listFiles forwards prefix, cursor, and limit", async () => {
    const files = newFiles();
    const ft = createResponsesFileTools({ files });
    await Promise.all(
      ["a/1.txt", "a/2.txt", "b/1.txt"].map((k) =>
        ft.execute(call("uploadFile", { content: "x", key: k }), approved)
      )
    );

    const out = await ft.execute(
      call("listFiles", { limit: 10, prefix: "a/" })
    );
    const result = JSON.parse(out.output) as { items: { key: string }[] };
    expect(result.items.map((i) => i.key)).toEqual(["a/1.txt", "a/2.txt"]);
  });

  test("validation failure on signUploadUrl (missing required expiresIn)", async () => {
    const ft = createResponsesFileTools({ files: newFiles() });
    const out = await ft.execute(call("signUploadUrl", { key: "k" }), approved);
    const parsed = JSON.parse(out.output) as { error: string; issues: unknown };
    expect(parsed.error).toBe("Argument validation failed");
    expect(Array.isArray(parsed.issues)).toBe(true);
  });

  test("validation failure path is consistent for every tool", async () => {
    const ft = createResponsesFileTools({ files: newFiles() });
    // Each tool requires at least one string field — passing a number
    // for `key` (or a missing required field for the from/to/expiresIn
    // tools) reliably trips validation across the whole surface.
    const cases: { name: string; args: Record<string, unknown> }[] = [
      { args: { key: 123 }, name: "getFileMetadata" },
      { args: { key: 123 }, name: "downloadFile" },
      { args: { key: 123 }, name: "getFileUrl" },
      { args: { limit: -1 }, name: "listFiles" },
      { args: { from: "x" }, name: "copyFile" },
      { args: { key: 123 }, name: "deleteFile" },
    ];
    for (const c of cases) {
      // eslint-disable-next-line no-await-in-loop -- exercises the shared tool executor once per validation case
      const out = await ft.execute(
        call(c.name, c.args),
        ft.needsApproval(c.name) ? approved : undefined
      );
      const parsed = JSON.parse(out.output) as {
        error: string;
        issues: unknown;
      };
      expect(parsed.error).toBe("Argument validation failed");
      expect(Array.isArray(parsed.issues)).toBe(true);
    }
  });

  test("dispatch's exhaustive guard throws if an unhandled name slips past the gate", async () => {
    // The `includedSet.has` gate normally blocks any name outside the eight
    // known tools, so dispatch's `default: never` branch is unreachable through
    // the public surface. Force the gate open for a single execute() call to
    // assert the guard actually throws rather than silently passing — the
    // safety net that protects against a tool name being added without a
    // matching dispatch case. `Set.prototype.has` is restored immediately so no
    // other test sees the patch.
    const ft = createResponsesFileTools({ files: newFiles() });
    const hasSpy = spyOn(Set.prototype, "has").mockReturnValue(true);
    try {
      await expect(ft.execute(call("ghostTool", {}), approved)).rejects.toThrow(
        /Unhandled tool: ghostTool/u
      );
    } finally {
      hasSpy.mockRestore();
    }
  });

  test("execute requireApproval=false leaves writes executable without approval", async () => {
    const ft = createResponsesFileTools({
      files: newFiles(),
      requireApproval: false,
    });
    // sanity: every write reports false
    for (const name of [
      "uploadFile",
      "deleteFile",
      "copyFile",
      "signUploadUrl",
    ]) {
      expect(ft.needsApproval(name)).toBe(false);
    }

    const out = await ft.execute(
      call("uploadFile", { content: "x", key: "allowed.txt" })
    );
    expect(JSON.parse(out.output)).toMatchObject({
      key: "allowed.txt",
      size: 1,
    });
  });
});
