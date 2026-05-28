import { createRequire } from "node:module";

import { Command, Option } from "commander";

import {
  runCopy,
  runDelete,
  runDownload,
  runExists,
  runHead,
  runList,
  runMove,
  runSignUpload,
  runTransfer,
  runUpload,
  runUrl,
} from "./commands.js";
import type { CommonRunOpts } from "./commands.js";
import { fail, parseJson } from "./io.js";
import type { OutputOpts } from "./io.js";
import type { GlobalCliOptions } from "./loader.js";
// Type-only — runtime load is the dynamic `import("./mcp.js")` below so the
// optional `@modelcontextprotocol/sdk` dep stays lazy.
import type * as McpModule from "./mcp.js";
import { PROVIDER_NAMES } from "./registry.js";

const pkg = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};
const VERSION = pkg.version;

const intArg = (raw: string): number => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new TypeError(`expected an integer, got: ${raw}`);
  }
  return n;
};

const collect = (value: string, prev: string[] | undefined): string[] => {
  const arr = prev ?? [];
  arr.push(value);
  return arr;
};

// Pulled out so the missing-optional-dep branch is unit-testable without
// having to make `await import("./mcp.js")` reject — Bun's `mock.module`
// factory can't cleanly model a rejecting dynamic import across test files.
export const rewrapMcpLoadError = (loadError: unknown): Error => {
  const { code } = (loadError ?? {}) as NodeJS.ErrnoException;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return new Error(
      "the `mcp` subcommand requires `@modelcontextprotocol/sdk` — install it with `npm install @modelcontextprotocol/sdk`",
      { cause: loadError }
    );
  }
  return loadError as Error;
};

// commander has no first-class "groups" — labels are achieved by tagging each
// flag's description with a bracketed prefix so `--help` sorts visually.
const G = {
  AZURE: "[azure]",
  BACKBLAZE: "[backblaze-b2]",
  COMMON: "[common]",
  FS: "[fs]",
  GCS: "[gcs]",
  NETLIFY: "[netlify-blobs]",
  OUTPUT: "[output]",
  R2: "[r2]",
  S3: "[s3-family]",
  SHARED: "[multi-provider]",
  SUPABASE: "[supabase]",
  VERCEL: "[vercel-blob]",
} as const;

