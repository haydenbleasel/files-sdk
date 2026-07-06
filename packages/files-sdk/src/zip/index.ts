/* oxlint-disable no-bitwise -- the ZIP format is bit-packed: record flags, MS-DOS timestamps, and CRC-32 are all defined in terms of bit operations. */
import type { Files, FilesPlugin, UploadResult } from "../index.js";
import { FilesError } from "../internal/errors.js";
import { inferTypeFromName } from "../internal/mime.js";

/**
 * Which objects to put in an archive: an explicit array of keys, or every key
 * under a `prefix` (resolved with `listAll`, so it spans pages). An omitted
 * `prefix` selects the whole bucket.
 */
export type ZipSelection = readonly string[] | { prefix?: string };

/**
 * How entry bodies are stored in the archive. `"deflate"` (the default)
 * compresses each entry with the platform {@link CompressionStream};
 * `"store"` writes the bytes verbatim — the right choice when the sources are
 * already compressed (JPEG, video, encrypted blobs), where deflate only burns
 * CPU.
 */
export type ZipMethod = "deflate" | "store";

export interface ZipOptions {
  /** How to store entry bodies. Defaults to `"deflate"`. See {@link ZipMethod}. */
  method?: ZipMethod;
  /**
   * Derive an entry's path inside the archive from its key. Defaults to the
   * key itself, so the archive mirrors the bucket layout. Use it to strip a
   * prefix (`(key) => key.slice("exports/".length)`) or to flatten folders.
   * Two keys mapping to the same name throw rather than silently producing an
   * ambiguous archive.
   */
  name?: (key: string) => string;
}

export interface UnzipOptions {
  /**
   * Key prefix the extracted entries are uploaded under (a trailing `/` is
   * added when missing). Defaults to `""` — entry paths become keys verbatim.
   */
  into?: string;
  /**
   * Keep only the entries this returns `true` for. Receives the entry's path
   * as recorded in the archive (before `into` is prepended).
   */
  filter?: (name: string) => boolean;
  maxEntries?: number;
  maxEntrySize?: number;
  maxTotalSize?: number;
}

/**
 * The methods {@link zip} grafts onto a {@link Files} instance. A `type`
 * rather than an `interface` so it satisfies the `Record<string, unknown>`
 * constraint on {@link FilesPlugin}'s extension parameter — an interface has no
 * implicit index signature and wouldn't be assignable.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- must be a type alias for the Record<string, unknown> constraint above.
export type ZipApi = {
  /**
   * Stream many stored objects as one ZIP archive. Entries are downloaded and
   * written one at a time as the consumer reads, so memory stays flat no
   * matter how many keys are selected — pipe it straight into a `Response`.
   * Selection and download failures surface as errors on the stream;
   * cancelling it stops the remaining work.
   */
  zip: (
    selection: ZipSelection,
    options?: ZipOptions
  ) => ReadableStream<Uint8Array>;
  /** Build the same archive and store it back at `key` (`application/zip`). */
  zipTo: (
    key: string,
    selection: ZipSelection,
    options?: ZipOptions
  ) => Promise<UploadResult>;
  /**
   * Extract a stored ZIP archive into individual objects: each file entry is
   * uploaded under {@link UnzipOptions.into} + its archive path, with a
   * content type inferred from its extension. Directory entries are skipped.
   * Returns one {@link UploadResult} per extracted entry, in archive order.
   */
  unzip: (key: string, options?: UnzipOptions) => Promise<UploadResult[]>;
};

/** ZIP record signatures (little-endian on the wire). */
const SIG_LOCAL = 0x04_03_4b_50;
const SIG_DESCRIPTOR = 0x08_07_4b_50;
const SIG_CENTRAL = 0x02_01_4b_50;
const SIG_EOCD = 0x06_05_4b_50;

/** Fixed record sizes, before the variable-length name/extra/comment fields. */
const LOCAL_HEADER_SIZE = 30;
const DESCRIPTOR_SIZE = 16;
const CENTRAL_RECORD_SIZE = 46;
const EOCD_SIZE = 22;

/**
 * General-purpose flags we write: bit 3 (sizes/CRC follow the data in a
 * descriptor, which is what lets us stream without knowing them up front) and
 * bit 11 (entry names are UTF-8).
 */
