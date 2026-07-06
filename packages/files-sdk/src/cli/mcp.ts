import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { sync, transfer } from "../index.js";
import { rangedSize } from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { filesErrorReplacer, storedFileToJson } from "./io.js";
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
  stopOnError = false
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
  destination?: GlobalCliOptions;
  global: GlobalCliOptions;
}

const ok = (data: unknown) => ({
  // filesErrorReplacer keeps bulk partial-failure errors useful (message is
  // non-enumerable) and strips the provider `cause` from the MCP boundary.
  content: [
    {
      text: JSON.stringify(data, filesErrorReplacer, 2),
      type: "text" as const,
    },
  ],
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

  const [source, destination] = await Promise.all([
    loadFiles(opts.global),
    opts.destination ? loadFiles(opts.destination) : Promise.resolve(),
  ]);
  const { files } = source;
  const destinationFiles = destination?.files;
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
    "capabilities",
    {
      description:
        "Report what the configured adapter can do — range reads, native upload progress, list delimiters, user metadata, cache-control, multipart/resumable uploads, server-side copy, and signed URLs (`supported` plus any `maxExpiresIn` cap). Pure introspection; makes no provider call. Branch on this instead of catching an unsupported-operation error.",
      inputSchema: {},
      title: "Adapter capabilities",
    },
    // Pure property read with conservative defaults — it can't throw, so there's
    // no provider error to map here.
    () => ok(files.capabilities)
  );

  server.registerTool(
    "list",
    {
      description:
        'List up to `limit` objects under an optional `prefix`. Paginated via `cursor`. Pass `all: true` to walk every page (following the cursor) and return all items at once. Pass a `delimiter` (e.g. "/") to collapse keys into folders — direct files come back in `items`, subfolders in `prefixes` (throws on adapters with no folder concept; cannot combine with `all`).',
      inputSchema: {
        all: z
          .boolean()
          .optional()
          .describe(
            "Walk every page and return all items (ignores cursor paging)"
          ),
        cursor: z.string().optional(),
        delimiter: z
          .string()
          .optional()
          .describe(
            "Collapse keys at this boundary into folders, returned in `prefixes`"
          ),
        limit: z.number().int().positive().optional(),
        prefix: z.string().optional(),
      },
      title: "List objects",
    },
    async ({ prefix, cursor, limit, delimiter, all }) => {
      try {
        if (all) {
          if (delimiter !== undefined) {
            throw new FilesError(
              "Provider",
              "`delimiter` lists one folder level and `all` walks the whole tree — pass one, not both"
            );
          }
          const items: ReturnType<typeof storedFileToJson>[] = [];
          for await (const file of files.listAll({ cursor, limit, prefix })) {
            items.push(storedFileToJson(file));
          }
          return ok({ items });
        }
        const result = await files.list({
          cursor,
          ...(delimiter !== undefined && { delimiter }),
          limit,
          prefix,
        });
        return ok({
          cursor: result.cursor,
          items: result.items.map(storedFileToJson),
          ...(result.prefixes && { prefixes: result.prefixes }),
        });
      } catch (error) {
        return errorPayload(error);
      }
    }
  );

  server.registerTool(
    "search",
    {
      description:
        'Find objects whose key matches `pattern`. By default `pattern` is a glob (`*` within a path segment, `**` across `/`, `?` one character); set `match` to "regex", "substring", or "exact" to change that. Walks every page, following the cursor. A glob\'s literal prefix is pushed down automatically; for other modes (or a case-insensitive search) pass `prefix` to bound the walk over a large bucket.',
      inputSchema: {
        caseInsensitive: z
          .boolean()
          .optional()
          .describe("Match case-insensitively"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Page size for the underlying walk (not a cap on results)"),
        match: z
          .enum(["glob", "regex", "substring", "exact"])
          .optional()
          .describe("How to interpret `pattern` (default glob)"),
        maxResults: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Stop after this many matches"),
        pattern: z.string(),
        prefix: z
          .string()
          .optional()
          .describe("Scope the walk to this key prefix"),
      },
      title: "Search objects",
    },
    async ({ pattern, match, prefix, limit, maxResults, caseInsensitive }) => {
      try {
        const items: ReturnType<typeof storedFileToJson>[] = [];
        for await (const file of files.search(pattern, {
          caseInsensitive,
          limit,
          match,
          maxResults,
          prefix,
        })) {
          items.push(storedFileToJson(file));
        }
        return ok({ items });
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
  }

  if (allowWrites && destinationFiles) {
    server.registerTool(
      "transfer",
      {
        description:
          "Copy every object from the configured source provider to the operator-configured destination provider, streaming each body across backends. Returns `{ transferred, skipped?, errors? }`.",
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
        },
        title: "Transfer objects to another provider",
      },
      async ({ prefix, overwrite, limit, concurrency, stopOnError }) => {
        try {
          const result = await transfer(files, destinationFiles, {
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

    server.registerTool(
      "sync",
      {
        description:
          "Mirror the configured source provider onto the operator-configured destination: upload new or changed objects, skip unchanged ones, and (with `prune`) delete destination keys the source no longer has. Set `dryRun` to preview the plan without mutating. Returns `{ uploaded, skipped, deleted?, errors? }`.",
        inputSchema: {
          compare: z
            .enum(["etag", "size"])
            .optional()
            .describe(
              "Change detection: 'etag' (size + etag, default) or 'size' (byte length only — for cross-provider mirrors)"
            ),
          concurrency: concurrencyArg,
          destPrefix: z
            .string()
            .optional()
            .describe(
              "Scope the destination walk (compare + prune) to this prefix (defaults to prefix)"
            ),
          dryRun: z
            .boolean()
            .optional()
            .describe(
              "Compute the reconciliation plan without uploading or deleting anything"
            ),
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Page size for the source and destination walks"),
          prefix: z
            .string()
            .optional()
            .describe("Only mirror keys under this prefix"),
          prune: z
            .boolean()
            .optional()
            .describe(
              "Mirror mode: delete destination keys the source no longer has (destructive)"
            ),
          stopOnError: stopOnErrorArg,
        },
        title: "Mirror objects to another provider",
      },
      async ({
        prefix,
        destPrefix,
        prune,
        compare,
        dryRun,
        limit,
        concurrency,
        stopOnError,
      }) => {
        try {
          const result = await sync(files, destinationFiles, {
            ...(prefix !== undefined && { prefix }),
            ...(destPrefix !== undefined && { destPrefix }),
            ...(prune && { prune: true }),
            ...(compare !== undefined && { compare }),
            ...(dryRun && { dryRun: true }),
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
 * host agent can drive it. The transport factory is injectable so tests can
 * supply an inert stand-in instead of one that attaches to process.stdin.
 */
export const startMcpServer = async (
  opts: McpServerOpts,
  createTransport?: () => Transport
): Promise<void> => {
  const server = await buildMcpServer(opts);
  await server.connect(
    createTransport ? createTransport() : new StdioServerTransport()
  );
};