const buildGlobal = (program: Command): void => {
  program
    .option(
      "--provider <name>",
      `${G.COMMON} storage provider (one of: ${PROVIDER_NAMES.join(", ")}) — falls back to FILES_SDK_PROVIDER`
    )
    .option(
      "--config-json <json>",
      `${G.COMMON} raw adapter options as JSON (escape hatch for the long tail)`
    )
    .option(
      "--key-prefix <prefix>",
      `${G.COMMON} scope every operation under this key prefix (instance prefix; distinct from the per-call \`list --prefix\` filter)`
    )
    .option(
      "--timeout <ms>",
      `${G.COMMON} per-attempt timeout in milliseconds`,
      intArg
    )
    .option(
      "--retries <n>",
      `${G.COMMON} retry provider failures up to n times`,
      intArg
    )
    // S3 family + GCS-style buckets
    .option(
      "--bucket <name>",
      `${G.SHARED} bucket / container name (S3 family, GCS, Supabase, Azure via --container)`
    )
    .option("--region <region>", `${G.S3} region (S3 family, GCS)`)
    .option(
      "--endpoint <url>",
      `${G.S3} endpoint override (MinIO, IBM COS, Akamai, Oracle, custom S3-compatibles)`
    )
    .option("--force-path-style", `${G.S3} force path-style URLs`)
    .option("--access-key-id <id>", `${G.S3} access key id`)
    .option("--secret-access-key <secret>", `${G.S3} secret access key`)
    .option("--session-token <token>", `${G.S3} STS session token`)
    .option(
      "--public-base-url <url>",
      `${G.SHARED} origin for url() — skip signing (S3 family, R2, GCS, Azure, Supabase)`
    )
    .option(
      "--default-url-expires-in <seconds>",
      `${G.SHARED} default url() expiry (signing adapters)`,
      intArg
    )
    // Filesystem
    .option("--root <dir>", `${G.FS} filesystem adapter root directory`)
    .option("--url-base-url <url>", `${G.FS} url() prefix`)
    // Token-based providers
    .option(
      "--token <token>",
      `${G.SHARED} API token (vercel-blob, netlify-blobs, uploadthing, dropbox)`
    )
    .addOption(
      new Option("--access <mode>", `${G.VERCEL} access mode`).choices([
        "public",
        "private",
      ])
    )
    // Azure
    .option("--account-name <name>", `${G.AZURE} storage account name`)
    .option("--account-key <key>", `${G.AZURE} storage account key`)
    .option("--container <name>", `${G.AZURE} container name`)
    .option("--connection-string <conn>", `${G.AZURE} connection string`)
    // Netlify Blobs
    .option("--site-id <id>", `${G.NETLIFY} site id`)
    .option("--store-name <name>", `${G.NETLIFY} store name`)
    // Cloudflare R2
    .option("--account-id <id>", `${G.R2} Cloudflare account id`)
    // Supabase
    .option("--url <url>", `${G.SUPABASE} project URL`)
    .option("--service-role-key <key>", `${G.SUPABASE} service role key`)
    // Backblaze B2 (native key flow; S3-compat path uses --access-key-id)
    .option("--application-key-id <id>", `${G.BACKBLAZE} application key id`)
    .option("--application-key <key>", `${G.BACKBLAZE} application key`)
    // Google Cloud Storage
    .option("--project-id <id>", `${G.GCS} project id`)
    .option("--key-filename <path>", `${G.GCS} service-account key file`)
    // output / behavior
    .option("--no-json", `${G.OUTPUT} human-readable output instead of JSON`)
    .option("--pretty", `${G.OUTPUT} indent JSON output`)
    .option(
      "--verbose",
      `${G.OUTPUT} include extra detail (stack traces, request info)`
    )
    .option(
      "--dry-run",
      `${G.OUTPUT} print what would happen without making network calls`
    );
};

interface RawGlobalFlags {
  provider?: string;
  configJson?: string;
  keyPrefix?: string;
  timeout?: number;
  retries?: number;
  bucket?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  publicBaseUrl?: string;
  defaultUrlExpiresIn?: number;
  root?: string;
  urlBaseUrl?: string;
  token?: string;
  access?: "public" | "private";
  accountName?: string;
  accountKey?: string;
  container?: string;
  connectionString?: string;
  siteId?: string;
  storeName?: string;
  accountId?: string;
  url?: string;
  serviceRoleKey?: string;
  applicationKeyId?: string;
  applicationKey?: string;
  projectId?: string;
  keyFilename?: string;
  json?: boolean;
  pretty?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
}

const resolveOpts = (
  cmd: Command
): { global: GlobalCliOptions; out: OutputOpts; dryRun: boolean } => {
  // commander merges parent options when getOptionValue is called on the
  // child — use opts() which walks the chain
  const raw = cmd.optsWithGlobals<RawGlobalFlags>();
  const global: GlobalCliOptions = {
    access: raw.access,
    accessKeyId: raw.accessKeyId,
    accountId: raw.accountId,
    accountKey: raw.accountKey,
    accountName: raw.accountName,
    applicationKey: raw.applicationKey,
    applicationKeyId: raw.applicationKeyId,
    bucket: raw.bucket,
    configJson: parseJson<Record<string, unknown>>(raw.configJson),
    connectionString: raw.connectionString,
    container: raw.container,
    defaultUrlExpiresIn: raw.defaultUrlExpiresIn,
    endpoint: raw.endpoint,
    forcePathStyle: raw.forcePathStyle,
    keyFilename: raw.keyFilename,
    prefix: raw.keyPrefix,
    projectId: raw.projectId,
    provider: raw.provider,
    publicBaseUrl: raw.publicBaseUrl,
    region: raw.region,
    retries: raw.retries,
    root: raw.root,
    secretAccessKey: raw.secretAccessKey,
    serviceRoleKey: raw.serviceRoleKey,
    sessionToken: raw.sessionToken,
    siteId: raw.siteId,
    storeName: raw.storeName,
    timeout: raw.timeout,
    token: raw.token,
    url: raw.url,
    urlBaseUrl: raw.urlBaseUrl,
  };
  const out: OutputOpts = {
    json: raw.json !== false,
    pretty: raw.pretty === true,
    verbose: raw.verbose === true,
  };
  return { dryRun: raw.dryRun === true, global, out };
};

