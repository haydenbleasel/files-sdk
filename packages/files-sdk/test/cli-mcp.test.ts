import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { GlobalCliOptions } from "../src/cli/loader.js";
import {
  assertMcpDownloadFitsCap,
  buildMcpServer,
  DEFAULT_MCP_DOWNLOAD_MAX_BYTES,
  MAX_MCP_DOWNLOAD_BYTES,
  mcpDownloadSize,
  resolveMcpDownloadCap,
} from "../src/cli/mcp.js";
import { FilesError } from "../src/index.js";

describe("cli/mcp download guards", () => {
  test("download cap defaults to the MCP hard ceiling", () => {
    expect(resolveMcpDownloadCap()).toBe(DEFAULT_MCP_DOWNLOAD_MAX_BYTES);
    expect(MAX_MCP_DOWNLOAD_BYTES).toBe(DEFAULT_MCP_DOWNLOAD_MAX_BYTES);
  });

  test("download cap cannot be raised above the hard ceiling", () => {
    expect(() => resolveMcpDownloadCap(MAX_MCP_DOWNLOAD_BYTES + 1)).toThrow(
      FilesError
    );
  });

  test("range size is computed before body transfer", () => {
    expect(mcpDownloadSize(100, { end: 19, start: 10 })).toBe(10);
    expect(mcpDownloadSize(100, { start: 10 })).toBe(90);
    expect(mcpDownloadSize(100, { end: 200, start: 90 })).toBe(10);
    expect(mcpDownloadSize(100, { start: 120 })).toBe(0);
  });

  test("oversized effective body is rejected", () => {
    expect(() => assertMcpDownloadFitsCap("big.bin", 11, 10)).toThrow(
      /maxBytes=10/u
    );
  });
});

// --- end-to-end: drive the registered tools over an in-memory transport ---

interface ToolResult {
  data: Record<string, unknown>;
  isError: boolean;
}

interface Harness {
  client: Client;
  root: string;
  close: () => Promise<void>;
}

const NUL = String.fromCodePoint(0);

const connect = async (
  global: GlobalCliOptions,
  allowWrites: boolean,
  root: string,
  destination?: GlobalCliOptions
): Promise<Harness> => {
  const server = await buildMcpServer({ allowWrites, destination, global });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
      await fsp.rm(root, { force: true, recursive: true });
    },
    root,
  };
};

// A server bound to a healthy fs root, with a urlBaseUrl so url()/
// signedUploadUrl() resolve instead of erroring.
const healthyServer = async (allowWrites = true): Promise<Harness> => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-ok-"));
  return connect(
    { provider: "fs", root, urlBaseUrl: "http://localhost:3000/upload" },
    allowWrites,
    root
  );
};

// A server whose fs "root" is actually a regular file, so every fs operation
// throws — exercising each tool's catch/errorPayload branch. No urlBaseUrl, so
// signedUploadUrl() errors too.
const brokenServer = async (): Promise<Harness> => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-broken-"));
  const fileRoot = path.join(dir, "not-a-dir");
  await fsp.writeFile(fileRoot, "i am a file");
  return connect({ provider: "fs", root: fileRoot }, true, dir);
};

const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> => {
  const res = await client.callTool({ arguments: args, name });
  const content = res.content as { text: string; type: string }[];
  return {
    data: JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>,
    isError: res.isError === true,
  };
};

const toolNames = async (client: Client): Promise<string[]> => {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
};