const FLAG_DESCRIPTOR = 0x00_08;
const FLAG_UTF8 = 0x08_00;
/** Bit 0 on a read entry means it's encrypted — we fail closed on those. */
const FLAG_ENCRYPTED = 0x00_01;

/** "Version needed to extract" 2.0 — plain deflate, no ZIP64 features. */
const ZIP_VERSION = 20;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/**
 * The classic format's hard limits. Crossing any of them requires ZIP64
 * records, which this plugin deliberately doesn't write or read — see the
 * {@link zip} docs.
 */
const MAX_UINT16 = 0xff_ff;
const MAX_UINT32 = 0xff_ff_ff_ff;
const DEFAULT_UNZIP_MAX_ENTRIES = 10_000;
const DEFAULT_UNZIP_MAX_ENTRY_SIZE = 512 * 1024 * 1024;
const DEFAULT_UNZIP_MAX_TOTAL_SIZE = 1024 * 1024 * 1024;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/**
 * Throw when a size or offset no longer fits the classic 32-bit fields.
 * `>=`, not `>`: `0xFFFFFFFF` itself is the ZIP64 sentinel value, which this
 * plugin's own reader (and any ZIP64-aware tool) treats as "the real value
 * lives in a ZIP64 extra field" — writing it verbatim would produce an
 * archive that can't be read back.
 */
const assertFits = (value: number, what: string): void => {
  if (value >= MAX_UINT32) {
    throw new FilesError(
      "Provider",
      `zip: ${what} exceeds 4 GiB, which needs ZIP64 — unsupported by this plugin`
    );
  }
};

/** The standard CRC-32 (IEEE 802.3) lookup table. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xed_b8_83_20 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc;
  }
  return table;
})();

/** Fold `bytes` into a running CRC-32. Seed with `0xffffffff`. */
const crcUpdate = (crc: number, bytes: Uint8Array): number => {
  let next = crc;
  for (const byte of bytes) {
    next = (CRC_TABLE[(next ^ byte) & 0xff] as number) ^ (next >>> 8);
  }
  return next;
};

/** Finish a running CRC-32 into the value ZIP records store. */
// oxlint-disable-next-line unicorn/prefer-math-trunc -- `>>> 0` reinterprets the signed 32-bit CRC as the unsigned value ZIP stores; Math.trunc would keep it negative.
const crcFinish = (crc: number): number => (crc ^ MAX_UINT32) >>> 0;

/** ZIP timestamps start at 1980; anything earlier (or missing) clamps to it. */
const DOS_EPOCH = Date.UTC(1980, 0, 1);
const DOS_YEAR_BITS = 0x7f;

/** Pack an epoch-ms timestamp into MS-DOS date/time fields (2-second steps, UTC). */
const dosDateTime = (
  epochMs: number | undefined
): [date: number, time: number] => {
  const at = new Date(Math.max(epochMs ?? DOS_EPOCH, DOS_EPOCH));
  const date =
    (Math.min(at.getUTCFullYear() - 1980, DOS_YEAR_BITS) << 9) |
    ((at.getUTCMonth() + 1) << 5) |
    at.getUTCDate();
  const time =
    (at.getUTCHours() << 11) |
    (at.getUTCMinutes() << 5) |
    Math.floor(at.getUTCSeconds() / 2);
  return [date, time];
};

/**
 * Reject entry paths that wouldn't round-trip as sane object keys — empty
 * names, absolute paths, backslashes, `.` / `..` segments (the classic
 * zip-slip escape, which on extraction would climb out of the `into` prefix),
 * and names too long for the format's 16-bit length field. Used on both
 * sides: writing fails before producing a hostile archive, extraction fails
 * before acting on one.
 */
const assertSafeEntryName = (name: string, byteLength: number): void => {
  const reject = (why: string): never => {
    throw new FilesError("Provider", `zip: entry name "${name}" ${why}`);
  };
  if (byteLength > MAX_UINT16) {
    reject("is longer than the ZIP format's 65535-byte limit");
  }
  if (name.includes("\\")) {
    reject("contains a backslash — use forward slashes");
  }
  for (const segment of name.split("/")) {
    if (segment === "") {
      reject("has an empty path segment (leading, trailing, or double slash)");
    }
    if (segment === "." || segment === "..") {
      reject('has a "." or ".." path segment');
    }
  }
};

