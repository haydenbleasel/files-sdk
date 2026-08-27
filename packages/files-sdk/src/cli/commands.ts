import type {
  BulkOptions,
  CopyCondition,
  MultipartOptions,
  SearchMatch,
  UploadCondition,
  UploadManyItem,
} from "../index.js";
import { sync, transfer } from "../index.js";
import { FilesError } from "../internal/errors.js";
import { inferTypeFromName } from "../internal/mime.js";
import {
  emit,
  exitCode,
  fileBodyStream,
  parseJson,
  parseKeyValuePairs,
  parseRange,
  readBody,
  storedFileToJson,
  walkDir,
  writeBody,
  writeBodyToDir,
} from "./io.js";
import type { OutputOpts } from "./io.js";
import { describeProvider, loadFiles } from "./loader.js";
import type { GlobalCliOptions } from "./loader.js";

/**
 * Resolve the `--multipart` / `--part-size` / `--multipart-concurrency` flags
 * into the SDK's `boolean | MultipartOptions` shape. Any tuning flag implies
 * multipart even without the bare `--multipart`; absent everything, returns
 * `undefined` so the adapter's default single-PUT path stands.
 */
const buildMultipart = (opts: {
  multipart?: boolean;
  partSize?: number;
  multipartConcurrency?: number;
}): boolean | MultipartOptions | undefined => {
  const tuning: MultipartOptions = {};
  if (opts.partSize !== undefined) {
    tuning.partSize = opts.partSize;
  }
  if (opts.multipartConcurrency !== undefined) {
    tuning.concurrency = opts.multipartConcurrency;
  }
  if (Object.keys(tuning).length > 0) {
    return tuning;
  }
  return opts.multipart ? true : undefined;
};

/** The bulk-fanout knobs (`--concurrency` / `--stop-on-error`) as `BulkOptions`. */
const buildBulkOptions = (opts: {
  concurrency?: number;
  stopOnError?: boolean;
}): BulkOptions | undefined => {
  const bulk: BulkOptions = {};
  if (opts.concurrency !== undefined) {
    bulk.concurrency = opts.concurrency;
  }
  if (opts.stopOnError) {
    bulk.stopOnError = true;
  }
  return Object.keys(bulk).length > 0 ? bulk : undefined;
};

export interface CommonRunOpts extends OutputOpts {
  dryRun: boolean;
  global: GlobalCliOptions;
}

const dryRun = (action: string, detail: unknown, opts: CommonRunOpts): void => {
  emit(
    {
      action,
      dryRun: true,
      provider: describeProvider(opts.global),
      ...(detail as Record<string, unknown>),
    },
    opts
  );
};

export interface UploadCmdOpts extends CommonRunOpts {
  key?: string;
  file?: string;
  stdin?: boolean;
  dir?: string;
  contentType?: string;
  cacheControl?: string;
  metadata?: readonly string[];
  multipart?: boolean;
  partSize?: number;
  multipartConcurrency?: number;
  concurrency?: number;
  stopOnError?: boolean;
  ifMatch?: string;
  ifNoneMatch?: boolean;
}

/**
 * `--if-none-match` (create only) / `--if-match <etag>` (replace exactly that
 * generation) as the SDK's upload `condition`. Mutually exclusive.
 */
const buildUploadCondition = (opts: {
  ifMatch?: string;
  ifNoneMatch?: boolean;
}): UploadCondition | undefined => {
  if (opts.ifNoneMatch && opts.ifMatch !== undefined) {
    throw new FilesError(
      "Provider",
      "--if-match and --if-none-match are mutually exclusive"
    );
  }
  if (opts.ifNoneMatch) {
    return { type: "create" };
  }
  return opts.ifMatch === undefined
    ? undefined
    : { etag: opts.ifMatch, type: "replace" };
};

/**
 * `--if-match <etag>` (source) plus exactly one of `--if-none-match` (create
 * the destination) / `--dest-if-match <etag>` (replace that destination
 * generation) as the SDK's copy `condition`. A conditional copy needs both
 * halves, so a partial set of flags is an error rather than a weaker request.
 */
