import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Writable } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import type { Body, StoredFile } from "../index.js";
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

const exitCode = (code: string): number => {
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