/** Allocate a record buffer plus a little-endian view over it. */
const record = (size: number): [Uint8Array, DataView] => {
  const bytes = new Uint8Array(size);
  return [bytes, new DataView(bytes.buffer)];
};

const localHeader = (
  name: Uint8Array,
  method: number,
  date: number,
  time: number
): Uint8Array => {
  const [bytes, view] = record(LOCAL_HEADER_SIZE + name.byteLength);
  view.setUint32(0, SIG_LOCAL, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, FLAG_DESCRIPTOR | FLAG_UTF8, true);
  view.setUint16(8, method, true);
  view.setUint16(10, time, true);
  view.setUint16(12, date, true);
  // CRC and sizes (offsets 14/18/22) stay 0 — the data descriptor carries them.
  view.setUint16(26, name.byteLength, true);
  bytes.set(name, LOCAL_HEADER_SIZE);
  return bytes;
};

const dataDescriptor = (
  crc: number,
  compressedSize: number,
  size: number
): Uint8Array => {
  const [bytes, view] = record(DESCRIPTOR_SIZE);
  view.setUint32(0, SIG_DESCRIPTOR, true);
  view.setUint32(4, crc, true);
  view.setUint32(8, compressedSize, true);
  view.setUint32(12, size, true);
  return bytes;
};

/** Everything the central directory needs to describe one written entry. */
interface CentralEntry {
  name: Uint8Array;
  method: number;
  date: number;
  time: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const centralRecord = (entry: CentralEntry): Uint8Array => {
  const [bytes, view] = record(CENTRAL_RECORD_SIZE + entry.name.byteLength);
  view.setUint32(0, SIG_CENTRAL, true);
  view.setUint16(4, ZIP_VERSION, true);
  view.setUint16(6, ZIP_VERSION, true);
  view.setUint16(8, FLAG_DESCRIPTOR | FLAG_UTF8, true);
  view.setUint16(10, entry.method, true);
  view.setUint16(12, entry.time, true);
  view.setUint16(14, entry.date, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.compressedSize, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.name.byteLength, true);
  // Extra/comment lengths, disk number, and file attributes (30–45) stay 0.
  view.setUint32(42, entry.offset, true);
  bytes.set(entry.name, CENTRAL_RECORD_SIZE);
  return bytes;
};

const endOfCentralDirectory = (
  count: number,
  size: number,
  offset: number
): Uint8Array => {
  const [bytes, view] = record(EOCD_SIZE);
  view.setUint32(0, SIG_EOCD, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return bytes;
};

interface ResolvedEntry {
  key: string;
  name: Uint8Array;
}

/**
 * Turn a {@link ZipSelection} into the ordered, validated entry list — keys
 * paired with their encoded archive paths, duplicates and unsafe names
 * rejected, count checked against the format's 16-bit entry limit.
 */
const resolveEntries = async (
  files: Files,
  selection: ZipSelection,
  nameOf: (key: string) => string
): Promise<ResolvedEntry[]> => {
  const keys: string[] = [];
  if (Array.isArray(selection)) {
    keys.push(...(selection as readonly string[]));
  } else {
    for await (const file of files.listAll({
      prefix: (selection as { prefix?: string }).prefix,
    })) {
      keys.push(file.key);
    }
  }
  // `>=`, not `>`: an entry count of exactly 0xFFFF is the ZIP64 sentinel,
  // which readers (including this plugin's own unzip) treat as "the real
  // count lives in a ZIP64 record".
  if (keys.length >= MAX_UINT16) {
    throw new FilesError(
      "Provider",
      `zip: ${keys.length} entries reach the ZIP format's limit of 65535 — ZIP64 is unsupported by this plugin`
    );
  }
  const seen = new Set<string>();
  return keys.map((key) => {
    const name = nameOf(key);
    const encoded = ENCODER.encode(name);
    assertSafeEntryName(name, encoded.byteLength);
    if (seen.has(name)) {
      throw new FilesError(
        "Provider",
        `zip: two keys map to the same entry name "${name}" — disambiguate via the name option`
      );
    }
    seen.add(name);
    return { key, name: encoded };
  });
};

/**
 * The archive itself, one chunk at a time: for each entry a local header, the
 * (optionally deflated) body, and a data descriptor with the CRC/sizes
 * counted as the bytes flowed — then the central directory and the end
 * record. Entries are downloaded lazily, so an unconsumed or cancelled stream
 * does no further work.
 *
 * @yields {Uint8Array} the archive's bytes, record by record.
 */
const zipChunks = async function* zipChunks(
  files: Files,
  selection: ZipSelection,
  options: ZipOptions
): AsyncGenerator<Uint8Array, void> {
  const entries = await resolveEntries(
    files,
    selection,
    options.name ?? ((key) => key)
  );
  const method = options.method === "store" ? METHOD_STORE : METHOD_DEFLATE;
  const central: CentralEntry[] = [];
  let offset = 0;
  for (const entry of entries) {
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- archive is streamed record by record with a running offset.
    const file = await files.download(entry.key);
    // Fail before streaming gigabytes that can't be represented anyway.
    assertFits(file.size, `entry "${entry.key}"`);
    const [date, time] = dosDateTime(file.lastModified);
    const header = localHeader(entry.name, method, date, time);
    yield header;

    let crc = MAX_UINT32;
    let size = 0;
    let compressedSize = 0;
    const counted = file.stream().pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          crc = crcUpdate(crc, chunk);
          size += chunk.byteLength;
          controller.enqueue(chunk);
        },
      })
    );
    const body =
      method === METHOD_DEFLATE
        ? counted.pipeThrough(
            // CompressionStream's writable is typed to take any BufferSource,
            // which pipeThrough's invariant pair type rejects; at runtime it
            // consumes our Uint8Array chunks just fine.
            new CompressionStream(
              "deflate-raw"
            ) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
          )
        : counted;
    const reader = body.getReader();
    let drained = false;
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- single body reader; compressed chunks arrive sequentially.
        const { done, value } = await reader.read();
        if (done) {
          drained = true;
          break;
        }
        compressedSize += value.byteLength;
        assertFits(compressedSize, `entry "${entry.key}" (compressed)`);
        yield value;
      }
    } finally {
      // An early consumer cancel lands here mid-body; release the source so
      // the underlying download stops too.
      if (!drained) {
        // eslint-disable-next-line no-await-in-loop -- release this entry's source before advancing the archive.
        await reader.cancel();
      }
    }
    assertFits(size, `entry "${entry.key}"`);
    const finished = crcFinish(crc);
    yield dataDescriptor(finished, compressedSize, size);
    central.push({
      compressedSize,
      crc: finished,
      date,
      method,
      name: entry.name,
      offset,
      size,
      time,
    });
    offset += header.byteLength + compressedSize + DESCRIPTOR_SIZE;
  }
  assertFits(offset, "the archive");
  let directorySize = 0;
  for (const entry of central) {
    const bytes = centralRecord(entry);
    directorySize += bytes.byteLength;
    yield bytes;
  }
  yield endOfCentralDirectory(central.length, directorySize, offset);
};