const buildCopyCondition = (opts: {
  destIfMatch?: string;
  ifMatch?: string;
  ifNoneMatch?: boolean;
}): CopyCondition | undefined => {
  const hasSource = opts.ifMatch !== undefined;
  const hasCreate = opts.ifNoneMatch === true;
  const hasReplace = opts.destIfMatch !== undefined;
  if (!(hasSource || hasCreate || hasReplace)) {
    return;
  }
  if (hasCreate && hasReplace) {
    throw new FilesError(
      "Provider",
      "--if-none-match and --dest-if-match are mutually exclusive"
    );
  }
  if (!(hasSource && (hasCreate || hasReplace))) {
    throw new FilesError(
      "Provider",
      "a conditional copy needs --if-match <source etag> and either --if-none-match or --dest-if-match <etag>"
    );
  }
  return {
    destination: hasCreate
      ? { type: "create" }
      : { etag: opts.destIfMatch as string, type: "replace" },
    source: { etag: opts.ifMatch as string },
  };
};

const SINGLE_KEY_CONDITION = (flag: string, verb: string): FilesError =>
  new FilesError(
    "Provider",
    `${flag} applies to a single key; conditional ${verb} has no bulk form`
  );

const runUploadDir = async (
  opts: UploadCmdOpts,
  multipart: boolean | MultipartOptions | undefined
): Promise<void> => {
  if (opts.ifMatch !== undefined || opts.ifNoneMatch) {
    throw SINGLE_KEY_CONDITION("--if-match / --if-none-match", "upload");
  }
  if (opts.dryRun) {
    // Local-only preview — don't walk the tree, matching the single-upload
    // dry-run which doesn't stat its --file either.
    return dryRun("upload", { dir: opts.dir, multipart }, opts);
  }
  const metadata = parseKeyValuePairs(opts.metadata);
  const { files } = await loadFiles(opts.global);
  const walked = await walkDir(opts.dir as string);
  // Content type is inferred per-file from the key's extension unless the
  // caller pins one for the whole batch. The body is a lazily-opened stream
  // so the open-fd count stays bounded by upload concurrency, not file count.
  const items: UploadManyItem[] = walked.map((f) => ({
    body: fileBodyStream(f.absPath),
    contentType: opts.contentType ?? inferTypeFromName(f.key),
    key: f.key,
    ...(opts.cacheControl !== undefined && { cacheControl: opts.cacheControl }),
    ...(metadata !== undefined && { metadata }),
    ...(multipart !== undefined && { multipart }),
  }));
  const result = await files.upload(items, buildBulkOptions(opts));
  emit(
    {
      uploaded: result.uploaded,
      ...(result.errors && { errors: result.errors }),
    },
    opts
  );
  if (result.errors?.length) {
    // Set the exit code rather than exiting: process.exit() right after a
    // large emit() can truncate piped stdout mid-payload (POSIX pipe writes
    // are asynchronous). The process ends once stdout drains.
    process.exitCode = exitCode(result.errors[0]?.error.code ?? "Provider");
  }
};

export const runUpload = async (opts: UploadCmdOpts): Promise<void> => {
  const multipart = buildMultipart(opts);
  const condition = buildUploadCondition(opts);

  // --dir uploads a whole local tree via the SDK's bulk array form. It's
  // mutually exclusive with the single-object inputs (a key, --file, --stdin).
  if (opts.dir !== undefined) {
    if (opts.key !== undefined || opts.file !== undefined || opts.stdin) {
      throw new FilesError(
        "Provider",
        "--dir cannot be combined with a <key>, --file, or --stdin"
      );
    }
    return runUploadDir(opts, multipart);
  }

  if (opts.key === undefined) {
    throw new FilesError(
      "Provider",
      "expected a <key> (or --dir to upload a directory)"
    );
  }
  const { key } = opts;

  if (opts.dryRun) {
    return dryRun(
      "upload",
      {
        cacheControl: opts.cacheControl,
        condition,
        contentType: opts.contentType,
        key,
        metadata: parseKeyValuePairs(opts.metadata),
        multipart,
        source: opts.stdin ? "<stdin>" : opts.file,
      },
      opts
    );
  }
  const { files } = await loadFiles(opts.global);
  const { body } = await readBody({ file: opts.file, stdin: opts.stdin });
  const result = await files.upload(key, body, {
    cacheControl: opts.cacheControl,
    contentType: opts.contentType,
    metadata: parseKeyValuePairs(opts.metadata),
    ...(multipart !== undefined && { multipart }),
    ...(condition !== undefined && { condition }),
  });
  emit(result, opts);
};

