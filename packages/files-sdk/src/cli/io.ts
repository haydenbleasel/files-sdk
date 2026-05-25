import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import type { Writable } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { Body, ByteRange, StoredFile } from "../index.js";
import { FilesError } from "../internal/errors.js";

export interface OutputOpts {
  json: boolean;
  pretty: boolean;
  verbose: boolean;
}

const humanize = (data: unknown): string => {
  if (typeof data === "string") {
    return data;
  }
  return JSON.stringify(data, null, 2);
};

export const exitCode = (code: string): number => {
  switch (code) {
    case "NotFound": {
      return 1;
    }
    case "Unauthorized": {
      return 3;
    }
    case "Conflict": {
      return 4;
    }
    default: {
      return 2;
    }
  }
};

export const emit = (data: unknown, out: OutputOpts): void => {
  if (out.json) {
    const text = out.pretty
      ? JSON.stringify(data, null, 2)
      : JSON.stringify(data);
    process.stdout.write(`${text}\n`);
    return;
  }
  process.stdout.write(`${humanize(data)}\n`);
};

export const fail = (err: unknown, out: OutputOpts): never => {
  const code = err instanceof FilesError ? err.code : "Provider";
  const message = err instanceof Error ? err.message : String(err);
  const payload: Record<string, unknown> = {
    error: { code, message },
  };
  if (out.verbose && err instanceof Error && err.stack) {
    (payload.error as Record<string, unknown>).stack = err.stack;
  }
  if (out.json) {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`error (${code}): ${message}\n`);
    if (out.verbose && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
  }
  process.exit(exitCode(code));
};

/**
 * Resolve a body source from CLI flags as a web ReadableStream — the adapter
 * decides whether to buffer or stream. Both stdin and file paths are
 * streamed; size is unknown for stdin and reported as `-1`.
 */
export const readBody = async (source: {
  file?: string;
  stdin?: boolean;
}): Promise<{ body: Body; size: number; hint: string }> => {
  if (source.stdin) {
    const webStream = Readable.toWeb(
      process.stdin
    ) as unknown as ReadableStream<Uint8Array>;
    return { body: webStream, hint: "<stdin>", size: -1 };
  }
  if (!source.file) {
    throw new FilesError("Provider", "expected --file <path> or --stdin");
  }
  const stats = await stat(source.file);
  const readable = createReadStream(source.file);
  const webStream = Readable.toWeb(
    readable
  ) as unknown as ReadableStream<Uint8Array>;
  return { body: webStream, hint: source.file, size: stats.size };
};

/**
 * Write a downloaded body to a destination file or stdout. When piping to
 * stdout, no JSON envelope is emitted on stdout — agents calling
 * `download --stdout` want the bytes, not a wrapper.
 */
export const writeBody = async (
  file: StoredFile,
  dest: { out?: string; stdout?: boolean }
): Promise<void> => {
  if (dest.stdout) {
    const webStream = file.stream();
    const nodeStream = Readable.fromWeb(
      webStream as unknown as NodeReadableStream<Uint8Array>
    );
    await pipeline(nodeStream, process.stdout as unknown as Writable);
    return;
  }
  if (!dest.out) {
    throw new FilesError("Provider", "expected --out <path> or --stdout");
  }
  const webStream = file.stream();
  const nodeStream = Readable.fromWeb(
    webStream as unknown as NodeReadableStream<Uint8Array>
  );
  await pipeline(nodeStream, createWriteStream(dest.out));
};

/**
 * A web `ReadableStream` over a local file that opens the descriptor lazily —
 * only on the first read, never at construction. The bulk-upload path builds
 * one of these per file and hands them all to `files.upload(items)`; deferring
 * the open (via a zero high-water-mark, so nothing is pre-buffered) keeps the
 * number of simultaneously-open descriptors bounded by the SDK's upload
 * concurrency rather than by the file count — a directory of thousands of
 * files won't exhaust the process's fd limit.
 */