/** Expose the chunk generator as a cancellable byte stream. */
const streamFrom = (
  chunks: AsyncGenerator<Uint8Array, void>
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    async cancel() {
      await chunks.return();
    },
    async pull(controller) {
      const { done, value } = await chunks.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
  });

/** What the central directory says about one entry of an archive being read. */
interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const corrupt = (key: string, why: string, cause?: unknown): FilesError =>
  new FilesError(
    "Provider",
    `zip: "${key}" is not a valid ZIP archive (${why})`,
    cause
  );

const zip64Unsupported = (key: string): FilesError =>
  new FilesError(
    "Provider",
    `zip: "${key}" is a ZIP64 archive, which is unsupported by this plugin`
  );

/**
 * Read an archive's central directory — the authoritative entry index every
 * mainstream ZIP tool reads, which also makes data descriptors and trailing
 * garbage irrelevant. Fails closed on ZIP64 markers, encrypted entries, and
 * structural corruption.
 */
const parseCentralDirectory = (
  bytes: Uint8Array,
  key: string
): ParsedEntry[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record sits at the very tail, behind an up-to-64KiB comment; scan
  // backwards for its signature.
  let eocd = -1;
  const floor = Math.max(0, bytes.byteLength - EOCD_SIZE - MAX_UINT16);
  for (let i = bytes.byteLength - EOCD_SIZE; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw corrupt(key, "no end-of-central-directory record");
  }
  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count === MAX_UINT16 || directoryOffset === MAX_UINT32) {
    throw zip64Unsupported(key);
  }
  const entries: ParsedEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (
      at + CENTRAL_RECORD_SIZE > eocd ||
      view.getUint32(at, true) !== SIG_CENTRAL
    ) {
      throw corrupt(key, "truncated central directory");
    }
    const flags = view.getUint16(at + 8, true);
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new FilesError(
        "Provider",
        `zip: "${key}" contains encrypted entries, which are unsupported`
      );
    }
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    if (compressedSize === MAX_UINT32 || size === MAX_UINT32) {
      throw zip64Unsupported(key);
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    entries.push({
      compressedSize,
      crc: view.getUint32(at + 16, true),
      localOffset: view.getUint32(at + 42, true),
      method: view.getUint16(at + 10, true),
      name: DECODER.decode(
        bytes.subarray(
          at + CENTRAL_RECORD_SIZE,
          at + CENTRAL_RECORD_SIZE + nameLength
        )
      ),
      size,
    });
    at += CENTRAL_RECORD_SIZE + nameLength + extraLength + commentLength;
  }
  return entries;
};