export interface DownloadCmdOpts extends CommonRunOpts {
  keys: string[];
  out?: string;
  stdout?: boolean;
  outDir?: string;
  range?: string;
  concurrency?: number;
  stopOnError?: boolean;
  ifMatch?: string;
}

const runDownloadMany = async (
  opts: DownloadCmdOpts,
  range: ReturnType<typeof parseRange>
): Promise<void> => {
  // --out and --stdout name a single destination; the per-object byte range
  // has no meaning across many keys. Both are single-key only.
  if (opts.out !== undefined || opts.stdout) {
    throw new FilesError(
      "Provider",
      "--out / --stdout download a single key; use --out-dir for many"
    );
  }
  if (range !== undefined) {
    throw new FilesError(
      "Provider",
      "--range is only supported when downloading a single key"
    );
  }
  if (opts.outDir === undefined) {
    throw new FilesError(
      "Provider",
      "expected --out-dir <dir> when downloading multiple keys"
    );
  }
  const { files } = await loadFiles(opts.global);
  const result = await files.download(opts.keys, {
    as: "stream",
    ...buildBulkOptions(opts),
  });
  const downloaded: { key: string; path: string }[] = [];
  for (const file of result.downloaded) {
    // eslint-disable-next-line no-await-in-loop -- stream each downloaded body to disk sequentially to bound open fds/memory.
    const dest = await writeBodyToDir(file, opts.outDir);
    downloaded.push({ key: file.key, path: dest });
  }
  emit(
    {
      downloaded,
      ...(result.errors && { errors: result.errors }),
    },
    opts
  );
  if (result.errors?.length) {
    // Set the exit code rather than exiting: process.exit() right after a
    // large emit() can truncate piped stdout mid-payload (POSIX pipe writes
    // are asynchronous). The process ends once stdout drains.
    process.exitCode = exitCode(result.errors[0]?.error.code ?? "Provider");
  }
};

export const runDownload = async (opts: DownloadCmdOpts): Promise<void> => {
  const range = parseRange(opts.range);
  const condition =
    opts.ifMatch === undefined ? undefined : { etag: opts.ifMatch };
  // Many keys (or an explicit --out-dir) take the bulk path: each body is
  // written under the directory at the path its key implies.
  const many = opts.keys.length > 1 || opts.outDir !== undefined;
  if (many && condition !== undefined) {
    throw SINGLE_KEY_CONDITION("--if-match", "download");
  }

  if (opts.dryRun) {
    if (many) {
      return dryRun(
        "download",
        { keys: opts.keys, outDir: opts.outDir, range },
        opts
      );
    }
    return dryRun(
      "download",
      {
        condition,
        dest: opts.stdout ? "<stdout>" : opts.out,
        key: opts.keys[0],
        range,
      },
      opts
    );
  }

  if (many) {
    return runDownloadMany(opts, range);
  }

  const key = opts.keys[0] as string;
  const { files } = await loadFiles(opts.global);
  const file = await files.download(key, {
    as: "stream",
    range,
    ...(condition !== undefined && { condition }),
  });
  await writeBody(file, { out: opts.out, stdout: opts.stdout });
  if (!opts.stdout) {
    // body went to a file; emit status to stdout in the user's chosen format
    emit(storedFileToJson(file), opts);
  } else if (opts.verbose) {
    // body went to stdout; metadata goes to stderr so it doesn't pollute
    // the byte stream. Honor --no-json: humans get key=value lines, JSON
    // mode gets the same envelope it would on stdout.
    const meta = storedFileToJson(file);
    if (opts.json) {
      const text = opts.pretty
        ? JSON.stringify(meta, null, 2)
        : JSON.stringify(meta);
      process.stderr.write(`${text}\n`);
    } else {
      process.stderr.write(`${JSON.stringify(meta, null, 2)}\n`);
    }
  }
};