describe("cli/mcp tools (write-enabled)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await healthyServer(true);
  });

  afterEach(async () => {
    await h.close();
  });

  test("upload (text + base64 + multipart) and download round-trip", async () => {
    const up = await call(h.client, "upload", {
      cacheControl: "no-cache",
      contentType: "text/plain",
      key: "hello.txt",
      metadata: { a: "1" },
      text: "hello world",
    });
    expect(up.isError).toBe(false);
    expect(up.data.key).toBe("hello.txt");

    const bin = await call(h.client, "upload", {
      base64: Buffer.from([1, 2, 3, 4]).toString("base64"),
      key: "blob.bin",
    });
    expect(bin.isError).toBe(false);

    const mp = await call(h.client, "upload", {
      key: "mp.txt",
      multipart: true,
      text: "multi",
    });
    expect(mp.isError).toBe(false);

    const dl = await call(h.client, "download", { key: "hello.txt" });
    expect(dl.isError).toBe(false);
    expect(Buffer.from(dl.data.base64 as string, "base64").toString()).toBe(
      "hello world"
    );
  });

  test("capabilities reports the fs adapter's snapshot", async () => {
    const res = await call(h.client, "capabilities");
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({
      rangeRead: true,
      serverSideCopy: true,
      signedUrl: { supported: false },
    });
  });

  test("upload rejects ambiguous and empty bodies", async () => {
    const both = await call(h.client, "upload", {
      base64: "AA==",
      key: "x",
      text: "y",
    });
    expect(both.isError).toBe(true);
    expect((both.data.error as { message: string }).message).toMatch(
      /mutually exclusive/u
    );

    const neither = await call(h.client, "upload", { key: "x" });
    expect(neither.isError).toBe(true);
    expect((neither.data.error as { message: string }).message).toMatch(
      /text.*base64/u
    );
  });

  test("download supports ranges and enforces maxBytes", async () => {
    await call(h.client, "upload", { key: "r.txt", text: "hello world" });

    const ranged = await call(h.client, "download", {
      key: "r.txt",
      range: { end: 4, start: 0 },
    });
    expect(ranged.isError).toBe(false);
    expect(Buffer.from(ranged.data.base64 as string, "base64").toString()).toBe(
      "hello"
    );

    const tooBig = await call(h.client, "download", {
      key: "r.txt",
      maxBytes: 3,
    });
    expect(tooBig.isError).toBe(true);
    expect((tooBig.data.error as { message: string }).message).toMatch(
      /exceeds maxBytes/u
    );
  });

  test("head single and array forms", async () => {
    await call(h.client, "upload", { key: "a.txt", text: "aa" });
    await call(h.client, "upload", { key: "b.txt", text: "bbb" });

    const single = await call(h.client, "head", { key: "a.txt" });
    expect(single.isError).toBe(false);
    expect(single.data.size).toBe(2);

    const many = await call(h.client, "head", {
      concurrency: 2,
      key: ["a.txt", "b.txt"],
      stopOnError: true,
    });
    expect(many.isError).toBe(false);
    expect((many.data.files as unknown[]).length).toBe(2);

    // No bulk knobs → bulkOpts returns undefined.
    const plain = await call(h.client, "head", { key: ["a.txt"] });
    expect((plain.data.files as unknown[]).length).toBe(1);
  });

  test("exists single and array forms", async () => {
    await call(h.client, "upload", { key: "here.txt", text: "x" });

    const yes = await call(h.client, "exists", { key: "here.txt" });
    expect(yes.data).toEqual({ exists: true, key: "here.txt" });

    const no = await call(h.client, "exists", { key: "gone.txt" });
    expect(no.data).toEqual({ exists: false, key: "gone.txt" });

    const many = await call(h.client, "exists", {
      key: ["here.txt", "gone.txt"],
    });
    expect(many.data.existing).toEqual(["here.txt"]);
    expect(many.data.missing).toEqual(["gone.txt"]);
  });

  test("bulk partial-failure errors carry a message and no cause", async () => {
    await call(h.client, "upload", { key: "ok.txt", text: "x" });
    // An invalid key (NUL) fails per-item; the serialized error must keep its
    // message (non-enumerable on Error) and not leak the raw provider cause.
    const many = await call(h.client, "head", {
      key: ["ok.txt", `bad${NUL}key`],
    });
    const errors = many.data.errors as {
      key: string;
      error: Record<string, unknown>;
    }[];
    expect(errors).toHaveLength(1);
    const message = errors[0]?.error.message;
    expect(typeof message).toBe("string");
    expect((message as string).length).toBeGreaterThan(0);
    expect(errors[0]?.error.cause).toBeUndefined();
  });

  test("exists surfaces a hard error for a single key", async () => {
    const bad = await call(h.client, "exists", { key: `bad${NUL}key` });
    expect(bad.isError).toBe(true);
  });

  test("delete single and array forms", async () => {
    await call(h.client, "upload", { key: "d1.txt", text: "x" });
    await call(h.client, "upload", { key: "d2.txt", text: "x" });

    const one = await call(h.client, "delete", { key: "d1.txt" });
    expect(one.data).toEqual({ deleted: true, key: "d1.txt" });

    const many = await call(h.client, "delete", {
      concurrency: 4,
      key: ["d2.txt"],
    });
    expect(many.isError).toBe(false);

    const after = await call(h.client, "exists", { key: "d1.txt" });
    expect(after.data.exists).toBe(false);
  });

  test("copy and move", async () => {
    await call(h.client, "upload", { key: "src.txt", text: "payload" });

    const copied = await call(h.client, "copy", {
      from: "src.txt",
      to: "cp.txt",
    });
    expect(copied.data).toEqual({
      copied: true,
      from: "src.txt",
      to: "cp.txt",
    });

    const moved = await call(h.client, "move", {
      from: "cp.txt",
      to: "mv.txt",
    });
    expect(moved.data).toEqual({ from: "cp.txt", moved: true, to: "mv.txt" });

    const movedExists = await call(h.client, "exists", { key: "mv.txt" });
    expect(movedExists.data.exists).toBe(true);
    const sourceExists = await call(h.client, "exists", { key: "cp.txt" });
    expect(sourceExists.data.exists).toBe(false);
  });

  test("list paginated and all", async () => {
    await call(h.client, "upload", { key: "l1.txt", text: "x" });
    await call(h.client, "upload", { key: "l2.txt", text: "x" });

    const paged = await call(h.client, "list", { limit: 1 });
    expect(paged.isError).toBe(false);
    expect(Array.isArray(paged.data.items)).toBe(true);

    const all = await call(h.client, "list", { all: true });
    expect((all.data.items as unknown[]).length).toBe(2);
  });

  test("search returns keys matching a glob, regex, or substring", async () => {
    await call(h.client, "upload", { key: "se/a.pdf", text: "x" });
    await call(h.client, "upload", { key: "se/b.txt", text: "x" });
    await call(h.client, "upload", { key: "se/c.pdf", text: "x" });

    const glob = await call(h.client, "search", { pattern: "se/*.pdf" });
    expect(glob.isError).toBe(false);
    expect(
      (glob.data.items as { key: string }[]).map((i) => i.key).toSorted()
    ).toEqual(["se/a.pdf", "se/c.pdf"]);

    const regex = await call(h.client, "search", {
      match: "regex",
      pattern: "\\.txt$",
      prefix: "se/",
    });
    expect((regex.data.items as { key: string }[]).map((i) => i.key)).toEqual([
      "se/b.txt",
    ]);

    const capped = await call(h.client, "search", {
      maxResults: 1,
      pattern: "se/*.pdf",
    });
    expect(capped.data.items as unknown[]).toHaveLength(1);
  });

  test("list with delimiter splits files and folders", async () => {
    await call(h.client, "upload", { key: "d/cover.jpg", text: "x" });
    await call(h.client, "upload", { key: "d/2024/a.jpg", text: "x" });

    const res = await call(h.client, "list", { delimiter: "/", prefix: "d/" });
    expect(res.isError).toBe(false);
    expect(res.data.items as { key: string }[]).toMatchObject([
      { key: "d/cover.jpg" },
    ]);
    expect(res.data.prefixes).toEqual(["d/2024/"]);
  });

  test("list rejects delimiter combined with all", async () => {
    const res = await call(h.client, "list", { all: true, delimiter: "/" });
    expect(res.isError).toBe(true);
    expect((res.data.error as { message: string }).message).toMatch(
      /pass one, not both/u
    );
  });

  test("url success and unsupported-option error", async () => {
    await call(h.client, "upload", { key: "u.txt", text: "x" });

    const ok = await call(h.client, "url", { key: "u.txt" });
    expect(ok.isError).toBe(false);
    expect(ok.data.url).toBe("http://localhost:3000/upload/u.txt");

    const bad = await call(h.client, "url", {
      key: "u.txt",
      responseContentDisposition: "attachment",
    });
    expect(bad.isError).toBe(true);
  });

  test("sign-upload returns a presigned form", async () => {
    const signed = await call(h.client, "sign-upload", {
      expiresIn: 600,
      key: "up.txt",
      maxSize: 1024,
      minSize: 0,
    });
    expect(signed.isError).toBe(false);
    expect(signed.data.key).toBe("up.txt");
    expect(typeof signed.data.url).toBe("string");
  });

  test("transfer and sync are omitted without an operator destination", async () => {
    const names = await toolNames(h.client);
    expect(names).not.toContain("transfer");
    expect(names).not.toContain("sync");
  });

  test("transfer copies to the operator destination provider", async () => {
    const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-src-"));
    const destRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-dest-"));
    const attackerRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "mcp-attacker-")
    );
    const h2 = await connect(
      { provider: "fs", root: sourceRoot },
      true,
      sourceRoot,
      { provider: "fs", root: destRoot }
    );

    try {
      await call(h2.client, "upload", { key: "pre/x.txt", text: "x" });
      await call(h2.client, "upload", { key: "pre/y.txt", text: "y" });

      const result = await call(h2.client, "transfer", {
        concurrency: 2,
        limit: 10,
        overwrite: false,
        prefix: "pre/",
        stopOnError: true,
        to: { provider: "fs", root: attackerRoot },
      });
      expect(result.isError).toBe(false);
      expect((result.data.transferred as string[]).toSorted()).toEqual([
        "pre/x.txt",
        "pre/y.txt",
      ]);
      expect(await fsp.exists(path.join(destRoot, "pre/x.txt"))).toBe(true);
      expect(await fsp.exists(path.join(attackerRoot, "pre/x.txt"))).toBe(
        false
      );
    } finally {
      await h2.close();
      await fsp.rm(destRoot, { force: true, recursive: true });
      await fsp.rm(attackerRoot, { force: true, recursive: true });
    }
  });

  test("sync mirrors to a destination provider and prunes", async () => {
    const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-src-"));
    const destRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-sync-"));
    const h2 = await connect(
      { provider: "fs", root: sourceRoot },
      true,
      sourceRoot,
      { provider: "fs", root: destRoot }
    );
    await fsp.mkdir(path.join(destRoot, "m"), { recursive: true });
    await fsp.writeFile(path.join(destRoot, "m/stale.txt"), "gone");

    try {
      await call(h2.client, "upload", { key: "m/a.txt", text: "alpha" });

      const result = await call(h2.client, "sync", {
        compare: "size",
        concurrency: 2,
        prefix: "m/",
        prune: true,
      });
      expect(result.isError).toBe(false);
      expect(result.data.uploaded).toEqual(["m/a.txt"]);
      expect(result.data.deleted).toEqual(["m/stale.txt"]);
    } finally {
      await h2.close();
      await fsp.rm(destRoot, { force: true, recursive: true });
    }
  });

  test("sync dryRun returns the plan without mutating", async () => {
    const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-src-"));
    const destRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-sync-dry-"));
    const h2 = await connect(
      { provider: "fs", root: sourceRoot },
      true,
      sourceRoot,
      { provider: "fs", root: destRoot }
    );
    await fsp.mkdir(path.join(destRoot, "d"), { recursive: true });
    await fsp.writeFile(path.join(destRoot, "d/stale.txt"), "gone");

    try {
      await call(h2.client, "upload", { key: "d/new.txt", text: "n" });

      const result = await call(h2.client, "sync", {
        dryRun: true,
        prefix: "d/",
        prune: true,
        to: { provider: "fs", root: "/attacker" },
      });
      expect(result.data.uploaded).toEqual(["d/new.txt"]);
      expect(result.data.deleted).toEqual(["d/stale.txt"]);
      expect(await fsp.exists(path.join(destRoot, "d/new.txt"))).toBe(false);
      expect(await fsp.exists(path.join(destRoot, "d/stale.txt"))).toBe(true);
    } finally {
      await h2.close();
      await fsp.rm(destRoot, { force: true, recursive: true });
    }
  });
});