const collectLimited = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  key: string,
  name: string
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- single stream reader; chunks arrive sequentially.
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        // eslint-disable-next-line no-await-in-loop -- cancel the source once the size limit is exceeded.
        await reader.cancel();
        throw new FilesError(
          "Provider",
          `zip: entry "${name}" in "${key}" exceeds the configured unzip size limit`
        );
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};

/** Inflate a raw-deflate buffer via the platform {@link DecompressionStream}. */
const inflate = async (
  data: Uint8Array,
  maxBytes: number,
  key: string,
  name: string
): Promise<Uint8Array> => {
  const transform = new DecompressionStream("deflate-raw");
  const collected = collectLimited(transform.readable, maxBytes, key, name);
  const writer = transform.writable.getWriter();
  // Feed and drain concurrently (backpressure can deadlock otherwise), and
  // join via Promise.all so a corrupt-input failure on either side never
  // becomes an unhandled rejection.
  const pump = (async () => {
    await writer.write(data as Uint8Array<ArrayBuffer>);
    await writer.close();
  })();
  const [result] = await Promise.all([collected, pump]);
  return result;
};

/** Locate and decode one entry's bytes, then verify them against the index. */
const extractEntry = async (
  bytes: Uint8Array,
  entry: ParsedEntry,
  key: string,
  maxEntrySize: number
): Promise<Uint8Array> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The central record points at the local header, whose own variable-length
  // fields (which may differ from the central copy) position the data.
  const local = entry.localOffset;
  if (
    local + LOCAL_HEADER_SIZE > bytes.byteLength ||
    view.getUint32(local, true) !== SIG_LOCAL
  ) {
    throw corrupt(key, `bad local header for "${entry.name}"`);
  }
  const start =
    local +
    LOCAL_HEADER_SIZE +
    view.getUint16(local + 26, true) +
    view.getUint16(local + 28, true);
  if (start + entry.compressedSize > bytes.byteLength) {
    throw corrupt(key, `truncated data for "${entry.name}"`);
  }
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.size > maxEntrySize) {
    throw new FilesError(
      "Provider",
      `zip: entry "${entry.name}" in "${key}" exceeds the configured unzip size limit`
    );
  }
  let out: Uint8Array;
  if (entry.method === METHOD_STORE) {
    out = data;
  } else if (entry.method === METHOD_DEFLATE) {
    try {
      out = await inflate(data, entry.size, key, entry.name);
    } catch (error) {
      if (error instanceof FilesError) {
        throw error;
      }
      throw corrupt(key, `entry "${entry.name}" failed to inflate`, error);
    }
  } else {
    throw new FilesError(
      "Provider",
      `zip: entry "${entry.name}" in "${key}" uses unsupported compression method ${entry.method}`
    );
  }
  if (
    out.byteLength !== entry.size ||
    crcFinish(crcUpdate(MAX_UINT32, out)) !== entry.crc
  ) {
    throw corrupt(key, `entry "${entry.name}" failed its CRC/size check`);
  }
  return out;
};