export interface HeadCmdOpts extends CommonRunOpts {
  keys: string[];
  concurrency?: number;
  stopOnError?: boolean;
}

export const runHead = async (opts: HeadCmdOpts): Promise<void> => {
  if (opts.dryRun) {
    return dryRun("head", { keys: opts.keys }, opts);
  }
  const { files } = await loadFiles(opts.global);

  // One key keeps the original throw-on-failure contract and output shape.
  if (opts.keys.length === 1) {
    const file = await files.head(opts.keys[0] as string);
    emit(storedFileToJson(file), opts);
    return;
  }

  // Many keys return a structured result instead of throwing on partial
  // failure. Surface that failure to scripts via a non-zero exit code,
  // mapped from the first error like the single-key path does.
  const result = await files.head(opts.keys, buildBulkOptions(opts));
  emit(
    {
      files: result.files.map(storedFileToJson),
      ...(result.errors && { errors: result.errors }),
    },
    opts
  );
  if (result.errors?.length) {
    // Set the exit code rather than exiting: process.exit() right after a
    // large emit() can truncate piped stdout mid-payload (POSIX pipe writes
    // are asynchronous). The process ends once stdout drains.
    process.exitCode = exitCode(result.errors[0]?.error.code ?? "Provider");
  }
};

export interface ExistsCmdOpts extends CommonRunOpts {
  keys: string[];
  concurrency?: number;
  stopOnError?: boolean;
}

export const runExists = async (opts: ExistsCmdOpts): Promise<void> => {
  if (opts.dryRun) {
    return dryRun("exists", { keys: opts.keys }, opts);
  }
  const { files } = await loadFiles(opts.global);

  // One key keeps the original { exists, key } shape and `test -e` exit code.
  if (opts.keys.length === 1) {
    const key = opts.keys[0] as string;
    const exists = await files.exists(key);
    emit({ exists, key }, opts);
    if (!exists) {
      // exit 1 = missing, matches `test -e` convention. Set the code rather
      // than exiting so stdout drains first.
      process.exitCode = 1;
    }
    return;
  }

  // Many keys: a structured existing/missing split. A hard error (auth,
  // transport) exits with its mapped code; otherwise any missing key exits 1,
  // scaling the single-key `test -e` convention to "all keys must exist".
  const result = await files.exists(opts.keys, buildBulkOptions(opts));
  emit(result, opts);
  if (result.errors?.length) {
    // Set the exit code rather than exiting: process.exit() right after a
    // large emit() can truncate piped stdout mid-payload (POSIX pipe writes
    // are asynchronous). The process ends once stdout drains.
    process.exitCode = exitCode(result.errors[0]?.error.code ?? "Provider");
  }
  if (result.missing.length) {
    process.exitCode = 1;
  }
};

export interface DeleteCmdOpts extends CommonRunOpts {
  keys: string[];
  concurrency?: number;
  stopOnError?: boolean;
  ifMatch?: string;
}

