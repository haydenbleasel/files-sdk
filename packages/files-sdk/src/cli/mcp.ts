import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { transfer } from "../index.js";
import { rangedSize } from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { storedFileToJson } from "./io.js";
import { loadFiles } from "./loader.js";
import type { GlobalCliOptions } from "./loader.js";

// Shared schema for the bulk-fanout knobs on the array-form tools.
const concurrencyArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Parallel operations for the array form (default 8)");
const stopOnErrorArg = z
  .boolean()
  .optional()
  .describe("Stop at the first failure instead of collecting per-key errors");

const bulkOpts = (
  concurrency?: number,
  stopOnError?: boolean
): { concurrency?: number; stopOnError?: boolean } | undefined => {
  const opts: { concurrency?: number; stopOnError?: boolean } = {};
  if (concurrency !== undefined) {
    opts.concurrency = concurrency;
  }
  if (stopOnError) {
    opts.stopOnError = true;
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
};

const pkg = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

// Default cap for MCP `download` — base64-encoded bodies must fit in a
// single tool response, so refuse anything that would obviously OOM the
// agent process. Callers can lower the cap with `maxBytes`, but cannot raise
// it above the hard ceiling.
export const DEFAULT_MCP_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_MCP_DOWNLOAD_BYTES = DEFAULT_MCP_DOWNLOAD_MAX_BYTES;

export const resolveMcpDownloadCap = (maxBytes?: number): number => {
  const cap = maxBytes ?? DEFAULT_MCP_DOWNLOAD_MAX_BYTES;
  if (cap > MAX_MCP_DOWNLOAD_BYTES) {
    throw new FilesError(
      "Provider",
      `maxBytes must be less than or equal to ${MAX_MCP_DOWNLOAD_BYTES} — use the CLI to stream larger bodies`
    );
  }
  return cap;
};

export const mcpDownloadSize = (
  fullSize: number,
  range?: { end?: number; start: number }
): number => (range ? rangedSize(fullSize, range) : fullSize);

export const assertMcpDownloadFitsCap = (
  key: string,
  size: number,
  cap: number
): void => {
  if (size > cap) {
    throw new FilesError(
      "Provider",
      `object "${key}" is ${size} bytes, exceeds maxBytes=${cap} — use the CLI to stream large bodies`
    );
  }
};

const encodeUploadBody = (text?: string, base64?: string): Uint8Array => {
  if (text !== undefined) {
    return new TextEncoder().encode(text);
  }
  if (base64 !== undefined) {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  throw new FilesError("Provider", "expected either `text` or `base64` body");
};

export interface McpServerOpts {
  allowWrites?: boolean;
  global: GlobalCliOptions;
}

const ok = (data: unknown) => ({
  content: [{ text: JSON.stringify(data, null, 2), type: "text" as const }],
});

const errorPayload = (err: unknown) => {
  const code = err instanceof FilesError ? err.code : "Provider";
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        text: JSON.stringify({ error: { code, message } }, null, 2),
        type: "text" as const,
      },
    ],
    isError: true,
  };
};

/**
 * Build an MCP server with the file tools registered, ready to connect to a
 * transport. Read tools are registered by default; pass `allowWrites` to
 * expose mutating tools. Provider + credentials are bound here (from the
 * global flags / env), so each tool call only needs operation arguments — the
 * agent doesn't have to thread credentials through every request.
 *
 * The `Files` instance is constructed once and reused across every tool call.
 * This keeps the underlying SDK client (S3 client, GCS client, etc.) warm and
 * surfaces credential failures immediately rather than on the first tool call.
 *
 * Split out from {@link startMcpServer} so the registered tools can be driven
 * over an in-memory transport in tests without touching stdio.
 */