/**
 * Bundle stored objects into ZIP archives — and back out of them — entirely
 * through the instance. An `extend`-only (Tier C) plugin: it intercepts
 * nothing, it adds three methods. `files.zip(selection)` streams many keys as
 * one standard ZIP (deflate via the platform {@link CompressionStream}, no
 * native deps); `files.zipTo(key, selection)` stores that archive back as an
 * object; `files.unzip(key)` extracts an archive's entries into individual
 * objects.
 *
 * Everything goes through the fully-wrapped instance, so it composes with the
 * rest of the pipeline: with `encryption()` installed, zipped entries are
 * read as plaintext and an archive stored via `zipTo` is encrypted at rest.
 * Array position therefore doesn't matter — there's no `wrap` to order.
 *
 * Trade-offs, by design:
 * - **No ZIP64.** Archives are classic ZIP: at most 65535 entries and 4 GiB
 *   per entry / per archive, failing closed (never silently corrupting) when
 *   a limit is crossed. Reading a ZIP64 archive throws too.
 * - **`zip()` streams; `unzip()` buffers.** Writing needs only one entry in
 *   flight at a time, so archives of many objects stream with flat memory.
 *   Reading needs the central directory at the end of the file, so `unzip`
 *   downloads the whole archive into memory first.
 * - **Entry names are validated on both sides.** Writing rejects duplicate
 *   names, `..` segments, backslashes, and absolute paths; extraction rejects
 *   the same (zip-slip), and refuses encrypted entries and unknown
 *   compression methods rather than guessing.
 * - **`store` is for already-compressed sources.** The default `deflate`
 *   shrinks text well, but JPEGs, videos, and `encryption()`-at-rest objects
 *   read back as high-entropy bytes — pass `method: "store"` to skip the
 *   wasted CPU.
 *
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { zip } from "files-sdk/zip";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [zip()],
 * });
 *
 * // Stream a folder as a download:
 * return new Response(files.zip({ prefix: "reports/2026/" }), {
 *   headers: { "Content-Disposition": 'attachment; filename="reports.zip"' },
 * });
 *
 * // Or store an archive, and unpack one:
 * await files.zipTo("exports/all.zip", ["a.csv", "b.csv"]);
 * await files.unzip("incoming/batch.zip", { into: "imported/" });
 * ```
 */
export const zip = (): FilesPlugin<ZipApi> => ({
  extend: (files) => {
    const create = (
      selection: ZipSelection,
      options: ZipOptions = {}
    ): ReadableStream<Uint8Array> =>
      streamFrom(zipChunks(files, selection, options));
    return {
      unzip: async (key, options = {}) => {
        const file = await files.download(key);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const maxEntries = options.maxEntries ?? DEFAULT_UNZIP_MAX_ENTRIES;
        const maxEntrySize =
          options.maxEntrySize ?? DEFAULT_UNZIP_MAX_ENTRY_SIZE;
        const maxTotalSize =
          options.maxTotalSize ?? DEFAULT_UNZIP_MAX_TOTAL_SIZE;
        let into = options.into ?? "";
        if (into !== "" && !into.endsWith("/")) {
          into += "/";
        }
        const entries = parseCentralDirectory(bytes, key);
        if (entries.length > maxEntries) {
          throw new FilesError(
            "Provider",
            `zip: "${key}" has ${entries.length} entries, exceeding the configured unzip entry limit`
          );
        }
        const results: UploadResult[] = [];
        let totalSize = 0;
        // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- the guard-continues (skip dir entries, skip filtered names) are the clearest form of this extract loop.
        for (const entry of entries) {
          // A trailing slash marks a directory entry — nothing to store.
          if (entry.name.endsWith("/")) {
            continue;
          }
          if (options.filter && !options.filter(entry.name)) {
            continue;
          }
          assertSafeEntryName(
            entry.name,
            ENCODER.encode(entry.name).byteLength
          );
          totalSize += entry.size;
          if (totalSize > maxTotalSize) {
            throw new FilesError(
              "Provider",
              `zip: "${key}" exceeds the configured unzip total size limit`
            );
          }
          // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- decompress entries one at a time to bound memory; running total-size guard is order-sensitive.
          const data = await extractEntry(bytes, entry, key, maxEntrySize);
          results.push(
            // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- upload each extracted entry in order after its size is accounted.
            await files.upload(into + entry.name, data, {
              contentType: inferTypeFromName(entry.name),
            })
          );
        }
        return results;
      },
      zip: create,
      zipTo: (key, selection, options) =>
        files.upload(key, create(selection, options), {
          contentType: "application/zip",
        }),
    };
  },
  name: "zip",
});