export const runDelete = async (opts: DeleteCmdOpts): Promise<void> => {
  const condition =
    opts.ifMatch === undefined ? undefined : { etag: opts.ifMatch };
  if (condition !== undefined && opts.keys.length !== 1) {
    throw SINGLE_KEY_CONDITION("--if-match", "delete");
  }
  if (opts.dryRun) {
    return dryRun("delete", { condition, keys: opts.keys }, opts);
  }
  const { files } = await loadFiles(opts.global);

  // One key keeps the original throw-on-failure contract and output shape.
  if (opts.keys.length === 1) {
    const key = opts.keys[0] as string;
    await files.delete(key, condition ? { condition } : undefined);
    emit({ deleted: true, key }, opts);
    return;
  }

  // Many keys return a structured result instead of throwing on partial
  // failure. Surface that failure to scripts via a non-zero exit code,
  // mapped from the first error like the single-key path does.
  const result = await files.delete(opts.keys, buildBulkOptions(opts));
  emit(result, opts);
  if (result.errors?.length) {
    // Set the exit code rather than exiting: process.exit() right after a
    // large emit() can truncate piped stdout mid-payload (POSIX pipe writes
    // are asynchronous). The process ends once stdout drains.
    process.exitCode = exitCode(result.errors[0]?.error.code ?? "Provider");
  }
};

export interface CopyCmdOpts extends CommonRunOpts {
  from: string;
  to: string;
  ifMatch?: string;
  ifNoneMatch?: boolean;
  destIfMatch?: string;
}

export const runCopy = async (opts: CopyCmdOpts): Promise<void> => {
  const condition = buildCopyCondition(opts);
  if (opts.dryRun) {
    return dryRun("copy", { condition, from: opts.from, to: opts.to }, opts);
  }
  const { files } = await loadFiles(opts.global);
  await files.copy(opts.from, opts.to, condition ? { condition } : undefined);
  emit({ copied: true, from: opts.from, to: opts.to }, opts);
};

export interface MoveCmdOpts extends CommonRunOpts {
  from: string;
  to: string;
}

export const runMove = async (opts: MoveCmdOpts): Promise<void> => {
  if (opts.dryRun) {
    return dryRun("move", { from: opts.from, to: opts.to }, opts);
  }
  const { files } = await loadFiles(opts.global);
  await files.move(opts.from, opts.to);
  emit({ from: opts.from, moved: true, to: opts.to }, opts);
};

export interface ListCmdOpts extends CommonRunOpts {
  prefix?: string;
  cursor?: string;
  limit?: number;
  delimiter?: string;
  all?: boolean;
}

export const runList = async (opts: ListCmdOpts): Promise<void> => {
  if (opts.dryRun) {
    return dryRun(
      "list",
      {
        all: opts.all,
        cursor: opts.cursor,
        delimiter: opts.delimiter,
        limit: opts.limit,
        prefix: opts.prefix,
      },
      opts
    );
  }

  // --delimiter collapses one level into folders; --all walks the whole tree
  // (SDK `listAll` strips delimiter for exactly this reason). They're
  // contradictory, so reject the combination loudly rather than silently
  // dropping one — mirrors how the SDK's listAll ignores delimiter.
  if (opts.all && opts.delimiter !== undefined) {
    throw new FilesError(
      "Provider",
      "--delimiter lists one folder level and --all walks the whole tree — pass one, not both"
    );
  }

  const { files } = await loadFiles(opts.global);

  // --all walks every page transparently (Files.listAll), following the cursor
  // until exhausted. The result has no `cursor` — there's nothing left to page.
  if (opts.all) {
    const items: ReturnType<typeof storedFileToJson>[] = [];
    for await (const file of files.listAll({
      cursor: opts.cursor,
      limit: opts.limit,
      prefix: opts.prefix,
    })) {
      items.push(storedFileToJson(file));
    }
    emit({ items }, opts);
    return;
  }

  const result = await files.list({
    cursor: opts.cursor,
    ...(opts.delimiter !== undefined && { delimiter: opts.delimiter }),
    limit: opts.limit,
    prefix: opts.prefix,
  });
  emit(
    {
      cursor: result.cursor,
      items: result.items.map(storedFileToJson),
      // Mirror the SDK: `prefixes` is present only when a delimiter turned up
      // folders, omitted otherwise.
      ...(result.prefixes && { prefixes: result.prefixes }),
    },
    opts
  );
};

export interface SearchCmdOpts extends CommonRunOpts {
  pattern: string;
  match?: SearchMatch;
  regex?: boolean;
  prefix?: string;
  limit?: number;
  maxResults?: number;
  caseInsensitive?: boolean;
}