const wrap =
  (
    fn: (opts: never) => Promise<void>,
    buildOpts: (
      args: unknown[],
      common: CommonRunOpts,
      cmd: Command
    ) => CommonRunOpts
  ) =>
  async (...args: unknown[]): Promise<void> => {
    const cmd = args.at(-1) as Command;
    const { global, out, dryRun } = resolveOpts(cmd);
    const common: CommonRunOpts = { ...out, dryRun, global };
    try {
      const merged = buildOpts(args, common, cmd);
      await fn(merged as never);
    } catch (error) {
      fail(error, out);
    }
  };

const bulkBuilder = (args: unknown[], common: CommonRunOpts): CommonRunOpts => {
  const [keys, opts] = args as [string[], Record<string, unknown>];
  return {
    ...common,
    concurrency: opts.concurrency as number | undefined,
    keys,
    stopOnError: opts.stopOnError as boolean | undefined,
  } as CommonRunOpts;
};

export const buildProgram = (): Command => {
  const program = new Command();
  program
    .name("files")
    .description(
      "agent-friendly CLI for files-sdk — uniform interface over 30+ object storage providers"
    )
    .version(VERSION)
    .showHelpAfterError();

  buildGlobal(program);

  program
    .command("upload [key]")
    .description(
      "upload a file (body via --file or --stdin), or a whole directory via --dir"
    )
    .addOption(
      new Option("--file <path>", "read body from this file").conflicts([
        "stdin",
        "dir",
      ])
    )
    .addOption(
      new Option("--stdin", "read body from stdin").conflicts(["file", "dir"])
    )
    .addOption(
      new Option(
        "--dir <localDir>",
        "upload every file under this directory, keyed by relative path"
      ).conflicts(["file", "stdin"])
    )
    .option("--content-type <type>", "MIME content type")
    .option("--cache-control <value>", "Cache-Control header")
    .option(
      "--metadata <kv...>",
      "metadata as key=value pairs (repeatable)",
      collect
    )
    .option("--multipart", "upload in parallel parts")
    .option(
      "--part-size <bytes>",
      "multipart part size in bytes (implies --multipart)",
      intArg
    )
    .option(
      "--multipart-concurrency <n>",
      "parts uploaded in parallel (implies --multipart)",
      intArg
    )
    .option("--concurrency <n>", "parallel uploads for --dir", intArg)
    .option("--stop-on-error", "stop at the first failure (--dir)")
    .action(
      wrap(runUpload as (opts: never) => Promise<void>, (args, common) => {
        const [key, opts] = args as [
          string | undefined,
          Record<string, unknown>,
        ];
        return {
          ...common,
          cacheControl: opts.cacheControl as string | undefined,
          concurrency: opts.concurrency as number | undefined,
          contentType: opts.contentType as string | undefined,
          dir: opts.dir as string | undefined,
          file: opts.file as string | undefined,
          key,
          metadata: opts.metadata as readonly string[] | undefined,
          multipart: opts.multipart as boolean | undefined,
          multipartConcurrency: opts.multipartConcurrency as number | undefined,
          partSize: opts.partSize as number | undefined,
          stdin: opts.stdin as boolean | undefined,
          stopOnError: opts.stopOnError as boolean | undefined,
        } as CommonRunOpts;
      })
    );

  program
    .command("download <keys...>")
    .description(
      "download one key (--out <path> or --stdout) or many (--out-dir <dir>)"
    )
    .addOption(
      new Option("--out <path>", "write body to this file").conflicts([
        "stdout",
        "outDir",
      ])
    )
    .addOption(
      new Option("--stdout", "stream body to stdout").conflicts([
        "out",
        "outDir",
      ])
    )
    .addOption(
      new Option(
        "--out-dir <dir>",
        "write each key under this directory (for many keys)"
      ).conflicts(["out", "stdout"])
    )
    .option(
      "--range <start-end>",
      "download a byte range (0-based, inclusive), e.g. 0-1023 or 1024- (single key)"
    )
    .option("--concurrency <n>", "parallel downloads for many keys", intArg)
    .option("--stop-on-error", "stop at the first failure (many keys)")
    .action(
      wrap(runDownload as (opts: never) => Promise<void>, (args, common) => {
        const [keys, opts] = args as [string[], Record<string, unknown>];
        return {
          ...common,
          concurrency: opts.concurrency as number | undefined,
          keys,
          out: opts.out as string | undefined,
          outDir: opts.outDir as string | undefined,
          range: opts.range as string | undefined,
          stdout: opts.stdout as boolean | undefined,
          stopOnError: opts.stopOnError as boolean | undefined,
        } as CommonRunOpts;
      })
    );

  program
    .command("head <keys...>")
    .description(
      "fetch object metadata (no body); one key throws on failure, many returns a structured result and exits non-zero on any failure"
    )
    .option("--concurrency <n>", "parallel lookups for many keys", intArg)
    .option("--stop-on-error", "stop at the first failure (many keys)")
    .action(wrap(runHead as (opts: never) => Promise<void>, bulkBuilder));

  program
    .command("exists <keys...>")
    .description(
      "check whether keys exist (one key: exit 0 = exists, 1 = missing; many: exit 0 only if every key exists)"
    )
    .option("--concurrency <n>", "parallel checks for many keys", intArg)
    .option("--stop-on-error", "stop at the first hard error (many keys)")
    .action(wrap(runExists as (opts: never) => Promise<void>, bulkBuilder));

  program
    .command("delete <keys...>")
    .description(
      "delete one or many objects (one key throws on failure; many returns a structured result and exits non-zero on any failure; idempotency is adapter-dependent)"
    )
    .option("--concurrency <n>", "parallel deletes for many keys", intArg)
    .option("--stop-on-error", "stop at the first failure (many keys)")
    .action(wrap(runDelete as (opts: never) => Promise<void>, bulkBuilder));

  program
    .command("copy <from> <to>")
    .description("server-side copy from one key to another")
    .action(
      wrap(runCopy as (opts: never) => Promise<void>, (args, common) => {
        const [from, to] = args as [string, string];
        return { ...common, from, to } as CommonRunOpts;
      })
    );

  program
    .command("move <from> <to>")
    .description(
      "move (rename) a key — native rename where supported, else copy + delete"
    )
    .action(
      wrap(runMove as (opts: never) => Promise<void>, (args, common) => {
        const [from, to] = args as [string, string];
        return { ...common, from, to } as CommonRunOpts;
      })
    );

  program
    .command("list")
    .description("list objects (optionally under --prefix, paginated)")
    .option("--prefix <prefix>", "filter by key prefix")
    .option("--cursor <cursor>", "continuation cursor from a prior page")
    .option(
      "--limit <n>",
      "max items per page (page size, not a total cap)",
      intArg
    )
    .option(
      "--all",
      "walk every page, following the cursor, and return all items"
    )
    .action(
      wrap(runList as (opts: never) => Promise<void>, (args, common) => {
        const [opts] = args as [Record<string, unknown>];
        return {
          ...common,
          all: opts.all as boolean | undefined,
          cursor: opts.cursor as string | undefined,
          limit: opts.limit as number | undefined,
          prefix: opts.prefix as string | undefined,
        } as CommonRunOpts;
      })
    );

  program
    .command("url <key>")
    .description("build a URL (presigned for signing adapters)")
    .option("--expires-in <seconds>", "presigned URL expiry", intArg)
    .option(
      "--response-content-disposition <value>",
      "force Content-Disposition on the response (forces signing path)"
    )
    .action(
      wrap(runUrl as (opts: never) => Promise<void>, (args, common) => {
        const [key, opts] = args as [string, Record<string, unknown>];
        return {
          ...common,
          expiresIn: opts.expiresIn as number | undefined,
          key,
          responseContentDisposition: opts.responseContentDisposition as
            | string
            | undefined,
        } as CommonRunOpts;
      })
    );

  program
    .command("sign-upload <key>")
    .description("produce a presigned upload URL/form")
    .requiredOption("--expires-in <seconds>", "URL expiry (required)", intArg)
    .option("--content-type <type>", "expected upload content type")
    .option(
      "--max-size <bytes>",
      "max upload size (enables POST policy)",
      intArg
    )
    .option(
      "--min-size <bytes>",
      "min upload size (only used with --max-size)",
      intArg
    )
    .action(
      wrap(runSignUpload as (opts: never) => Promise<void>, (args, common) => {
        const [key, opts] = args as [string, Record<string, unknown>];
        return {
          ...common,
          contentType: opts.contentType as string | undefined,
          expiresIn: opts.expiresIn as number,
          key,
          maxSize: opts.maxSize as number | undefined,
          minSize: opts.minSize as number | undefined,
        } as CommonRunOpts;
      })
    );

  program
    .command("transfer")
    .description(
      "copy every object from the configured (source) provider to another (--to), streaming each body across backends"
    )
    .requiredOption(
      "--to <json>",
      'destination provider options as JSON (same shape as the global flags, e.g. \'{"provider":"r2","bucket":"new","accountId":"..."}\')'
    )
    .option("--prefix <prefix>", "only transfer keys under this prefix")
    .option("--no-overwrite", "skip keys already present at the destination")
    .option("--limit <n>", "page size for the source walk", intArg)
    .option("--concurrency <n>", "parallel transfers", intArg)
    .option("--stop-on-error", "stop at the first failure")
    .action(
      wrap(runTransfer as (opts: never) => Promise<void>, (args, common) => {
        const [opts] = args as [Record<string, unknown>];
        return {
          ...common,
          concurrency: opts.concurrency as number | undefined,
          limit: opts.limit as number | undefined,
          overwrite: opts.overwrite as boolean | undefined,
          prefix: opts.prefix as string | undefined,
          stopOnError: opts.stopOnError as boolean | undefined,
          to: opts.to as string,
        } as CommonRunOpts;
      })
    );

  program
    .command("mcp")
    .description(
      "start an MCP server on stdio exposing every command as a tool"
    )
    .action(async (_opts, cmd) => {
      const { global, out } = resolveOpts(cmd as Command);
      try {
        // `@modelcontextprotocol/sdk` is an optional dependency — pulling
        // it in lazily means library-only consumers don't pay the install
        // cost. If it's missing, give a clearer hint than the raw
        // ERR_MODULE_NOT_FOUND.
        let mcp: typeof McpModule;
        try {
          mcp = await import("./mcp.js");
        } catch (loadError) {
          throw rewrapMcpLoadError(loadError);
        }
        await mcp.startMcpServer({ global });
      } catch (error) {
        fail(error, out);
      }
    });

  return program;
};