export const buildMcpServer = async (
  opts: McpServerOpts
): Promise<McpServer> => {
  const server = new McpServer({
    name: "files-sdk",
    version: pkg.version,
  });

  const { files } = await loadFiles(opts.global);
  const allowWrites = opts.allowWrites ?? false;

  if (allowWrites) {
    server.registerTool(
      "upload",
      {
        description:
          "Upload bytes to the configured provider at the given key. Body may be inline UTF-8 text or base64-encoded binary — exactly one of `text` or `base64` is required.",
        inputSchema: {
          base64: z
            .string()
            .optional()
            .describe("Base64-encoded body (mutually exclusive with text)"),
          cacheControl: z.string().optional(),
          contentType: z.string().optional(),
          key: z.string().describe("Object key (path) within the bucket/store"),
          metadata: z
            .record(z.string(), z.string())
            .optional()
            .describe("Metadata as a string-to-string object"),
          multipart: z
            .union([
              z.boolean(),
              z.object({
                concurrency: z.number().int().positive().optional(),
                partSize: z.number().int().positive().optional(),
              }),
            ])
            .optional()
            .describe(
              "Upload in parallel parts: true, or { partSize, concurrency }"
            ),
          text: z
            .string()
            .optional()
            .describe("UTF-8 body (mutually exclusive with base64)"),
        },
        title: "Upload a file",
      },
      async ({
        key,
        text,
        base64,
        contentType,
        cacheControl,
        metadata,
        multipart,
      }) => {
        try {
          if (text !== undefined && base64 !== undefined) {
            throw new FilesError(
              "Provider",
              "`text` and `base64` are mutually exclusive — pass exactly one"
            );
          }
          const body = encodeUploadBody(text, base64);
          const result = await files.upload(key, body, {
            cacheControl,
            contentType,
            metadata,
            ...(multipart !== undefined && { multipart }),
          });
          return ok(result);
        } catch (error) {
          return errorPayload(error);
        }
      }
    );
  }

  server.registerTool(
    "download",
    {
      description:
        "Download bytes for the given key. Returns metadata + base64 body so binary roundtrips safely through MCP. Bodies larger than `maxBytes` (default 10 MiB) are refused — use the CLI for larger files.",
      inputSchema: {
        key: z.string(),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(MAX_MCP_DOWNLOAD_BYTES)
          .optional()
          .describe(
            `Refuse the download if the body exceeds this many bytes (default ${DEFAULT_MCP_DOWNLOAD_MAX_BYTES}, maximum ${MAX_MCP_DOWNLOAD_BYTES})`
          ),
        range: z
          .object({
            end: z.number().int().nonnegative().optional(),
            start: z.number().int().nonnegative(),
          })
          .optional()
          .describe(
            "Download only a byte range (0-based, inclusive). Throws on adapters with no range primitive."
          ),
      },
      title: "Download a file",
    },
    async ({ key, maxBytes, range }) => {
      try {
        const cap = resolveMcpDownloadCap(maxBytes);
        const meta = await files.head(key);
        assertMcpDownloadFitsCap(key, mcpDownloadSize(meta.size, range), cap);
        const file = await files.download(key, range ? { range } : undefined);
        const buf = Buffer.from(await file.arrayBuffer());
        assertMcpDownloadFitsCap(key, buf.byteLength, cap);
        return ok({
          ...storedFileToJson(file),
          base64: buf.toString("base64"),
        });
      } catch (error) {
        return errorPayload(error);
      }
    }
  );

  server.registerTool(
    "head",
    {
      description:
        "Fetch metadata for `key` without transferring its body. Pass an array of keys to fetch many in one call — that form returns a structured `{ files, errors? }` result instead of throwing on partial failure.",
      inputSchema: {
        concurrency: concurrencyArg,
        key: z.union([z.string(), z.array(z.string())]),
        stopOnError: stopOnErrorArg,
      },
      title: "Get metadata for one or many keys",
    },
    async ({ key, concurrency, stopOnError }) => {
      try {
        if (Array.isArray(key)) {
          const result = await files.head(
            key,
            bulkOpts(concurrency, stopOnError)
          );
          return ok({
            ...result,
            files: result.files.map(storedFileToJson),
          });
        }
        const file = await files.head(key);
        return ok(storedFileToJson(file));
      } catch (error) {
        return errorPayload(error);
      }
    }
  );

  server.registerTool(
    "exists",
    {
      description:
        "Returns { key, exists }. Pass an array of keys to check many in one call — that form returns `{ existing, missing, errors? }` instead.",
      inputSchema: {
        concurrency: concurrencyArg,
        key: z.union([z.string(), z.array(z.string())]),
        stopOnError: stopOnErrorArg,
      },
      title: "Check whether one or many keys exist",
    },
    async ({ key, concurrency, stopOnError }) => {
      try {
        if (Array.isArray(key)) {
          return ok(
            await files.exists(key, bulkOpts(concurrency, stopOnError))
          );
        }
        const exists = await files.exists(key);
        return ok({ exists, key });
      } catch (error) {
        return errorPayload(error);
      }
    }
  );

  if (allowWrites) {
    server.registerTool(
      "delete",
      {
        description:
          "Permanently delete the object at `key`. Pass an array of keys to delete many in one call — that form returns a structured `{ deleted, errors? }` result instead of throwing on partial failure.",
        inputSchema: {
          concurrency: concurrencyArg,
          key: z.union([z.string(), z.array(z.string())]),
          stopOnError: stopOnErrorArg,
        },
        title: "Delete one or many keys",
      },
      async ({ key, concurrency, stopOnError }) => {
        try {
          if (Array.isArray(key)) {
            return ok(
              await files.delete(key, bulkOpts(concurrency, stopOnError))
            );
          }
          await files.delete(key);
          return ok({ deleted: true, key });
        } catch (error) {
          return errorPayload(error);
        }
      }
    );

    server.registerTool(
      "copy",
      {
        description: "Copy `from` to `to` within the same store.",
        inputSchema: { from: z.string(), to: z.string() },
        title: "Server-side copy",
      },
      async ({ from, to }) => {
        try {
          await files.copy(from, to);
          return ok({ copied: true, from, to });
        } catch (error) {
          return errorPayload(error);
        }
      }
    );

    server.registerTool(
      "move",
      {
        description:
          "Move (rename) `from` to `to` within the same store. Native rename where supported, else copy + delete.",
        inputSchema: { from: z.string(), to: z.string() },
        title: "Move object",
      },
      async ({ from, to }) => {
        try {
          await files.move(from, to);
          return ok({ from, moved: true, to });
        } catch (error) {
          return errorPayload(error);
        }
      }
    );
  }

  server.registerTool(
    "list",
    {
      description:
        "List up to `limit` objects under an optional `prefix`. Paginated via `cursor`. Pass `all: true` to walk every page (following the cursor) and return all items at once.",
      inputSchema: {
        all: z
          .boolean()
          .optional()
          .describe(
            "Walk every page and return all items (ignores cursor paging)"
          ),
        cursor: z.string().optional(),
        limit: z.number().int().positive().optional(),
        prefix: z.string().optional(),
      },
      title: "List objects",
    },
    async ({ prefix, cursor, limit, all }) => {
      try {
        if (all) {
          const items: ReturnType<typeof storedFileToJson>[] = [];
          for await (const file of files.listAll({ cursor, limit, prefix })) {
            items.push(storedFileToJson(file));
          }
          return ok({ items });
        }
        const result = await files.list({ cursor, limit, prefix });
        return ok({
          cursor: result.cursor,
          items: result.items.map(storedFileToJson),
        });
      } catch (error) {
        return errorPayload(error);
      }
    }
  );

  server.registerTool(
    "url",
    {
      description:
        "Return a URL for `key` — presigned on signing adapters, public on CDN-backed ones.",
      inputSchema: {
        expiresIn: z.number().int().positive().optional(),
        key: z.string(),
        responseContentDisposition: z.string().optional(),
      },
      title: "Build a URL",
    },
    async ({ key, expiresIn, responseContentDisposition }) => {
      try {
        const url = await files.url(key, {
          expiresIn,
          responseContentDisposition,
        });
        return ok({ key, url });
      } catch (error) {
        return errorPayload(error);
      }
    }
  );

  if (allowWrites) {
    server.registerTool(
      "sign-upload",
      {
        description:
          "Produce a presigned upload URL/form. `maxSize` enables a POST policy (recommended).",
        inputSchema: {
          contentType: z.string().optional(),
          expiresIn: z.number().int().positive(),
          key: z.string(),
          maxSize: z.number().int().positive().optional(),
          minSize: z.number().int().nonnegative().optional(),
        },
        title: "Sign an upload URL",
      },
      async ({ key, expiresIn, contentType, maxSize, minSize }) => {
        try {
          const signed = await files.signedUploadUrl(key, {
            contentType,
            expiresIn,
            maxSize,
            minSize,
          });
          return ok({ key, ...signed });
        } catch (error) {
          return errorPayload(error);
        }
      }
    );

    server.registerTool(
      "transfer",
      {
        description:
          "Copy every object from the configured (source) provider to another provider, streaming each body across backends. The destination is a separate provider config (`to`). Returns `{ transferred, skipped?, errors? }`.",
        inputSchema: {
          concurrency: concurrencyArg,
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Page size for the source walk"),
          overwrite: z
            .boolean()
            .optional()
            .describe(
              "When false, skip keys already present at the destination"
            ),
          prefix: z
            .string()
            .optional()
            .describe("Only transfer keys under this prefix"),
          stopOnError: stopOnErrorArg,
          to: z
            .record(z.string(), z.unknown())
            .describe(
              'Destination provider options, e.g. { "provider": "r2", "bucket": "new", "accountId": "..." }'
            ),
        },
        title: "Transfer objects to another provider",
      },
      async ({ to, prefix, overwrite, limit, concurrency, stopOnError }) => {
        try {
          const dest = await loadFiles(to as unknown as GlobalCliOptions);
          const result = await transfer(files, dest.files, {
            ...(prefix !== undefined && { prefix }),
            ...(overwrite === false && { overwrite: false }),
            ...(limit !== undefined && { limit }),
            ...(concurrency !== undefined && { concurrency }),
            ...(stopOnError && { stopOnError: true }),
          });
          return ok(result);
        } catch (error) {
          return errorPayload(error);
        }
      }
    );
  }

  return server;
};

/**
 * Start an MCP server on stdio. Builds the server (binding provider +
 * credentials, registering tools) and connects it to a stdio transport so the
 * host agent can drive it.
 */
export const startMcpServer = async (opts: McpServerOpts): Promise<void> => {
  const server = await buildMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
};