export const runSearch = async (opts: SearchCmdOpts): Promise<void> => {
  // `--regex` is shorthand for `--match regex`; otherwise honor `--match`
  // (default glob). Patterns over the CLI/MCP are always strings.
  const match: SearchMatch = opts.regex ? "regex" : (opts.match ?? "glob");

  if (opts.dryRun) {
    return dryRun(
      "search",
      {
        caseInsensitive: opts.caseInsensitive,
        limit: opts.limit,
        match,
        maxResults: opts.maxResults,
        pattern: opts.pattern,
        prefix: opts.prefix,
      },
      opts
    );
  }

  const { files } = await loadFiles(opts.global);

  // search walks every page under the (inferred or explicit) prefix, following
  // the cursor, so the result has no `cursor`. Mirrors `list --all`.
  const items: ReturnType<typeof storedFileToJson>[] = [];
  for await (const file of files.search(opts.pattern, {
    caseInsensitive: opts.caseInsensitive,
    limit: opts.limit,
    match,
    maxResults: opts.maxResults,
    prefix: opts.prefix,
  })) {
    items.push(storedFileToJson(file));
  }
  emit({ items }, opts);
};

export interface UrlCmdOpts extends CommonRunOpts {
  key: string;
  expiresIn?: number;
  responseContentDisposition?: string;
}

export const runUrl = async (opts: UrlCmdOpts): Promise<void> => {
  if (opts.dryRun) {
    return dryRun(
      "url",
      {
        expiresIn: opts.expiresIn,
        key: opts.key,
        responseContentDisposition: opts.responseContentDisposition,
      },
      opts
    );
  }
  const { files } = await loadFiles(opts.global);
  const url = await files.url(opts.key, {
    expiresIn: opts.expiresIn,
    responseContentDisposition: opts.responseContentDisposition,
  });
  emit({ key: opts.key, url }, opts);
};

export const runCapabilities = async (opts: CommonRunOpts): Promise<void> => {
  // Pure introspection of the configured adapter — no provider round-trip, so
  // there's nothing to dry-run.
  const { files } = await loadFiles(opts.global);
  emit(files.capabilities, opts);
};

export interface SignUploadCmdOpts extends CommonRunOpts {
  key: string;
  expiresIn: number;
  contentType?: string;
  maxSize?: number;
  minSize?: number;
}

export const runSignUpload = async (opts: SignUploadCmdOpts): Promise<void> => {
  // commander has already coerced expiresIn to a finite integer via intArg
  // and requiredOption enforces presence — only the sign check is left.
  if (opts.expiresIn <= 0) {
    throw new FilesError(
      "Provider",
      "--expires-in must be a positive number of seconds"
    );
  }
  if (opts.dryRun) {
    return dryRun(
      "sign-upload",
      {
        contentType: opts.contentType,
        expiresIn: opts.expiresIn,
        key: opts.key,
        maxSize: opts.maxSize,
        minSize: opts.minSize,
      },
      opts
    );
  }
  const { files } = await loadFiles(opts.global);
  const signed = await files.signedUploadUrl(opts.key, {
    contentType: opts.contentType,
    expiresIn: opts.expiresIn,
    maxSize: opts.maxSize,
    minSize: opts.minSize,
  });
  emit({ key: opts.key, ...signed }, opts);
};

export interface TransferCmdOpts extends CommonRunOpts {
  /** Destination provider config as JSON — a {@link GlobalCliOptions} blob. */
  to: string;
  prefix?: string;
  /** `false` only when `--no-overwrite` was passed; otherwise overwrite (the default). */
  overwrite?: boolean;
  limit?: number;
  concurrency?: number;
  stopOnError?: boolean;
}