export const fileBodyStream = (absPath: string): ReadableStream<Uint8Array> => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async cancel(reason) {
        await reader?.cancel(reason);
      },
      async pull(controller) {
        if (!reader) {
          reader = (
            Readable.toWeb(
              createReadStream(absPath)
            ) as unknown as ReadableStream<Uint8Array>
          ).getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      },
    },
    new CountQueuingStrategy({ highWaterMark: 0 })
  );
};

export interface WalkedFile {
  absPath: string;
  /** Path relative to the walk root, always with `/` separators (an object key). */
  key: string;
}

/**
 * Recursively list every regular file under `root`, returning each file's
 * absolute path and its `/`-separated key relative to `root`. Directories are
 * descended; symlinks and other special entries are skipped. The result is
 * sorted by key so a directory upload produces deterministic output.
 */
export const walkDir = async (root: string): Promise<WalkedFile[]> => {
  const out: WalkedFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, key);
      } else if (entry.isFile()) {
        out.push({ absPath: abs, key });
      }
    }
  };
  await walk(root, "");
  out.sort((a, b) => (a.key < b.key ? -1 : 1));
  return out;
};

/**
 * Write a downloaded {@link StoredFile} into `dir`, at the path its key
 * implies (`dir/<key>`), creating intermediate directories. Refuses keys that
 * would escape `dir` (`../`, absolute) so a hostile or malformed key can't
 * write outside the chosen output directory. Returns the path written.
 */
export const writeBodyToDir = async (
  file: StoredFile,
  dir: string
): Promise<string> => {
  const root = path.resolve(dir);
  const dest = path.resolve(root, file.key);
  if (dest !== root && !dest.startsWith(root + path.sep)) {
    throw new FilesError(
      "Provider",
      `refusing to write key outside --out-dir: ${file.key}`
    );
  }
  await mkdir(path.dirname(dest), { recursive: true });
  const nodeStream = Readable.fromWeb(
    file.stream() as unknown as NodeReadableStream<Uint8Array>
  );
  await pipeline(nodeStream, createWriteStream(dest));
  return dest;
};

export const parseKeyValuePairs = (
  pairs?: readonly string[]
): Record<string, string> | undefined => {
  if (!pairs || pairs.length === 0) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const idx = p.indexOf("=");
    if (idx === -1) {
      throw new FilesError(
        "Provider",
        `--metadata expects key=value, got: ${p}`
      );
    }
    out[p.slice(0, idx)] = p.slice(idx + 1);
  }
  return out;
};

/**
 * Parse a `--range` flag into a {@link ByteRange}. Mirrors the HTTP `Range`
 * header's `start-end` form (both bounds 0-based and inclusive):
 *
 * - `"0-99"` → `{ start: 0, end: 99 }` (first 100 bytes)
 * - `"100-"` → `{ start: 100 }` (byte 100 to EOF)
 *
 * Only the numeric `start-end` / `start-` shapes are accepted — suffix ranges
 * (`-500`) have no {@link ByteRange} representation. The SDK does the final
 * `start`/`end` validation, so this just rejects unparseable input loudly.
 */
export const parseRange = (raw?: string): ByteRange | undefined => {
  if (!raw) {
    return undefined;
  }
  const match = /^(\d+)-(\d*)$/u.exec(raw);
  if (!match) {
    throw new FilesError(
      "Provider",
      `--range expects start-end or start- (bytes, 0-based, inclusive), got: ${raw}`
    );
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? undefined : Number(match[2]);
  return end === undefined ? { start } : { end, start };
};

export const parseJson = <T = unknown>(raw?: string): T | undefined => {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new FilesError(
      "Provider",
      `invalid JSON in --config-json: ${(error as Error).message}`
    );
  }
};

export const storedFileToJson = (f: StoredFile): Record<string, unknown> => ({
  etag: f.etag,
  key: f.key,
  lastModified: f.lastModified,
  metadata: f.metadata,
  name: f.name,
  size: f.size,
  type: f.type,
});