describe("cli/mcp tools (error paths)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await brokenServer();
  });

  afterEach(async () => {
    await h.close();
  });

  test("every fs-backed tool reports its failure as an MCP error", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["upload", { key: "k.txt", text: "x" }],
      ["download", { key: "k.txt" }],
      ["head", { key: "k.txt" }],
      ["delete", { key: "k.txt" }],
      ["copy", { from: "a", to: "b" }],
      ["move", { from: "a", to: "b" }],
      ["list", {}],
      ["search", { pattern: "*" }],
      ["sign-upload", { expiresIn: 60, key: "k.txt" }],
    ];
    for (const [name, args] of cases) {
      const res = await call(h.client, name, args);
      expect(res.isError).toBe(true);
      expect(res.data.error).toBeDefined();
    }
  });
});

describe("cli/mcp startMcpServer", () => {
  test("builds the server and connects it to a stdio transport", async () => {
    // Swap the real stdio transport for an inert one so connect() resolves
    // without attaching listeners to process.stdin (which would keep the test
    // process alive).
    let started = false;
    // Inert transport standing in for the stdio one — injected directly so the
    // test never has to mock.module the transport binding (which is captured at
    // mcp.ts eval time and so depends on import order across the suite). The
    // stub methods don't read `this`, so silence the rule the fake clients hit.
    class FakeStdioTransport {
      onclose?: () => void;
      onerror?: (err: Error) => void;
      onmessage?: (msg: unknown) => void;
      // oxlint-disable-next-line class-methods-use-this
      close(): Promise<void> {
        return Promise.resolve();
      }
      // oxlint-disable-next-line class-methods-use-this
      send(): Promise<void> {
        return Promise.resolve();
      }
      // oxlint-disable-next-line class-methods-use-this
      start(): Promise<void> {
        started = true;
        return Promise.resolve();
      }
    }

    const { startMcpServer } = await import("../src/cli/mcp.js");
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-stdio-"));
    try {
      await startMcpServer(
        { global: { provider: "fs", root } },
        () => new FakeStdioTransport()
      );
      expect(started).toBe(true);
    } finally {
      await fsp.rm(root, { force: true, recursive: true });
    }
  });
});

describe("cli/mcp read-only server", () => {
  test("omits mutating tools when allowWrites is false", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-ro-"));
    const h = await connect({ provider: "fs", root }, false, root);
    try {
      const names = await toolNames(h.client);
      expect(names).toEqual(
        expect.arrayContaining([
          "capabilities",
          "download",
          "head",
          "exists",
          "list",
          "search",
          "url",
        ])
      );
      for (const writeTool of [
        "upload",
        "delete",
        "copy",
        "move",
        "sign-upload",
        "transfer",
        "sync",
      ]) {
        expect(names).not.toContain(writeTool);
      }
    } finally {
      await h.close();
    }
  });
});