export const runTransfer = async (opts: TransferCmdOpts): Promise<void> => {
  // The source comes from the standard global flags (so the global
  // --key-prefix scopes it); the destination is a separate provider, supplied
  // as a JSON blob of the same option shape.
  const destConfig = parseJson<GlobalCliOptions>(opts.to, "--to");
  if (!destConfig || typeof destConfig !== "object") {
    throw new FilesError(
      "Provider",
      "--to must be a JSON object of destination provider options"
    );
  }

  if (opts.dryRun) {
    return dryRun(
      "transfer",
      {
        limit: opts.limit,
        overwrite: opts.overwrite,
        prefix: opts.prefix,
        // Validates the destination provider name without constructing it.
        to: describeProvider(destConfig),
      },
      opts
    );
  }

  const [source, dest] = await Promise.all([
    loadFiles(opts.global),
    loadFiles(destConfig),
  ]);

  const result = await transfer(source.files, dest.files, {
    ...(opts.prefix !== undefined && { prefix: opts.prefix }),
    ...(opts.overwrite === false && { overwrite: false }),
    ...(opts.limit !== undefined && { limit: opts.limit }),
    ...buildBulkOptions(opts),
    // transformKey can't be expressed as a flag; identity is the only mapping
    // reachable from the CLI. onProgress streams to stderr under --verbose so
    // it never pollutes the JSON result on stdout.
    ...(opts.verbose && {
      onProgress: ({ done, total, key, status }) =>
        process.stderr.write(`${done}/${total} ${status} ${key}\n`),
    }),
  });

  emit(result, opts);
  if (result.errors?.length) {
    // Set the exit code rather than exiting: process.exit() right after a
    // large emit() can truncate piped stdout mid-payload (POSIX pipe writes
    // are asynchronous). The process ends once stdout drains.
    process.exitCode = exitCode(result.errors[0]?.error.code ?? "Provider");
  }
};

export interface SyncCmdOpts extends CommonRunOpts {
  /** Destination provider config as JSON — a {@link GlobalCliOptions} blob. */
  to: string;
  prefix?: string;
  destPrefix?: string;
  /** Mirror mode — delete destination keys the source no longer has. */
  prune?: boolean;
  /** Change detection. The function form of `compare` isn't reachable from a flag. */
  compare?: "etag" | "size";
  limit?: number;
  concurrency?: number;
  stopOnError?: boolean;
}

export const runSync = async (opts: SyncCmdOpts): Promise<void> => {
  // Same shape as `transfer`: the source comes from the global flags, the
  // destination is a separate provider supplied as a JSON blob.
  const destConfig = parseJson<GlobalCliOptions>(opts.to, "--to");
  if (!destConfig || typeof destConfig !== "object") {
    throw new FilesError(
      "Provider",
      "--to must be a JSON object of destination provider options"
    );
  }

  // Unlike `transfer`, `--dry-run` here is *not* a no-network echo: a mirror
  // dry run lists both sides and returns the real reconciliation plan (what
  // would be uploaded / skipped / pruned) without mutating anything — that
  // preview is the whole point. So both providers load even under `--dry-run`.
  const [source, dest] = await Promise.all([
    loadFiles(opts.global),
    loadFiles(destConfig),
  ]);

  const result = await sync(source.files, dest.files, {
    ...(opts.prefix !== undefined && { prefix: opts.prefix }),
    ...(opts.destPrefix !== undefined && { destPrefix: opts.destPrefix }),
    ...(opts.prune && { prune: true }),
    ...(opts.compare !== undefined && { compare: opts.compare }),
    ...(opts.dryRun && { dryRun: true }),
    ...(opts.limit !== undefined && { limit: opts.limit }),
    ...buildBulkOptions(opts),
    // transformKey can't be expressed as a flag. onProgress streams to stderr
    // under --verbose so it never pollutes the JSON result on stdout.
    ...(opts.verbose && {
      onProgress: ({ done, total, key, status }) =>
        process.stderr.write(`${done}/${total} ${status} ${key}\n`),
    }),
  });

  emit(result, opts);
  if (result.errors?.length) {
    // Set the exit code rather than exiting: process.exit() right after a
    // large emit() can truncate piped stdout mid-payload (POSIX pipe writes
    // are asynchronous). The process ends once stdout drains.
    process.exitCode = exitCode(result.errors[0]?.error.code ?? "Provider");
  }
};
